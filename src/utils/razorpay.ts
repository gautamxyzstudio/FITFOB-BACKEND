import Razorpay from "razorpay";
import crypto from "node:crypto";

const GYM_MEMBERSHIP_UID =
  "api::gym-membership.gym-membership";
const GYM_PROMOTION_UID =
  "api::gym-promotion.gym-promotion";
const COMMISSION_UID =
  "api::commission-transaction.commission-transaction";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

type CreateMembershipOrderParams = {
  clientDocumentId: string;
  contractDocumentId: string;
  planPriceDocumentId: string;
  idempotencyKey: string;
  duration: string;
  durationMonths: number;
  customerPrice: number;
  defaultCommission: number;
  commissionMode: "default" | "custom";
  customCommission?: number;
  currency: string;
};

const toPaise = (amount: number) =>
  Math.round(Number(amount) * 100);

const fromPaise = (amount: number) =>
  Number((amount / 100).toFixed(2));

function getMembershipEndDate(startDate: Date, durationMonths: number) {
  const endDate = new Date(startDate);
  endDate.setMonth(endDate.getMonth() + durationMonths);
  return endDate;
}

async function findOneDocument(
  uid: string,
  filters: Record<string, unknown>,
  populate?: Record<string, unknown>
) {
  const records = await (strapi.documents(uid as any) as any).findMany({
    filters,
    ...(populate ? { populate } : {}),
    limit: 1,
  });

  return records?.[0] ?? null;
}

