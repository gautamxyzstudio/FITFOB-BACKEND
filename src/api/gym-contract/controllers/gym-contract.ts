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

    async updateGymContract(ctx) {
      try {
        const { documentId } = ctx.params;
        const body = ctx.request.body?.data ?? ctx.request.body;

        const GYM_CONTRACT_UID = "api::gym-contract.gym-contract";
        const CLUB_OWNER_UID = "api::club-owner.club-owner";
        const GYM_PROMOTION_UID = "api::gym-promotion.gym-promotion";

        const hasPromotionUpdate = body?.zeroCommissionDeal !== undefined;

        const hasCommissionUpdate = body?.plans !== undefined;

        // At least one supported section is required.
        if (!hasPromotionUpdate && !hasCommissionUpdate) {
          return ctx.badRequest(
            "Provide zeroCommissionDeal or plans to update.",
          );
        }

        // --------------------------------------------------
        // 1. Find Club Owner
        // --------------------------------------------------

        const clubOwner = await strapi.db.query(CLUB_OWNER_UID).findOne({
          where: { documentId },
          select: ["id", "documentId", "clubName"],
        });

        if (!clubOwner) {
          return ctx.notFound("Club owner not found.");
        }

        // --------------------------------------------------
        // 2. Find Gym Contract
        // --------------------------------------------------

        const gymContract = await strapi.db.query(GYM_CONTRACT_UID).findOne({
          where: {
            club_owner: { id: clubOwner.id },
          },
          populate: {
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

        const existingRates = gymContract.gym_contract_plan_rates ?? [];

        const existingPromotion = gymContract.gym_promotions?.find(
          (promotion) => promotion.promotionType === "zero_commission",
        );

        // --------------------------------------------------
        // 3. Validate Promotion Input
        // --------------------------------------------------

        let promotionUpdate: {
          isActive?: boolean;
          userLimit?: number;
        } | null = null;

        if (hasPromotionUpdate) {
          const promotionInput = body.zeroCommissionDeal;

          if (
            !promotionInput ||
            typeof promotionInput !== "object" ||
            Array.isArray(promotionInput)
          ) {
            return ctx.badRequest("zeroCommissionDeal must be an object.");
          }

          if (!existingPromotion) {
            return ctx.notFound("Zero-commission promotion not found.");
          }

          const updateData: {
            isActive?: boolean;
            userLimit?: number;
            reservedUserCount?: number;
          } = {};

          // Admin can update enabled independently.
          if (promotionInput.enabled !== undefined) {
            if (typeof promotionInput.enabled !== "boolean") {
              return ctx.badRequest(
                "zeroCommissionDeal.enabled must be a boolean.",
              );
            }

            updateData.isActive = promotionInput.enabled;
          }

          // Admin can update userLimit independently.
          if (promotionInput.userLimit !== undefined) {
            const userLimit = Number(promotionInput.userLimit);

            if (!Number.isInteger(userLimit) || userLimit < 0) {
              return ctx.badRequest(
                "zeroCommissionDeal.userLimit must be a non-negative integer.",
              );
            }

            const usedUserCount = Number(existingPromotion.usedUserCount ?? 0);

            if (userLimit <= usedUserCount) {
              return ctx.badRequest(
                "User limit cannot be lower than used users.",
              );
            }

            updateData.userLimit = userLimit;
            updateData.reservedUserCount = userLimit - usedUserCount;
          }

          if (Object.keys(updateData).length === 0) {
            return ctx.badRequest(
              "Provide enabled or userLimit inside zeroCommissionDeal.",
            );
          }

          promotionUpdate = updateData;
        }

        // --------------------------------------------------
        // 4. Validate Commission Input
        // --------------------------------------------------

        const commissionUpdates: Array<{
          rateId: number;
          duration: string;
          commissionMode: "default" | "custom";
          customCommission: number | null;
          customerPrice: number;
        }> = [];

        if (hasCommissionUpdate) {
          if (!Array.isArray(body.plans) || body.plans.length === 0) {
            return ctx.badRequest("plans must be a non-empty array.");
          }

          const allowedDurations = ["monthly", "six_months", "twelve_months"];

          const submittedDurations = new Set<string>();

          for (const submittedPlan of body.plans) {
            const { duration, commissionMode } = submittedPlan ?? {};

            if (!allowedDurations.includes(duration)) {
              return ctx.badRequest(`Invalid plan duration: ${duration}.`);
            }

            if (submittedDurations.has(duration)) {
              return ctx.badRequest(`Duplicate plan duration: ${duration}.`);
            }

            submittedDurations.add(duration);

            if (commissionMode !== "default" && commissionMode !== "custom") {
              return ctx.badRequest(
                `Invalid commissionMode for ${duration}. Use default or custom.`,
              );
            }

            // Find the existing rate for this duration.
            const existingRate = existingRates.find(
              (rate) => rate.membership_plan_price?.duration === duration,
            );

            if (!existingRate) {
              return ctx.badRequest(`Contract rate not found for ${duration}.`);
            }

            const membershipPrice = existingRate.membership_plan_price;

            const customerPrice = Number(membershipPrice.customerPrice);

            if (!Number.isFinite(customerPrice)) {
              return ctx.badRequest(`Invalid customer price for ${duration}.`);
            }

            let customCommission: number | null = null;

            if (commissionMode === "custom") {
              const submittedCommission = submittedPlan.customCommission;

              // If customCommission is omitted, preserve the
              // existing custom amount.
              const effectiveCustomCommission =
                submittedCommission !== undefined
                  ? Number(submittedCommission)
                  : Number(existingRate.customCommission);

              if (
                !Number.isFinite(effectiveCustomCommission) ||
                effectiveCustomCommission < 0 ||
                effectiveCustomCommission > customerPrice
              ) {
                return ctx.badRequest(
                  `Invalid customCommission for ${duration}.`,
                );
              }

              customCommission = effectiveCustomCommission;
            }

            // For default mode, customCommission is cleared.
            commissionUpdates.push({
              rateId: existingRate.id,
              duration,
              commissionMode,
              customCommission,
              customerPrice,
            });
          }
        }

        // --------------------------------------------------
        // 5. Update Promotion Only If Submitted
        // --------------------------------------------------

        if (promotionUpdate) {
          await strapi.db.query(GYM_PROMOTION_UID).update({
            where: {
              id: existingPromotion.id,
            },
            data: promotionUpdate,
          });
        }

        // --------------------------------------------------
        // 6. Update Only Submitted Plan Commissions
        // --------------------------------------------------

        for (const commission of commissionUpdates) {
          await strapi.db
            .query("api::gym-contract-plan-rate.gym-contract-plan-rate")
            .update({
              where: {
                id: commission.rateId,
              },
              data: {
                commissionMode: commission.commissionMode,
                customCommission: commission.customCommission,
              },
            });
        }

        // --------------------------------------------------
        // 7. Fetch Updated Contract
        // --------------------------------------------------

        const updatedContract = await strapi.db
          .query(GYM_CONTRACT_UID)
          .findOne({
            where: {
              id: gymContract.id,
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

        const updatedPromotion = updatedContract.gym_promotions?.find(
          (promotion) => promotion.promotionType === "zero_commission",
        );

        const durationOrder = ["monthly", "six_months", "twelve_months"];

        const plans = (updatedContract.gym_contract_plan_rates ?? [])
          .filter(
            (rate) => rate.isActive !== false && rate.membership_plan_price,
          )
          .map((rate) => {
            const membershipPrice = rate.membership_plan_price;

            const customerPrice = Number(membershipPrice.customerPrice);

            const fitfobCommission =
              rate.commissionMode === "custom"
                ? Number(rate.customCommission)
                : Number(membershipPrice.defaultCommission);

            return {
              duration: membershipPrice.duration,
              customerPrice,
              fitfobCommission,
              commissionMode: rate.commissionMode,
              clubNetPayout: customerPrice - fitfobCommission,
            };
          })
          .sort(
            (a, b) =>
              durationOrder.indexOf(a.duration) -
              durationOrder.indexOf(b.duration),
          );

        return ctx.send({
          data: {
            zeroCommissionDeal: {
              enabled: updatedPromotion?.isActive === true,
              userLimit: updatedPromotion?.userLimit ?? 0,
            },
            plans,
          },
        });
      } catch (error) {
        strapi.log.error("Update Gym Contract Error:", error);

        return ctx.internalServerError(
          error.message || "Unable to update gym contract.",
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
            select: ["id", "clubName", "clubCategory"],
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
          clubName: clubOwner.clubName,
          clubCategory: clubOwner.clubCategory,
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
