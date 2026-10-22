import { createMembershipOrder } from "../../../utils/payment";

const CLIENT_TABLE = "client_details";
const USER_TABLE = "up_users";
const CLIENT_USER_LINK_TABLE = "up_users_client_detail_lnk";

const LOCAL_PLAN_TABLE = "local_membership_plans";
const LOCAL_PLAN_OWNER_LINK_TABLE = "local_membership_plans_club_owner_lnk";
const CLUB_OWNER_TABLE = "club_owners";

const OUTDOOR_PLAN_TABLE = "outdoor_membership_plans";
const LOCAL_SUB_TABLE = "local_subscriptions";
const OUTDOOR_SUB_TABLE = "outdoor_subscriptions";

const LOCAL_SUB_CLIENT_LINK_TABLE =
  "local_subscriptions_client_detail_lnk";
const LOCAL_SUB_PLAN_LINK_TABLE =
  "local_subscriptions_local_membership_plan_lnk";

const OUTDOOR_SUB_CLIENT_LINK_TABLE =
  "outdoor_subscriptions_client_detail_lnk";
const OUTDOOR_SUB_PLAN_LINK_TABLE =
  "outdoor_subscriptions_outdoor_membership_plan_lnk";

type SubscriptionType = "local" | "outdoor" | "both";

function normalizeRole(user: any): string {
  const role = user?.role;
  const value =
    typeof role === "string" ? role : role?.name ?? role?.type ?? "";

  return String(value).toLowerCase().replace(/[\s_-]/g, "");
}

function isValidPlanDate(validUpto: unknown): boolean {
  if (typeof validUpto !== "string" || !validUpto.trim()) {
    return false;
  }

  const value = validUpto.trim();

  if (value.toLowerCase() === "unlimited") {
    return true;
  }

  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return false;
  }

  const today = new Date();
  const todayUtc = Date.UTC(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );

  return parsed.getTime() >= todayUtc;
}

async function findPlan(
  table: string,
  identifier: unknown,
): Promise<any | null> {
  if (typeof identifier !== "string" && typeof identifier !== "number") {
    return null;
  }

  const value = String(identifier).trim();
  if (!value) return null;

  return strapi.db.connection(table)
    .where(function () {
      this.where("document_id", value);

      if (/^\d+$/.test(value)) {
        this.orWhere("id", Number(value));
      }
    })
    .first();
}

async function findClientByUserId(userId: number): Promise<any | null> {
  const knex = strapi.db.connection;

  return knex(`${CLIENT_TABLE} as c`)
    .join(
      `${CLIENT_USER_LINK_TABLE} as l`,
      "l.client_detail_id",
      "c.id",
    )
    .where("l.user_id", userId)
    .select(
      "c.id",
      "c.document_id",
      "c.client_id",
      "c.name",
      "c.email",
    )
    .first();
}

async function findClubOwnerForLocalPlan(
  localPlanId: number,
): Promise<any | null> {
  const knex = strapi.db.connection;

  return knex(`${LOCAL_PLAN_OWNER_LINK_TABLE} as l`)
    .join(CLUB_OWNER_TABLE + " as c", "c.id", "l.club_owner_id")
    .where("l.local_membership_plan_id", localPlanId)
    .select(
      "c.id",
      "c.document_id",
      "c.owner_name",
      "c.club_name",
    )
    .first();
}

async function hasActiveLocalSubscription(
  clientId: number,
  planId: number,
): Promise<boolean> {
  const knex = strapi.db.connection;
  const today = new Date().toISOString().slice(0, 10);

  const result = await knex(`${LOCAL_SUB_TABLE} as s`)
    .join(
      `${LOCAL_SUB_CLIENT_LINK_TABLE} as cl`,
      "cl.local_subscription_id",
      "s.id",
    )
    .join(
      `${LOCAL_SUB_PLAN_LINK_TABLE} as pl`,
      "pl.local_subscription_id",
      "s.id",
    )
    .where("cl.client_detail_id", clientId)
    .where("pl.local_membership_plan_id", planId)
    .where("s.subscription_status", "active")
    .where(function () {
      this.whereNull("s.end_date").orWhere("s.end_date", ">=", today);
    })
    .first();

  return Boolean(result);
}

async function hasActiveOutdoorSubscription(
  clientId: number,
  planId: number,
): Promise<boolean> {
  const knex = strapi.db.connection;

  const result = await knex(`${OUTDOOR_SUB_TABLE} as s`)
    .join(
      `${OUTDOOR_SUB_CLIENT_LINK_TABLE} as cl`,
      "cl.outdoor_subscription_id",
      "s.id",
    )
    .join(
      `${OUTDOOR_SUB_PLAN_LINK_TABLE} as pl`,
      "pl.outdoor_subscription_id",
      "s.id",
    )
    .where("cl.client_detail_id", clientId)
    .where("pl.outdoor_membership_plan_id", planId)
    .where("s.subscription_status", "active")
    .where("s.remaining_visits", ">", 0)
    .first();

  return Boolean(result);
}

