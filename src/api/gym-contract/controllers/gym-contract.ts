import { factories } from "@strapi/strapi";

const GYM_CONTRACT_UID = "api::gym-contract.gym-contract";

const CLUB_OWNER_UID = "api::club-owner.club-owner";

const REQUIRED_DURATIONS = ["monthly", "six_months", "twelve_months"];

function toNumber(value: unknown): number {
  const result = Number(value);

  if (!Number.isFinite(result)) {
    throw new Error("Invalid pricing or commission value.");
  }

  return result;
}

export default factories.createCoreController(
  GYM_CONTRACT_UID,
  ({ strapi }) => ({
    async getGymContract(ctx) {
      try {
        const { documentId } = ctx.params;

        if (typeof documentId !== "string" || !documentId.trim()) {
          return ctx.badRequest("Gym Owner documentId is required.");
        }

        // Find Gym Owner
        const clubOwner = await strapi.db.query(CLUB_OWNER_UID).findOne({
          where: {
            documentId: documentId.trim(),
          },
          select: ["id"],
        });

        if (!clubOwner) {
          return ctx.notFound("Gym Owner not found.");
        }

        // Find Gym Contract
        const gymContract = await strapi.db.query(GYM_CONTRACT_UID).findOne({
          where: {
            club_owner: {
              id: clubOwner.id,
            },
          },
          populate: {
            membership_tier: true,
            gym_contract_plan_rates: {
              populate: {
                membership_plan_price: true,
              },
            },
            gym_promotions: true,
          },
        });

        if (!gymContract) {
          return ctx.notFound("Gym contract not found.");
        }

        const rates = gymContract.gym_contract_plan_rates || [];

        // Build only the three requested plan rows
        const plans = REQUIRED_DURATIONS.map((duration) => {
          const rate = rates.find(
            (item: any) => item.membership_plan_price?.duration === duration,
          );

          if (!rate || !rate.membership_plan_price) {
            throw new Error(`Contract rate not found for ${duration}.`);
          }

          const price = rate.membership_plan_price;

          const customerPrice = toNumber(price.customerPrice);

          const commissionMode = rate.commissionMode;

          const fitfobCommission =
            commissionMode === "custom"
              ? toNumber(rate.customCommission)
              : toNumber(price.defaultCommission);

          if (fitfobCommission < 0 || fitfobCommission > customerPrice) {
            throw new Error(`Invalid commission for ${duration}.`);
          }

          return {
            duration,
            customerPrice,
            fitfobCommission,
            commissionMode,
            clubNetPayout: customerPrice - fitfobCommission,
          };
        });

        // Assigned category tier
        const categoryTier = gymContract.membership_tier?.name || null;

        // Zero-commission promotion
        const promotion = (gymContract.gym_promotions || []).find(
          (item: any) => item.promotionType === "zero_commission",
        );

        // Return only screenshot fields
        return ctx.send({
          data: {
            categoryTier,

            zeroCommissionDeal: {
              enabled: promotion?.isActive === true,
              userLimit: promotion?.userLimit ?? 0,
              usedUserCount: promotion?.usedUserCount ?? 0,
            },

            plans,
          },
        });
      } catch (error: any) {
        strapi.log.error("Error fetching gym contract configuration:", error);

        return ctx.internalServerError(
          error.message || "Unable to fetch gym contract configuration.",
        );
      }
    },

    async getMyContract(ctx) {
      try {
        // 1. Get authenticated Gym Owner user
        const authUser = ctx.state.user;

        if (!authUser) {
          return ctx.unauthorized("Authentication required.");
        }

        // 2. Find the Gym Owner linked to the logged-in user
        // Assumption: club-owner has a relation named "user"
        const clubOwner = await strapi.db
          .query("api::club-owner.club-owner")
          .findOne({
            where: {
              user: {
                id: authUser.id,
              },
            },
            select: ["id", "clubName"],
          });

        if (!clubOwner) {
          return ctx.notFound("Gym Owner profile not found.");
        }

        // 3. Find only this Gym Owner's active contract
        const gymContract = await strapi.db
          .query("api::gym-contract.gym-contract")
          .findOne({
            where: {
              club_owner: {
                id: clubOwner.id,
              },
              contractStatus: "active",
            },
            populate: {
              membership_tier: true,

              gym_contract_plan_rates: {
                populate: {
                  membership_plan_price: true,
                },
              },

              gym_promotions: true,
            },
          });

        if (!gymContract) {
          return ctx.notFound("No active gym contract found.");
        }

        // 4. Get zero-commission promotion
        const promotion = (gymContract.gym_promotions || []).find(
          (item: any) =>
            item.promotionType === "zero_commission" && item.isActive === true,
        );

        // 5. Build promotion response only when enabled
        let zeroCommissionOffer: any = undefined;

        if (promotion) {
          const userLimit = Number(promotion.userLimit || 0);
          const usedUserCount = Number(promotion.usedUserCount || 0);

          zeroCommissionOffer = {
            userLimit,
            usedUserCount,
            remainingUserCount: Math.max(0, userLimit - usedUserCount),
            completed: usedUserCount >= userLimit,
          };
        }

        // 6. Build membership plan response
        const durationOrder = ["monthly", "six_months", "twelve_months"];

        const rates = gymContract.gym_contract_plan_rates || [];

        const plans = durationOrder.map((duration) => {
          const rate = rates.find(
            (item: any) => item.membership_plan_price?.duration === duration,
          );

          if (!rate?.membership_plan_price) {
            throw new Error(`Membership plan rate missing: ${duration}`);
          }

          const price = rate.membership_plan_price;

          const customerPrice = Number(price.customerPrice);

          const fitfobCommission =
            rate.commissionMode === "custom"
              ? Number(rate.customCommission)
              : Number(price.defaultCommission);

          if (
            !Number.isFinite(customerPrice) ||
            !Number.isFinite(fitfobCommission) ||
            fitfobCommission < 0 ||
            fitfobCommission > customerPrice
          ) {
            throw new Error(`Invalid pricing or commission for ${duration}`);
          }

          return {
            duration,
            customerPrice,
            fitfobCommission,
            ownerPayoutAfterPromotionEnds: customerPrice - fitfobCommission,
          };
        });

        // 7. Final response
        const responseData: any = {
          plans,
        };

        // Do not return the offer when it is disabled or missing
        if (zeroCommissionOffer) {
          responseData.zeroCommissionOffer = zeroCommissionOffer;
        }

        return ctx.send({
          data: responseData,
        });
      } catch (error: any) {
        strapi.log.error("Error fetching Gym Owner contract:", error);

        return ctx.internalServerError(
          error.message || "Unable to fetch your gym contract.",
        );
      }
    },
  }),
);
