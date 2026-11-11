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
    let promotionSequence = 0;

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
        const refreshed = await (strapi.documents(GYM_PROMOTION_UID) as any)
          .findOne({ documentId: promotion.documentId });

        promotionSequence =
          Number(refreshed?.usedUserCount ?? 0) +
          Number(refreshed?.reservedUserCount ?? 0);
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
      { gym_promotion: true, gym_contract: true }
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
          gym_promotion: true,
          gym_contract: true,
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

    if (current.promotionApplied && current.gym_promotion?.id) {
      const promotionUpdated = await trx("gym_promotions")
        .where({ id: current.gym_promotion.id })
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
        throw new Error("Promotion reservation could not be confirmed.");
      }
    }

    await (strapi.documents(GYM_MEMBERSHIP_UID) as any).update({
      documentId: current.documentId,
      data: {
        membershipStatus: "active",
        paymentStatus: "paid",
        startDate: paidAt,
        endDate,
        paidAt,
        providerPaymentId: razorpayPaymentId,
      },
    });

    const commissionIdempotencyKey =
      `gym-commission-${current.documentId}`;

    const existingCommission = await findOneDocument(
      COMMISSION_UID,
      { idempotencyKey: commissionIdempotencyKey }
    );

    if (!existingCommission) {
      await (strapi.documents(COMMISSION_UID) as any).create({
        data: {
          gym_membership: {
            connect: [{ documentId: current.documentId }],
          },
          gym_contract: {
            connect: [{ documentId: current.gym_contract.documentId }],
          },
          ...(current.gym_promotion?.documentId
            ? {
                gym_promotion: {
                  connect: [{ documentId: current.gym_promotion.documentId }],
                },
              }
            : {}),
          transactionType: "charge",
          commissionMode: current.commissionModeSnapshot,
          customerPrice: current.customerPriceSnapshot,
          commissionAmount: current.commissionSnapshot,
          gatewayFee: current.gatewayFeeSnapshot ?? 0,
          gymPayout: current.gymPayoutSnapshot,
          currency: current.currency,
          promotionApplied: current.promotionApplied,
          promotionSequence: current.promotionSequence,
          transactionStatus: "paid",
          providerPaymentId: razorpayPaymentId,
          providerTransactionId: razorpayPaymentId,
          idempotencyKey: commissionIdempotencyKey,
          notes: "Membership payment captured through Razorpay.",
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
