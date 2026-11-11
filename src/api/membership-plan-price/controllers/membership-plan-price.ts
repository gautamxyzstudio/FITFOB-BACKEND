import { factories } from "@strapi/strapi";
import { randomUUID } from "node:crypto";
import {
  logAdminActivity,
  getAdminActivityUserId,
} from "../../../utils/admin-activity-log";

const UID = "api::membership-plan-price.membership-plan-price";

const EXPECTED_TIERS = ["basic", "premium", "luxury"] as const;

const DURATION_MONTHS = {
  monthly: 1,
  six_months: 6,
  twelve_months: 12,
} as const;

type Duration = keyof typeof DURATION_MONTHS;

type PlanInput = {
  duration: Duration;
  durationMonths: number;
  customerPrice: number;
  defaultCommission: number;
};

type TierInput = {
  tier: string;
  plans: PlanInput[];
};

export default factories.createCoreController(UID, ({ strapi }) => ({
  async create(ctx) {
    try {
      const body = ctx.request.body as any;
      const payload = body?.data ?? body;

      const { tiers, currency = "INR" } = payload || {};

      // 1. Validate payload
      if (!Array.isArray(tiers) || tiers.length !== 3) {
        return ctx.badRequest("Exactly three membership tiers are required.");
      }

      if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
        return ctx.badRequest("Invalid currency.");
      }

      const tierNames = tiers.map((item: TierInput) => item.tier);

      if (
        new Set(tierNames).size !== 3 ||
        !EXPECTED_TIERS.every((name) => tierNames.includes(name))
      ) {
        return ctx.badRequest(
          "basic, premium and luxury tiers are required exactly once.",
        );
      }

      // 2. Validate all nine plans
      const validatedPlans: {
        tierName: string;
        plan: PlanInput;
      }[] = [];

      for (const tierItem of tiers as TierInput[]) {
        if (!Array.isArray(tierItem.plans) || tierItem.plans.length !== 3) {
          return ctx.badRequest(
            `Exactly three plans are required for ${tierItem.tier}.`,
          );
        }

        const durations = tierItem.plans.map((plan) => plan.duration);

        if (
          new Set(durations).size !== 3 ||
          !Object.keys(DURATION_MONTHS).every((duration) =>
            durations.includes(duration as Duration),
          )
        ) {
          return ctx.badRequest(
            `All three durations are required for ${tierItem.tier}.`,
          );
        }

        for (const plan of tierItem.plans) {
          if (
            !plan ||
            !(plan.duration in DURATION_MONTHS) ||
            plan.durationMonths !== DURATION_MONTHS[plan.duration] ||
            typeof plan.customerPrice !== "number" ||
            !Number.isFinite(plan.customerPrice) ||
            plan.customerPrice <= 0 ||
            typeof plan.defaultCommission !== "number" ||
            !Number.isFinite(plan.defaultCommission) ||
            plan.defaultCommission < 0 ||
            plan.defaultCommission > plan.customerPrice
          ) {
            return ctx.badRequest(
              `Invalid pricing for ${tierItem.tier} - ${plan?.duration}.`,
            );
          }

          validatedPlans.push({
            tierName: tierItem.tier,
            plan,
          });
        }
      }

      // 3. PostgreSQL transaction
      const savedRecords = await strapi.db.connection.transaction(
        async (trx) => {
          // Fetch membership tiers
          const tierRecords = await trx("membership_tiers")
            .select("id", "name")
            .whereIn("name", EXPECTED_TIERS);

          const tierMap = new Map<string, number>(
            tierRecords.map((tier: any) => [tier.name, tier.id]),
          );

          for (const tierName of EXPECTED_TIERS) {
            if (!tierMap.has(tierName)) {
              throw new Error(`Membership tier "${tierName}" does not exist.`);
            }
          }

          const results: any[] = [];

          for (const item of validatedPlans) {
            const tierId = tierMap.get(item.tierName)!;
            const plan = item.plan;
            const now = new Date();

            // Correct Strapi 5 relation table: _lnk
            const existing = await trx(
              "membership_plan_prices_membership_tier_lnk as links",
            )
              .join(
                "membership_plan_prices as prices",
                "prices.id",
                "links.membership_plan_price_id",
              )
              .select("prices.id")
              .where("links.membership_tier_id", tierId)
              .where("prices.duration", plan.duration)
              .first();

            let priceId: number;

            if (existing) {
              // Update existing pricing record
              priceId = existing.id;

              await trx("membership_plan_prices")
                .where({ id: priceId })
                .update({
                  duration: plan.duration,
                  duration_months: plan.durationMonths,
                  customer_price: plan.customerPrice,
                  default_commission: plan.defaultCommission,
                  currency,
                  is_active: true,
                  updated_at: now,
                });
            } else {
              // Create new Strapi 5 pricing record
              const [created] = await trx("membership_plan_prices")
                .insert({
                  document_id: randomUUID(),
                  duration: plan.duration,
                  duration_months: plan.durationMonths,
                  customer_price: plan.customerPrice,
                  default_commission: plan.defaultCommission,
                  currency,
                  is_active: true,
                  created_at: now,
                  updated_at: now,
                })
                .returning("id");

              priceId = created.id;

              // Create relation using the confirmed _lnk table
              await trx("membership_plan_prices_membership_tier_lnk").insert({
                membership_plan_price_id: priceId,
                membership_tier_id: tierId,
                membership_plan_price_ord: 1,
              });

              // Create activity log
              await logAdminActivity({
                adminUserId: getAdminActivityUserId(ctx),
                category: "global_pricing",
                actionType: "create",
                entityName: "Membership Plan Pricing",
                entityId: priceId,
                description: `Created ${item.tierName} ${plan.duration} pricing. Customer price: ${plan.customerPrice}, Commission: ${plan.defaultCommission}, Currency: ${currency}.`,
              });
            }

            results.push({
              id: priceId,
              tier: item.tierName,
              duration: plan.duration,
              durationMonths: plan.durationMonths,
              customerPrice: plan.customerPrice,
              defaultCommission: plan.defaultCommission,
              currency,
              isActive: true,
            });
          }

          return results;
        },
      );

      ctx.status = 200;

      ctx.body = {
        data: savedRecords,
      };
    } catch (error: any) {
      strapi.log.error("Global membership pricing error:", error);

      return ctx.internalServerError(
        error.message || "Unable to publish global membership prices.",
      );
    }
  },

  async find(ctx) {
    try {
      const records = await strapi.db
        .connection("membership_plan_prices as mp")
        .join(
          "membership_plan_prices_membership_tier_lnk as mpt",
          "mp.id",
          "mpt.membership_plan_price_id",
        )
        .join("membership_tiers as mt", "mpt.membership_tier_id", "mt.id")
        .select(
          "mp.id",
          "mt.name as tier",
          "mp.duration",
          "mp.duration_months as durationMonths",
          "mp.customer_price as customerPrice",
          "mp.default_commission as defaultCommission",
          "mp.currency",
          "mp.created_at as createdAt",
          "mp.is_active as isActive",
        )
        .where("mp.is_active", true)
        .orderBy("mt.id", "asc").orderByRaw(`
        CASE mp.duration
          WHEN 'monthly' THEN 1
          WHEN 'six_months' THEN 2
          WHEN 'twelve_months' THEN 3
          ELSE 4
        END
      `);

      // Group plans by membership tier
      const tierMap = new Map<string, any>();

      for (const record of records) {
        if (!tierMap.has(record.tier)) {
          tierMap.set(record.tier, {
            tier: record.tier,
            plans: [],
          });
        }

        tierMap.get(record.tier).plans.push({
          id: record.id,
          duration: record.duration,
          durationMonths: record.durationMonths,
          customerPrice: Number(record.customerPrice),
          defaultCommission: Number(record.defaultCommission),
          isActive: record.isActive,
          createdAt: record.createdAt,
        });
      }

      // Keep tier values consistent with your Strapi enum
      const tiers = ["basic", "premium", "luxury"].map(
        (tier) =>
          tierMap.get(tier) || {
            tier,
            plans: [],
          },
      );

      // Validate currencies
      const currencies = [...new Set(records.map((record) => record.currency))];

      if (currencies.length > 1) {
        return ctx.internalServerError(
          "Membership pricing contains inconsistent currencies.",
        );
      }

      const currency = currencies[0] || "INR";

      ctx.body = {
        tiers,
      };
    } catch (error) {
      strapi.log.error("Membership pricing find error:", error);

      return ctx.internalServerError(
        "Unable to fetch global membership pricing.",
      );
    }
  },

  async updatePricing(ctx) {
    const VALID_TIERS = ["basic", "premium", "luxury"] as const;

    const DURATION_MONTHS = {
      monthly: 1,
      six_months: 6,
      twelve_months: 12,
    } as const;

    const VALID_DURATIONS = Object.keys(DURATION_MONTHS);

    type TierName = (typeof VALID_TIERS)[number];

    try {
      const body = ctx.request.body?.data;

      // Validate request body
      if (
        !body ||
        typeof body !== "object" ||
        !Array.isArray(body.tiers) ||
        body.tiers.length === 0
      ) {
        return ctx.badRequest(
          "Please provide at least one tier with pricing plans.",
        );
      }

      // Optional global currency for submitted plans
      const currency = body.currency;

      if (
        currency !== undefined &&
        (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency))
      ) {
        return ctx.badRequest(
          "Currency must be a valid 3-letter uppercase code.",
        );
      }

      // Validate tiers and plans
      const seenTiers = new Set<string>();
      const seenPlans = new Set<string>();

      for (const tierData of body.tiers) {
        const tier = tierData?.tier;

        if (!VALID_TIERS.includes(tier)) {
          return ctx.badRequest(`Invalid membership tier: ${tier}`);
        }

        if (seenTiers.has(tier)) {
          return ctx.badRequest(`Duplicate membership tier: ${tier}`);
        }

        seenTiers.add(tier);

        if (!Array.isArray(tierData.plans) || tierData.plans.length === 0) {
          return ctx.badRequest(`At least one plan is required for ${tier}.`);
        }

        for (const plan of tierData.plans) {
          if (!plan || !VALID_DURATIONS.includes(plan.duration)) {
            return ctx.badRequest(`Invalid duration for ${tier}.`);
          }

          const planKey = `${tier}_${plan.duration}`;

          if (seenPlans.has(planKey)) {
            return ctx.badRequest(`Duplicate plan: ${planKey}`);
          }

          seenPlans.add(planKey);

          // durationMonths is optional, but must match if provided
          if (
            plan.durationMonths !== undefined &&
            plan.durationMonths !== DURATION_MONTHS[plan.duration]
          ) {
            return ctx.badRequest(`Invalid durationMonths for ${planKey}.`);
          }

          const hasCustomerPrice = plan.customerPrice !== undefined;

          const hasCommission = plan.defaultCommission !== undefined;

          const hasIsActive = plan.isActive !== undefined;

          if (
            !hasCustomerPrice &&
            !hasCommission &&
            !hasIsActive &&
            currency === undefined
          ) {
            return ctx.badRequest(
              `No fields provided to update for ${planKey}.`,
            );
          }

          if (
            hasCustomerPrice &&
            (typeof plan.customerPrice !== "number" ||
              !Number.isFinite(plan.customerPrice) ||
              plan.customerPrice <= 0)
          ) {
            return ctx.badRequest(
              `customerPrice must be greater than zero for ${planKey}.`,
            );
          }

          if (
            hasCommission &&
            (typeof plan.defaultCommission !== "number" ||
              !Number.isFinite(plan.defaultCommission) ||
              plan.defaultCommission < 0)
          ) {
            return ctx.badRequest(`Invalid defaultCommission for ${planKey}.`);
          }

          if (hasIsActive && typeof plan.isActive !== "boolean") {
            return ctx.badRequest(`isActive must be a boolean for ${planKey}.`);
          }
        }
      }

      const result = await strapi.db.connection.transaction(async (trx) => {
        const tierRecords = await trx("membership_tiers")
          .select("id", "name")
          .whereIn("name", [...seenTiers]);

        const tierIdMap = new Map(
          tierRecords.map((tier) => [tier.name, tier.id]),
        );

        if (tierIdMap.size !== seenTiers.size) {
          throw new Error("One or more membership tiers were not found.");
        }

        let updatedCount = 0;
        const updatedPlans = [];

        for (const tierData of body.tiers) {
          const tier: TierName = tierData.tier;
          const tierId = tierIdMap.get(tier);

          for (const plan of tierData.plans) {
            // Find existing price using the Strapi 5 relation table
            const existing = await trx(
              "membership_plan_prices_membership_tier_lnk as links",
            )
              .join(
                "membership_plan_prices as prices",
                "prices.id",
                "links.membership_plan_price_id",
              )
              .select(
                "prices.id",
                "prices.duration",
                "prices.duration_months",
                "prices.customer_price",
                "prices.default_commission",
                "prices.currency",
                "prices.is_active",
              )
              .where("links.membership_tier_id", tierId)
              .where("prices.duration", plan.duration)
              .first();

            if (!existing) {
              throw new Error(
                `Pricing record not found for ${tier} - ${plan.duration}.`,
              );
            }

            // Preserve existing values when fields are omitted
            const customerPrice =
              plan.customerPrice !== undefined
                ? plan.customerPrice
                : Number(existing.customer_price);

            const defaultCommission =
              plan.defaultCommission !== undefined
                ? plan.defaultCommission
                : Number(existing.default_commission);

            if (defaultCommission > customerPrice) {
              throw new Error(
                `Commission cannot exceed customer price for ${tier} - ${plan.duration}.`,
              );
            }

            const updateData: Record<string, any> = {
              updated_at: new Date(),
            };

            if (plan.customerPrice !== undefined) {
              updateData.customer_price = plan.customerPrice;
            }

            if (plan.defaultCommission !== undefined) {
              updateData.default_commission = plan.defaultCommission;
            }

            if (plan.isActive !== undefined) {
              updateData.is_active = plan.isActive;
            }

            if (currency !== undefined) {
              updateData.currency = currency;
            }

            // Update only submitted fields
            await trx("membership_plan_prices")
              .where("id", existing.id)
              .update(updateData);

            updatedCount++;

            const newValues = {
              customerPrice,
              defaultCommission,
              currency: currency ?? existing.currency,
              isActive: plan.isActive ?? existing.is_active,
            };

            const oldValues = {
              customerPrice: Number(existing.customer_price),
              defaultCommission: Number(existing.default_commission),
              currency: existing.currency,
              isActive: existing.is_active,
            };

            updatedPlans.push({
              id: existing.id,
              tier,
              duration: plan.duration,
              oldValues,
              newValues,
            });
          }
        }

        return {
          updatedCount,
          updatedPlans,
        };
      });

      for (const plan of result.updatedPlans) {
        const changes = Object.keys(plan.newValues)
          .filter((key) => plan.oldValues[key] !== plan.newValues[key])
          .map(
            (key) => `${key}: ${plan.oldValues[key]} → ${plan.newValues[key]}`,
          );

        if (changes.length === 0) continue;

        await logAdminActivity({
          adminUserId: getAdminActivityUserId(ctx),
          category: "global_pricing",
          actionType: "update",
          entityName: "Membership Plan Pricing",
          entityId: plan.id,
          description: `Updated ${plan.tier} ${
            plan.duration
          } pricing. Changes: ${changes.join("; ")}`,
        });
      }

      ctx.body = {
        data: result.updatedPlans,
      };
    } catch (error) {
      strapi.log.error("Membership pricing update error:", error);

      return ctx.badRequest(
        error.message || "Unable to update membership pricing.",
      );
    }
  },
}));