export async function createMembershipOrder(
  params: CreateMembershipOrderParams
) {
  const {
    clientDocumentId,
    contractDocumentId,
    planPriceDocumentId,
    idempotencyKey,
    duration,
    durationMonths,
    customerPrice,
    defaultCommission,
    commissionMode,
    customCommission,
    currency,
  } = params;

  if (!idempotencyKey?.trim() || idempotencyKey.length > 128) {
    throw new Error("A valid idempotency key is required.");
  }

  if (currency !== "INR") {
    throw new Error("Only INR payments are currently supported.");
  }

  if (!Number.isFinite(customerPrice) || customerPrice <= 0) {
    throw new Error("Invalid membership price.");
  }

  if (!Number.isFinite(defaultCommission) || defaultCommission < 0) {
    throw new Error("Invalid default commission.");
  }

  if (!Number.isInteger(durationMonths) || durationMonths < 1) {
    throw new Error("Invalid membership duration.");
  }

  if (commissionMode !== "default" && commissionMode !== "custom") {
    throw new Error("Invalid commission mode.");
  }

  const customerPricePaise = toPaise(customerPrice);
  const commissionPaise =
    commissionMode === "custom"
      ? toPaise(customCommission ?? -1)
      : toPaise(defaultCommission);

  if (
    commissionPaise < 0 ||
    commissionPaise > customerPricePaise
  ) {
    throw new Error("Commission must be between zero and membership price.");
  }

  const scopeLock = [
    clientDocumentId,
    contractDocumentId,
    planPriceDocumentId,
  ].join(":");

  return strapi.db.transaction(async ({ trx }) => {
    // Prevent simultaneous requests creating multiple orders for this purchase scope.
    await trx.raw(
      "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))",
      [`fitfob-membership:${scopeLock}`]
    );

    // Idempotent retry: return the order already created for this key.
    const sameKeyMembership = await findOneDocument(
      GYM_MEMBERSHIP_UID,
      {
        paymentIdempotencyKey: idempotencyKey,
        client_detail: { documentId: clientDocumentId },
      }
    );

    if (sameKeyMembership) {
      if (sameKeyMembership.providerOrderId) {
        return {
          reused: true,
          membershipDocumentId: sameKeyMembership.documentId,
          razorpayOrderId: sameKeyMembership.providerOrderId,
          keyId: process.env.RAZORPAY_KEY_ID,
          amount: toPaise(Number(sameKeyMembership.customerPriceSnapshot)),
          currency: sameKeyMembership.currency,
          paymentStatus: sameKeyMembership.paymentStatus,
          membershipStatus: sameKeyMembership.membershipStatus,
        };
      }

      throw new Error(
        "This checkout is already being processed. Please retry shortly."
      );
    }

    const activeMembership = await findOneDocument(
      GYM_MEMBERSHIP_UID,
      {
        client_detail: { documentId: clientDocumentId },
        gym_contract: { documentId: contractDocumentId },
        membership_plan_price: { documentId: planPriceDocumentId },
        membershipStatus: "active",
        paymentStatus: "paid",
      }
    );

    if (activeMembership) {
      throw new Error(
        "You already have an active membership for this plan."
      );
    }

    const pendingMembership = await findOneDocument(
      GYM_MEMBERSHIP_UID,
      {
        client_detail: { documentId: clientDocumentId },
        gym_contract: { documentId: contractDocumentId },
        membership_plan_price: { documentId: planPriceDocumentId },
        membershipStatus: "pending",
        paymentStatus: "pending",
      }
    );

    if (pendingMembership) {
      // Never create a second order while the first order may still be paid.
      // Reuse the same key above; a different key receives a conflict.
      throw new Error(
        "You already have a pending payment for this plan. Continue with the existing payment."
      );
    }

    // Reserve an eligible zero-commission promotion atomically.
    const promotions = await (strapi.documents(GYM_PROMOTION_UID) as any)
      .findMany({
        filters: {
          gym_contract: { documentId: contractDocumentId },
          promotionType: "zero_commission",
          isActive: true,
        },
        sort: { createdAt: "asc" },
      });

    const now = new Date();
    let selectedPromotion: any = null;

    for (const promotion of promotions) {
      if (promotion.startDate && new Date(promotion.startDate) > now) {
        continue;
      }
      if (promotion.endDate && new Date(promotion.endDate) < now) {
        continue;
      }

      const reserved = await trx("gym_promotions")
        .where({ id: promotion.id, is_active: true })
        .whereRaw(
          "COALESCE(used_user_count, 0) + COALESCE(reserved_user_count, 0) < COALESCE(user_limit, 0)"
        )
        .update({
          reserved_user_count: trx.raw(
            "COALESCE(reserved_user_count, 0) + 1"
          ),
          updated_at: new Date(),
        });

      if (reserved) {
        selectedPromotion = promotion;
        break;
      }
    }

    const finalCommissionPaise = selectedPromotion ? 0 : commissionPaise;
    const finalCommissionMode = selectedPromotion
      ? "promotion"
      : commissionMode;
    const gymPayoutPaise =
      customerPricePaise - finalCommissionPaise;

    // Razorpay order creation occurs while the purchase-scope lock is held.
    const internalReference = crypto.randomUUID();
    const order = await razorpay.orders.create({
      amount: customerPricePaise,
      currency,
      receipt: `fitfob_${internalReference}`.slice(0, 40),
      notes: {
        internalReference,
        clientDocumentId,
        contractDocumentId,
        planPriceDocumentId,
        promotionDocumentId: selectedPromotion?.documentId || "",
        promotionId: selectedPromotion?.id ? String(selectedPromotion.id) : "",
        commissionMode: finalCommissionMode,
        commissionPaise: String(finalCommissionPaise),
        gymPayoutPaise: String(gymPayoutPaise),
      },
    });

   const membership = await (strapi.documents(GYM_MEMBERSHIP_UID) as any)
  .create({
    data: {
      client_detail: {
        connect: [{ documentId: clientDocumentId }],
      },
      gym_contract: {
        connect: [{ documentId: contractDocumentId }],
      },
      membership_plan_price: {
        connect: [{ documentId: planPriceDocumentId }],
      },
      duration,
      durationMonths,
      customerPriceSnapshot: fromPaise(customerPricePaise),
      currency,
      membershipStatus: "pending",
      paymentStatus: "pending",
      paymentProvider: "razorpay",
      providerOrderId: order.id,
      paymentIdempotencyKey: idempotencyKey,
    },
  });

    return {
      reused: false,
      membershipDocumentId: membership.documentId,
      razorpayOrderId: order.id,
      keyId: process.env.RAZORPAY_KEY_ID,
      amount: customerPricePaise,
      currency,
      paymentStatus: "pending",
      membershipStatus: "pending",
    };
  });
}

export async function verifyRazorpayPayment(
  razorpayOrderId: string,
  razorpayPaymentId: string
) {
  const payment = await razorpay.payments.fetch(razorpayPaymentId);

  if (payment.order_id !== razorpayOrderId) {
    throw new Error("Payment does not belong to this Razorpay order.");
  }
  if (payment.status !== "captured" || payment.captured !== true) {
    throw new Error("Payment has not been captured.");
  }

  return payment;
}

