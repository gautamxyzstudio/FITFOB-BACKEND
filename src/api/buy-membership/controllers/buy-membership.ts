const CONTRACT_PLAN_RATE_UID =
  "api::gym-contract-plan-rate.gym-contract-plan-rate";
const CLIENT_TABLE = "client_details";
const CLIENT_USER_LINK_TABLE = "up_users_client_detail_lnk";

import { createMembershipOrder } from "../../../utils/razorpay";

function dateOnly(value?: string | Date | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function isContractOutsideDateRange(
  startDate?: string | Date | null,
  endDate?: string | Date | null
) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const start = dateOnly(startDate);
  const end = dateOnly(endDate);

  if (start) {
    start.setHours(0, 0, 0, 0);
    if (today < start) return true;
  }
  if (end) {
    end.setHours(23, 59, 59, 999);
    if (today > end) return true;
  }
  return false;
}

async function findClientByUserId(userId: number) {
  return strapi.db.connection(`${CLIENT_TABLE} as c`)
    .join(
      `${CLIENT_USER_LINK_TABLE} as l`,
      "l.client_detail_id",
      "c.id"
    )
    .where("l.user_id", userId)
    .select(
      "c.id",
      "c.document_id",
      "c.client_id",
      "c.name",
      "c.email"
    )
    .first();
}

export default {
  async buy(ctx: any) {
    try {
      const user = ctx.state.user;

      if (!user?.id) {
        return ctx.unauthorized("Please log in to continue.");
      }

      const {
        gym_contract_plan_rate: rateDocumentId,
        idempotencyKey,
      } = ctx.request.body?.data ?? {};

      if (
        typeof rateDocumentId !== "string" ||
        !rateDocumentId.trim()
      ) {
        return ctx.badRequest(
          "Gym contract plan rate document ID is required."
        );
      }

      if (
        typeof idempotencyKey !== "string" ||
        !idempotencyKey.trim() ||
        idempotencyKey.length > 128
      ) {
        return ctx.badRequest("A valid idempotency key is required.");
      }

      const client = await findClientByUserId(user.id);
      if (!client?.document_id) {
        return ctx.badRequest("Customer profile was not found.");
      }

      const planRate = await (strapi.documents(
        CONTRACT_PLAN_RATE_UID as any
      ) as any).findOne({
        documentId: rateDocumentId,
        populate: {
          gym_contract: {
            populate: {
              club_owner: true,
              membership_tier: true,
            },
          },
          membership_plan_price: {
            populate: {
              membership_tier: true,
            },
          },
        },
      });

      if (!planRate) {
        return ctx.notFound("Selected membership plan was not found.");
      }
      if (!planRate.isActive) {
        return ctx.badRequest("This membership plan is inactive.");
      }

      const contract = planRate.gym_contract;
      const planPrice = planRate.membership_plan_price;

      if (!contract || !planPrice) {
        return ctx.badRequest("Membership plan configuration is incomplete.");
      }
      if (contract.contractStatus !== "active") {
        return ctx.badRequest("This gym contract is not active.");
      }
      if (
        isContractOutsideDateRange(
          contract.startDate,
          contract.endDate
        )
      ) {
        return ctx.badRequest(
          "This gym contract is outside its valid date range."
        );
      }
      if (!contract.club_owner) {
        return ctx.badRequest("Gym owner configuration was not found.");
      }
      if (
        !contract.membership_tier ||
        !contract.membership_tier.isActive
      ) {
        return ctx.badRequest("This membership tier is not active.");
      }
      if (!planPrice.isActive) {
        return ctx.badRequest("This membership price is inactive.");
      }
      if (
        planPrice.membership_tier?.documentId !==
        contract.membership_tier.documentId
      ) {
        return ctx.badRequest(
          "Membership plan does not belong to this gym contract tier."
        );
      }

      const customerPrice = Number(planPrice.customerPrice);
      const defaultCommission = Number(planPrice.defaultCommission);
      const customCommission =
        planRate.customCommission == null
          ? undefined
          : Number(planRate.customCommission);

      if (!Number.isFinite(customerPrice) || customerPrice <= 0) {
        return ctx.badRequest("Invalid membership price.");
      }
      if (
        !Number.isFinite(defaultCommission) ||
        defaultCommission < 0 ||
        defaultCommission > customerPrice
      ) {
        return ctx.badRequest("Invalid default commission configuration.");
      }
      if (
        planRate.commissionMode !== "default" &&
        planRate.commissionMode !== "custom"
      ) {
        return ctx.badRequest("Invalid commission mode.");
      }
      if (
        planRate.commissionMode === "custom" &&
        (
          customCommission === undefined ||
          !Number.isFinite(customCommission) ||
          customCommission < 0 ||
          customCommission > customerPrice
        )
      ) {
        return ctx.badRequest("Invalid custom commission configuration.");
      }

      const durationMonths = Number(
        planPrice.durationMonths ??
          (planPrice.duration === "monthly"
            ? 1
            : planPrice.duration === "six_months"
              ? 6
              : planPrice.duration === "twelve_months"
                ? 12
                : 0)
      );

      if (!Number.isInteger(durationMonths) || durationMonths < 1) {
        return ctx.badRequest("Invalid membership duration.");
      }

      const currency =
        contract.currency || planPrice.currency || "INR";

      if (currency !== "INR") {
        return ctx.badRequest("This payment currency is not supported.");
      }

      const result = await createMembershipOrder({
        clientDocumentId: client.document_id,
        contractDocumentId: contract.documentId,
        planPriceDocumentId: planPrice.documentId,
        idempotencyKey,
        duration: planPrice.duration,
        durationMonths,
        customerPrice,
        defaultCommission,
        commissionMode: planRate.commissionMode,
        customCommission,
        currency,
      });

      return ctx.send({
        message: result.reused
          ? "Existing payment order returned."
          : "Membership payment order created.",
        data: result,
      });
    } catch (error: any) {
      strapi.log.error("Membership purchase error:", error);
      const message =
        error?.message || "Unable to create membership order.";

      if (
        message.includes("active membership") ||
        message.includes("pending payment") ||
        message.includes("already being processed")
      ) {
        ctx.status = 409;
        ctx.body = { success: false, message };
        return;
      }

      ctx.status = 400;
      ctx.body = { success: false, message };
    }
  },
};