export default {
  async buy(ctx) {
    try {
      // 1. Authenticate the user.
      const user = ctx.state.user;

      if (!user?.id) {
        return ctx.unauthorized("Please log in first.");
      }

      // 2. Verify Client role.
      if (normalizeRole(user) !== "client") {
        return ctx.forbidden("Only clients can purchase memberships.");
      }

      // 3. Read the request.
      const body = ctx.request.body?.data ?? ctx.request.body ?? {};

      const localIdentifier = body.local_membership_plan;
      const outdoorIdentifier = body.outdoor_membership_plan;

      const wantsLocal =
        localIdentifier !== undefined &&
        localIdentifier !== null &&
        String(localIdentifier).trim() !== "";

      const wantsOutdoor =
        outdoorIdentifier !== undefined &&
        outdoorIdentifier !== null &&
        String(outdoorIdentifier).trim() !== "";

      if (!wantsLocal && !wantsOutdoor) {
        return ctx.badRequest(
          "Provide local_membership_plan, outdoor_membership_plan, or both.",
        );
      }

      const subscriptionType: SubscriptionType =
        wantsLocal && wantsOutdoor
          ? "both"
          : wantsLocal
            ? "local"
            : "outdoor";

      // 4. Find the client using the actual user-client linking table.
      const client = await findClientByUserId(user.id);

      if (!client?.id || !client?.document_id) {
        return ctx.badRequest(
          "Client profile not found. Please complete client onboarding.",
        );
      }

      const knex = strapi.db.connection;

      let localPlan: any = null;
      let outdoorPlan: any = null;
      let clubOwner: any = null;

      // 5. Fetch and validate the local plan.
      if (wantsLocal) {
        localPlan = await findPlan(LOCAL_PLAN_TABLE, localIdentifier);

        if (!localPlan) {
          return ctx.badRequest("Local membership plan not found.");
        }

        if (localPlan.is_active !== true) {
          return ctx.badRequest(
            "The selected local membership plan is inactive.",
          );
        }

        if (!isValidPlanDate(localPlan.valid_upto)) {
          return ctx.badRequest(
            "The selected local membership plan has expired or has an invalid validUpto value.",
          );
        }

        if (
          !Number.isFinite(Number(localPlan.price)) ||
          Number(localPlan.price) <= 0
        ) {
          return ctx.badRequest(
            "The local membership plan has an invalid price.",
          );
        }

        // The owner relation is stored in a linking table, not
        // local_membership_plans.club_owner_id.
        clubOwner = await findClubOwnerForLocalPlan(localPlan.id);

        if (!clubOwner) {
          return ctx.badRequest(
            "The local membership plan has no associated club owner.",
          );
        }

        const alreadySubscribed = await hasActiveLocalSubscription(
          client.id,
          localPlan.id,
        );

        if (alreadySubscribed) {
          return ctx.badRequest(
            "You already have an active subscription for this local membership plan.",
          );
        }
      }

      // 6. Fetch and validate the outdoor plan.
      if (wantsOutdoor) {
        outdoorPlan = await findPlan(
          OUTDOOR_PLAN_TABLE,
          outdoorIdentifier,
        );

        if (!outdoorPlan) {
          return ctx.badRequest("Outdoor membership plan not found.");
        }

        if (outdoorPlan.is_active !== true) {
          return ctx.badRequest(
            "The selected outdoor membership plan is inactive.",
          );
        }

        if (!isValidPlanDate(outdoorPlan.valid_upto)) {
          return ctx.badRequest(
            "The selected outdoor membership plan has expired or has an invalid validUpto value.",
          );
        }

        if (
          !Number.isFinite(Number(outdoorPlan.price)) ||
          Number(outdoorPlan.price) <= 0
        ) {
          return ctx.badRequest(
            "The outdoor membership plan has an invalid price.",
          );
        }

        const visits = Number(outdoorPlan.visit_allowed);

        if (!Number.isInteger(visits) || visits <= 0) {
          return ctx.badRequest(
            "The outdoor membership plan has an invalid visit allowance.",
          );
        }

        const alreadySubscribed = await hasActiveOutdoorSubscription(
          client.id,
          outdoorPlan.id,
        );

        if (alreadySubscribed) {
          return ctx.badRequest(
            "You already have an active outdoor pass for this plan.",
          );
        }
      }

      // 7. Calculate the amount from database prices.
      const localPrice = wantsLocal ? Number(localPlan.price) : 0;
      const outdoorPrice = wantsOutdoor ? Number(outdoorPlan.price) : 0;

      const amountRupees = Number((localPrice + outdoorPrice).toFixed(2));

      if (!Number.isFinite(amountRupees) || amountRupees <= 0) {
        return ctx.badRequest("Invalid total membership amount.");
      }

      // 8. Create one Razorpay Payment Link and one pending payment.
      const payment = await createMembershipOrder({
        amountRupees,
        clientId: client.id,
        clientDocumentId: client.document_id,
        localPlanDocumentId: wantsLocal
          ? localPlan.document_id
          : undefined,
        outdoorPlanDocumentId: wantsOutdoor
          ? outdoorPlan.document_id
          : undefined,
        subscriptionType,
      });

      // 9. Return checkout details.
      ctx.status = 200;
      ctx.body = {
        message: "Membership checkout created successfully.",
        data: {
          ...payment,
          subscriptionType,
          plans: {
            local: wantsLocal
              ? {
                  documentId: localPlan.document_id,
                  planName: localPlan.plan_name,
                  price: localPrice,
                  clubOwner: {
                    id: clubOwner.id,
                    documentId: clubOwner.document_id,
                    ownerName: clubOwner.owner_name,
                    clubName: clubOwner.club_name,
                  },
                }
              : null,
            outdoor: wantsOutdoor
              ? {
                  documentId: outdoorPlan.document_id,
                  planName: outdoorPlan.plan_name,
                  price: outdoorPrice,
                  visitAllowed: Number(outdoorPlan.visit_allowed),
                }
              : null,
          },
          totalAmount: amountRupees,
        },
      };
    } catch (error) {
      strapi.log.error("Membership checkout failed", error);

      ctx.status = 500;
      ctx.body = {
        message: "Unable to create membership checkout.",
      };
    }
  },
};