export async function finalizeGymMembershipPayment(
  razorpayOrderId: string,
  razorpayPaymentId: string
) {
  // Verify against Razorpay directly; never trust client-supplied status.
  const payment = await verifyRazorpayPayment(
    razorpayOrderId,
    razorpayPaymentId
  );

  return strapi.db.transaction(async ({ trx }) => {
    const membership = await findOneDocument(
      GYM_MEMBERSHIP_UID,
      { providerOrderId: razorpayOrderId },
      { gym_contract: true, membership_plan_price: true, client_detail: true }
    );

    if (!membership) {
      throw new Error("Membership order was not found.");
    }

    await trx.raw(
      "SELECT pg_advisory_xact_lock(?)",
      [Number(membership.id)]
    );

    const current = await (strapi.documents(GYM_MEMBERSHIP_UID) as any)
      .findOne({
        documentId: membership.documentId,
        populate: {
          gym_contract: true,
          membership_plan_price: true,
          client_detail: true,
        },
      });

    if (!current) {
      throw new Error("Membership was not found.");
    }

    if (
      current.paymentStatus === "paid" &&
      current.membershipStatus === "active"
    ) {
      return {
        alreadyProcessed: true,
        membershipDocumentId: current.documentId,
        paymentStatus: "paid",
        membershipStatus: "active",
      };
    }

    if (current.membershipStatus !== "pending") {
      // Captured payment for a cancelled/non-pending record requires manual
      // reconciliation/refund. Do not activate it.
      throw new Error(
        "Payment was captured for a non-pending membership. Reconciliation is required."
      );
    }

    if (current.paymentStatus !== "pending") {
      throw new Error("Membership payment is not in a payable state.");
    }

    const expectedAmount = toPaise(
      Number(current.customerPriceSnapshot)
    );

    if (Number(payment.amount) !== expectedAmount) {
      throw new Error("Captured payment amount does not match.");
    }
    if (payment.currency !== current.currency) {
      throw new Error("Captured payment currency does not match.");
    }
    if (payment.order_id !== current.providerOrderId) {
      throw new Error("Razorpay order ID does not match.");
    }
    if (
      current.providerPaymentId &&
      current.providerPaymentId !== razorpayPaymentId
    ) {
      throw new Error(
        "A different payment is already associated with this membership."
      );
    }

    const paidAt = new Date(Number(payment.created_at) * 1000);
    const endDate = getMembershipEndDate(
      paidAt,
      Number(current.durationMonths)
    );

    // Fetch Razorpay order notes to retrieve promotion / commission metadata
    let orderNotes: any = payment.notes || {};
    try {
      const rzOrder = await razorpay.orders.fetch(razorpayOrderId);
      orderNotes = { ...(rzOrder?.notes || {}), ...orderNotes };
    } catch (_) {}

    const contract = current.gym_contract;
    let selectedPromotion: any = null;
    let promotionApplied = false;

    if (orderNotes?.promotionId || orderNotes?.promotionDocumentId) {
      const promoId = orderNotes.promotionId;
      const promoDocId = orderNotes.promotionDocumentId;
      selectedPromotion = promoId
        ? await trx("gym_promotions").where({ id: Number(promoId) }).first()
        : await trx("gym_promotions").where({ document_id: promoDocId }).first();

      if (selectedPromotion) {
        promotionApplied = true;
      }
    }

    // Fallback: If not specified in notes, check if this contract has an active zero_commission promotion with reserved slots
    if (!selectedPromotion && contract?.id) {
      const contractPromo = await trx("gym_promotions as p")
        .join("gym_promotions_gym_contract_lnk as lnk", "lnk.gym_promotion_id", "p.id")
        .where("lnk.gym_contract_id", contract.id)
        .where("p.is_active", true)
        .where("p.promotion_type", "zero_commission")
        .where("p.reserved_user_count", ">", 0)
        .orderBy("p.id", "asc")
        .first();

      if (contractPromo) {
        selectedPromotion = contractPromo;
        promotionApplied = true;
      }
    }

    // Confirm promotion reservation: reduce reserved_user_count and increase used_user_count
    if (promotionApplied && selectedPromotion?.id) {
      const promotionUpdated = await trx("gym_promotions")
        .where({ id: selectedPromotion.id })
        .where("reserved_user_count", ">", 0)
        .update({
          reserved_user_count: trx.raw(
            "GREATEST(COALESCE(reserved_user_count, 0) - 1, 0)"
          ),
          used_user_count: trx.raw(
            "COALESCE(used_user_count, 0) + 1"
          ),
          updated_at: new Date(),
        });

      if (!promotionUpdated) {
        strapi.log.warn(
          `[finalizeGymMembershipPayment] Promotion reservation count could not be decremented for promo id ${selectedPromotion.id}`
        );
      }
    }

    // Calculate commission
    const customerPrice = Number(current.customerPriceSnapshot);
    let commissionMode: "default" | "custom" | "promotion" = "default";
    let commissionAmount = 0;

    if (promotionApplied) {
      commissionMode = "promotion";
      commissionAmount = 0;
    } else if (orderNotes?.commissionMode === "custom" && orderNotes?.commissionPaise) {
      commissionMode = "custom";
      commissionAmount = fromPaise(Number(orderNotes.commissionPaise));
    } else {
      const planPriceId = current.membership_plan_price?.id;
      let planRate: any = null;
      if (contract?.id && planPriceId) {
        planRate = await trx("gym_contract_plan_rates as r")
          .join("gym_contract_plan_rates_gym_contract_lnk as clnk", "clnk.gym_contract_plan_rate_id", "r.id")
          .join("gym_contract_plan_rates_membership_plan_price_lnk as plnk", "plnk.gym_contract_plan_rate_id", "r.id")
          .where("clnk.gym_contract_id", contract.id)
          .where("plnk.membership_plan_price_id", planPriceId)
          .where("r.is_active", true)
          .first();
      }

      if (planRate?.commission_mode === "custom" && planRate.custom_commission != null) {
        commissionMode = "custom";
        commissionAmount = Number(planRate.custom_commission);
      } else {
        commissionMode = "default";
        commissionAmount = Number(current.membership_plan_price?.defaultCommission ?? 0);
      }
    }

    // gym payout value will be customerprice - commisson amount
    const gymPayout = Number(Math.max(0, customerPrice - commissionAmount).toFixed(2));
    const membershipId = current.membershipId || `MEM-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

    // Update gym membership to active and paid
    await (strapi.documents(GYM_MEMBERSHIP_UID) as any).update({
      documentId: current.documentId,
      data: {
        membershipId,
        membershipStatus: "active",
        paymentStatus: "paid",
        startDate: paidAt.toISOString().slice(0, 10),
        endDate: endDate.toISOString().slice(0, 10),
        paidAt: paidAt.toISOString(),
        providerPaymentId: razorpayPaymentId,
      },
    });

    // Check if commission transaction already exists for this membership
    const existingCommission = await findOneDocument(
      COMMISSION_UID,
      { gym_membership: { documentId: current.documentId } }
    );

    if (!existingCommission && contract?.documentId) {
      const promoDocId = selectedPromotion?.document_id || selectedPromotion?.documentId;

      const durationMap: Record<string, string> = {
        monthly: "Monthly",
        six_months: "6 Months",
        twelve_months: "12 Months",
      };
      const durationLabel =
        durationMap[current.duration] || current.duration || "Gym";
      const notes = `This commission entry is created for ${durationLabel} membership purchased.`;

      await (strapi.documents(COMMISSION_UID) as any).create({
        data: {
          gym_membership: {
            connect: [{ documentId: current.documentId }],
          },
          gym_contract: {
            connect: [{ documentId: contract.documentId }],
          },
          ...(promoDocId && promotionApplied
            ? {
                gym_promotion: {
                  connect: [{ documentId: promoDocId }],
                },
              }
            : {}),
          commissionMode,
          customerPrice,
          commissionAmount,
          gymPayout,
          currency: current.currency || "INR",
          promotionApplied,
          transactionStatus: "pending",
          notes,
        },
      });
    }

    return {
      alreadyProcessed: false,
      membershipDocumentId: current.documentId,
      paymentId: razorpayPaymentId,
      paymentStatus: "paid",
      membershipStatus: "active",
    };
  });
}

export { razorpay };
