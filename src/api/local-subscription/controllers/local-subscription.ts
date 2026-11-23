import { factories } from "@strapi/strapi";
import { Context } from "koa";
import { sendTwilioOfflineMemberInvite } from "../../../services/twilio-sms";
import {
  sendClubOwnerPayAtGymNotification,
  sendClientMembershipDecisionPush,
} from "../../../utils/club-owner-push-notification";

const LOCAL_SUB_UID = "api::local-subscription.local-subscription" as any;
const LOCAL_PLAN_UID =
  "api::local-membership-plan.local-membership-plan" as any;
const CLIENT_UID = "api::client-detail.client-detail" as any;
const CLUB_OWNER_UID = "api::club-owner.club-owner" as any;
const MEMBERSHIP_PLAN_PRICE_UID =
  "api::membership-plan-price.membership-plan-price" as any;
import { createMembershipOrder } from "../../../utils/razorpay";

/* ---------- AUTH USER HELPER ---------- */
async function getAuthUser(ctx: Context) {
  let user = ctx.state?.user;
  if (user?.id) return user;

  const authHeader = ctx.request?.header?.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    try {
      const jwtService = strapi.plugin("users-permissions")?.service("jwt");
      if (jwtService?.verify) {
        const payload = await jwtService.verify(token);
        if (payload?.id) {
          user = await strapi.db
            .query("plugin::users-permissions.user")
            .findOne({
              where: { id: payload.id },
              populate: { role: true },
            });
          if (user) {
            ctx.state.user = user;
            return user;
          }
        }
      }
    } catch (_) {}
  }

  return null;
}

function getISTDateString(offsetDays: number = 0): string {
  const now = new Date();
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  const target = new Date(
    now.getTime() + IST_OFFSET + offsetDays * 24 * 60 * 60 * 1000
  );
  const year = target.getUTCFullYear();
  const month = String(target.getUTCMonth() + 1).padStart(2, "0");
  const day = String(target.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatTimeAgo(dateVal: any): string {
  if (!dateVal) return "";
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return "";
  const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diffSec < 60) return "Just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min${diffMin > 1 ? "s" : ""} ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`;
}

/* ---------- ROLE HELPER ---------- */
async function getUserRole(user: any): Promise<string> {
  if (!user) return "";
  if (user._cachedRole) return user._cachedRole;

  if (user.role?.name || user.role?.type) {
    const role =
      user.role.name?.toLowerCase().replace(/[\s_-]+/g, "") ||
      user.role.type?.toLowerCase().replace(/[\s_-]+/g, "") ||
      "";
    user._cachedRole = role;
    return role;
  }

  const fullUser: any = await strapi.db
    .query("plugin::users-permissions.user")
    .findOne({
      where: { id: user.id },
      select: ["id"],
      populate: {
        role: {
          select: ["id", "name", "type"],
        },
      },
    });

  const role =
    fullUser?.role?.name?.toLowerCase().replace(/[\s_-]+/g, "") ||
    fullUser?.role?.type?.toLowerCase().replace(/[\s_-]+/g, "") ||
    "";
  user._cachedRole = role;
  return role;
}

/* ---------- HELPER: EXTRACT LOGO URL ---------- */
function extractLogoUrl(logo: any): string | null {
  if (!logo) return null;
  if (typeof logo === "string") return logo;
  return (
    logo.url || logo.formats?.thumbnail?.url || logo.formats?.small?.url || null
  );
}

/* ---------- HELPER: FORMAT CLUB OWNER ---------- */
function formatClubOwner(owner: any): any {
  if (!owner) return null;
  return {
    id: owner.id,
    documentId: owner.documentId,
    clubId: owner.clubId,
    ownerName: owner.ownerName,
    clubName: owner.clubName,
    phoneNumber: owner.phoneNumber,
    email: owner.email,
    clubAddress: owner.clubAddress,
    city: owner.city,
    state: owner.state,
    pincode: owner.pincode,
    logo: extractLogoUrl(owner.logo),
  };
}

/* ---------- HELPER: GET CLIENT DETAIL FOR AUTH USER ---------- */
async function getClientDetailForUser(user: any) {
  if (!user) return null;
  const userObj = typeof user === "object" ? user : null;
  const userId = userObj ? userObj.id : user;

  if (userObj?._cachedClientDetail) {
    return userObj._cachedClientDetail;
  }

  // 1. Direct lookup by user foreign key (fast indexed query)
  let client: any = await strapi.db.query(CLIENT_UID).findOne({
    where: { user: userId },
    select: ["id", "documentId", "clientId", "name", "phoneNumber", "email"],
  });

  // 2. Fallback via user table
  if (!client) {
    const userWithDetail: any = await strapi.db
      .query("plugin::users-permissions.user")
      .findOne({
        where: { id: userId },
        select: ["id"],
        populate: {
          client_detail: {
            select: [
              "id",
              "documentId",
              "clientId",
              "name",
              "phoneNumber",
              "email",
            ],
          },
        },
      });

    client = userWithDetail?.client_detail || null;
  }

  if (userObj && client) {
    userObj._cachedClientDetail = client;
  }

  return client || null;
}

/* ---------- HELPER: GET CLUB OWNER FOR AUTH USER ---------- */
async function getClubOwnerForUser(user: any) {
  if (!user) return null;
  const userObj = typeof user === "object" ? user : null;
  const userId = userObj ? userObj.id : user;

  if (userObj?._cachedClubOwner) {
    return userObj._cachedClubOwner;
  }

  // 1. Direct query to club-owner by user relation (no logo populated)
  let owner: any = await strapi.db.query(CLUB_OWNER_UID).findOne({
    where: { user: userId },
    select: ["id", "documentId", "clubId", "clubName", "ownerName"],
  });

  // 2. Fallback via user table
  if (!owner) {
    const userWithDetail: any = await strapi.db
      .query("plugin::users-permissions.user")
      .findOne({
        where: { id: userId },
        select: ["id"],
        populate: {
          club_owner: {
            select: ["id", "documentId", "clubId", "clubName", "ownerName"],
          },
        },
      });

    owner = userWithDetail?.club_owner || null;
  }

  if (userObj && owner) {
    userObj._cachedClubOwner = owner;
  }

  return owner || null;
}

/* ---------- HELPER: RESOLVE CLIENT DETAIL ---------- */
async function resolveClientDetail(identifier: string | number) {
  if (!identifier) return null;
  const rawStr = String(identifier).trim();
  const isNumeric = !isNaN(Number(rawStr)) && /^\d+$/.test(rawStr);

  const whereConditions: any[] = [
    { documentId: rawStr },
    { clientId: rawStr },
    { phoneNumber: rawStr },
    { email: rawStr },
  ];

  if (isNumeric) {
    whereConditions.push({ id: Number(rawStr) });
  }

  const client = await strapi.db.query(CLIENT_UID).findOne({
    where: {
      $or: whereConditions,
    },
    select: ["id", "documentId", "clientId", "name", "phoneNumber", "email"],
  });

  return client || null;
}

/* ---------- HELPER: RESOLVE CLUB OWNER ---------- */
async function resolveClubOwner(identifier: string | number) {
  if (!identifier) return null;
  const rawStr = String(identifier).trim();
  const isNumeric = !isNaN(Number(rawStr)) && /^\d+$/.test(rawStr);

  // 1. Try Documents API if available
  if ((strapi as any).documents && !isNumeric) {
    try {
      const docOwner = await (strapi as any).documents(CLUB_OWNER_UID).findOne({
        documentId: rawStr,
        populate: {
          logo: {
            fields: ["url", "formats"],
          },
        },
      });
      if (docOwner) return docOwner;
    } catch (_) {}
  }

  // 2. Query via db layer with numeric ID and string support
  const whereConditions: any[] = [{ documentId: rawStr }, { clubId: rawStr }];

  if (isNumeric) {
    whereConditions.push({ id: Number(rawStr) });
  }

  const owner = await strapi.db.query(CLUB_OWNER_UID).findOne({
    where: {
      $or: whereConditions,
    },
    select: [
      "id",
      "documentId",
      "clubId",
      "clubName",
      "ownerName",
      "phoneNumber",
      "email",
      "clubAddress",
      "city",
      "state",
      "pincode",
    ],
    populate: {
      logo: {
        select: ["url", "formats"],
      },
    },
  });

  return owner || null;
}

/* ---------- HELPER: RESOLVE LOCAL PLAN ---------- */
async function resolveLocalPlan(identifier: string | number) {
  if (!identifier) return null;
  const rawStr = String(identifier).trim();
  const isNumeric = !isNaN(Number(rawStr)) && /^\d+$/.test(rawStr);

  // 1. Try Documents API
  if ((strapi as any).documents && !isNumeric) {
    try {
      const planDoc = await (strapi as any).documents(LOCAL_PLAN_UID).findOne({
        documentId: rawStr,
        populate: {
          club_owner: true,
        },
      });
      if (planDoc) {
        if (
          planDoc.club_owner &&
          (!planDoc.club_owner.documentId || !planDoc.club_owner.id)
        ) {
          const ownerIdentifier =
            planDoc.club_owner.documentId ||
            planDoc.club_owner.id ||
            planDoc.club_owner;
          const fullOwner = await resolveClubOwner(ownerIdentifier);
          if (fullOwner) planDoc.club_owner = fullOwner;
        }
        return planDoc;
      }
    } catch (_) {}
  }

  // 2. Fallback via strapi.db.query
  const whereConditions: any[] = [{ documentId: rawStr }];
  if (isNumeric) {
    whereConditions.push({ id: Number(rawStr) });
  }

  const plan: any = await strapi.db.query(LOCAL_PLAN_UID).findOne({
    where: isNumeric ? { $or: whereConditions } : { documentId: rawStr },
    populate: ["club_owner"],
  });

  if (!plan) return null;

  if (plan.club_owner && (!plan.club_owner.documentId || !plan.club_owner.id)) {
    const ownerIdentifier =
      plan.club_owner.documentId || plan.club_owner.id || plan.club_owner;
    const fullOwner = await resolveClubOwner(ownerIdentifier);
    if (fullOwner) {
      plan.club_owner = fullOwner;
    }
  }

  return plan;
}

/* ---------- HELPER: CALCULATE END DATE ---------- */
function calculateEndDate(startDate: Date, monthDuration: number): string {
  const endDate = new Date(startDate.getTime());
  endDate.setMonth(endDate.getMonth() + monthDuration);
  return endDate.toISOString().split("T")[0]; // YYYY-MM-DD
}

/* ---------- HELPER: PLAN TITLE & DURATION ---------- */
function getPlanTitle(plan: any): string {
  if (!plan) return "Membership";
  if (plan.planName) return plan.planName;
  const months =
    plan.durationMonths ||
    (plan.duration === "monthly"
      ? 1
      : plan.duration === "six_months"
      ? 6
      : plan.duration === "twelve_months"
      ? 12
      : null);
  const tierName = plan.membership_tier?.name
    ? `${plan.membership_tier.name.charAt(0).toUpperCase() + plan.membership_tier.name.slice(1)} `
    : "";
  if (months === 1) return `${tierName}1 Month`;
  if (months === 6) return `${tierName}6 Months`;
  if (months === 12) return `${tierName}1 Year`;
  if (months) return `${tierName}${months} Months`;
  if (plan.duration) return `${tierName}${plan.duration}`;
  return "Membership";
}

function getPlanDurationMonths(plan: any): number {
  if (!plan) return 1;
  if (plan.durationMonths && Number(plan.durationMonths) > 0) {
    return Number(plan.durationMonths);
  }
  if (plan.monthDuration && Number(plan.monthDuration) > 0) {
    return Number(plan.monthDuration);
  }
  if (plan.duration === "monthly") return 1;
  if (plan.duration === "six_months") return 6;
  if (plan.duration === "twelve_months") return 12;
  return 1;
}

function getPlanPriceAmount(plan: any): number | null {
  if (!plan) return null;
  if (plan.customerPrice != null) return Number(plan.customerPrice);
  if (plan.price != null) return Number(plan.price);
  return null;
}

/* ---------- HELPER: RESOLVE MEMBERSHIP PLAN (PRICE FIRST) ---------- */
async function resolveMembershipPlanPrice(identifier: string | number) {
  if (!identifier) return null;
  const rawStr = String(identifier).trim();
  const isNumeric = !isNaN(Number(rawStr)) && /^\d+$/.test(rawStr);

  // 1. Try Documents API for membership-plan-price
  if ((strapi as any).documents && !isNumeric) {
    try {
      const doc = await (strapi as any)
        .documents(MEMBERSHIP_PLAN_PRICE_UID)
        .findOne({
          documentId: rawStr,
          populate: {
            membership_tier: true,
          },
        });
      if (doc) return { ...doc, isPlanPrice: true };
    } catch (_) {}
  }

  // 2. Query DB for membership-plan-price
  try {
    const plan = await strapi.db.query(MEMBERSHIP_PLAN_PRICE_UID).findOne({
      where: isNumeric
        ? { $or: [{ id: Number(rawStr) }, { documentId: rawStr }] }
        : { documentId: rawStr },
      populate: {
        membership_tier: true,
      },
    });
    if (plan) return { ...plan, isPlanPrice: true };
  } catch (_) {}

  // 3. Fallback to local_membership_plan if legacy ID was supplied
  const localPlan = await resolveLocalPlan(identifier);
  if (localPlan) return { ...localPlan, isPlanPrice: false };

  return null;
}

export default factories.createCoreController(
  "api::local-subscription.local-subscription",
  ({ strapi }) => ({
    /* =======================================================
       MANUAL / OFFLINE MEMBERSHIP CREATION (CLUB OWNER / ADMIN)
       membershipType: "local"
       startDate: automatically set to now
       endDate: calculated based on plan.monthDuration
       - ClubOwner: identity extracted from auth token, can only create for their own gym
       - Admin/SuperAdmin: can specify club_owner in payload or use plan's club_owner
    ======================================================= */
    async create(ctx) {
      try {
        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        const isAdmin = roleName === "admin" || roleName === "superadmin";

        if (roleName !== "clubowner" && !isAdmin) {
          return ctx.forbidden(
            "Access denied. Only ClubOwner, Admin, or SuperAdmin can create offline memberships.",
          );
        }

        const body = ctx.request.body;
        const payload = body?.data ? body.data : body || {};

        const { client_detail, local_membership_plan, club_owner, ownerId } =
          payload;

        if (!client_detail) {
          return ctx.badRequest(
            "client_detail is required (provide documentId, clientId, phone, or email)",
          );
        }

        if (!local_membership_plan) {
          return ctx.badRequest(
            "local_membership_plan is required (provide plan documentId)",
          );
        }

        const clientRecord = await resolveClientDetail(client_detail);
        if (!clientRecord) {
          return ctx.notFound(`Client matching '${client_detail}' not found.`);
        }

        const plan = await resolveLocalPlan(local_membership_plan);
        if (!plan) {
          return ctx.notFound("Local membership plan not found");
        }

        let targetClubOwnerId: number;
        let targetClubOwnerDocId: string;

        if (roleName === "clubowner") {
          const ownerRecord = await getClubOwnerForUser(user);
          if (!ownerRecord || !ownerRecord.documentId) {
            return ctx.badRequest(
              "Club owner profile not found for this account.",
            );
          }

          const planOwnerDocId = plan.club_owner?.documentId;

          // Enforce ownership: club owner can only assign memberships of their own gym
          if (
            planOwnerDocId &&
            String(planOwnerDocId) !== String(ownerRecord.documentId)
          ) {
            return ctx.forbidden(
              "Access denied. You can only assign membership plans belonging to your own club.",
            );
          }

          targetClubOwnerId = ownerRecord.id;
          targetClubOwnerDocId = ownerRecord.documentId;
        } else {
          // Admin / SuperAdmin: Owner detail is not required in payload because it is attached to the plan
          if (!plan.club_owner) {
            return ctx.badRequest(
              "This membership plan is not associated with any club.",
            );
          }

          let planOwner = plan.club_owner;
          if (!planOwner.documentId || !planOwner.id) {
            const resolved = await resolveClubOwner(
              planOwner.documentId || planOwner.id || planOwner,
            );
            if (resolved) {
              planOwner = resolved;
            }
          }

          const providedOwner = club_owner || ownerId;
          if (providedOwner) {
            const resolvedOwner = await resolveClubOwner(providedOwner);
            if (!resolvedOwner) {
              return ctx.notFound(`Club owner '${providedOwner}' not found.`);
            }

            const planOwnerDocId = planOwner?.documentId;
            if (
              planOwnerDocId &&
              String(planOwnerDocId) !== String(resolvedOwner.documentId)
            ) {
              return ctx.badRequest(
                "The selected local_membership_plan does not belong to the specified club_owner.",
              );
            }
          }

          targetClubOwnerId = planOwner.id || planOwner;
          targetClubOwnerDocId = planOwner.documentId;
        }

        // Ensure both documentId and numeric ID exist for target club owner
        if (!targetClubOwnerDocId && targetClubOwnerId) {
          const resolved = await resolveClubOwner(targetClubOwnerId);
          if (resolved?.documentId) {
            targetClubOwnerDocId = resolved.documentId;
          }
        }
        if (!targetClubOwnerId && targetClubOwnerDocId) {
          const resolved = await resolveClubOwner(targetClubOwnerDocId);
          if (resolved?.id) {
            targetClubOwnerId = resolved.id;
          }
        }

        const startDate = new Date();
        const monthDuration = Number(plan.monthDuration) || 1;
        const endDate = calculateEndDate(startDate, monthDuration);

        const clientId = clientRecord.id;
        const clientDocId = clientRecord.documentId;
        const planId = plan.id;
        const planDocId = plan.documentId;

        /* ---------- CHECK EXISTING ACTIVE SUBSCRIPTION ---------- */
        const existingSub: any = await strapi.db.query(LOCAL_SUB_UID).findOne({
          where: {
            $and: [
              {
                $or: [
                  { client_detail: clientId },
                  { client_detail: { id: clientId } },
                  { client_detail: { documentId: clientDocId } },
                ],
              },
              {
                $or: [
                  { local_membership_plan: planId },
                  { local_membership_plan: { id: planId } },
                  { local_membership_plan: { documentId: planDocId } },
                ],
              },
              { subscriptionStatus: "active" },
            ],
          },
          orderBy: { id: "desc" },
        });

        if (existingSub) {
          const isDatePassed =
            existingSub.endDate &&
            new Date(existingSub.endDate).setHours(23, 59, 59, 999) <
              Date.now();

          if (isDatePassed) {
            try {
              if ((strapi as any).documents && existingSub.documentId) {
                await (strapi as any).documents(LOCAL_SUB_UID).update({
                  documentId: existingSub.documentId,
                  data: { subscriptionStatus: "expired" },
                });
              } else {
                await strapi.db.query(LOCAL_SUB_UID).update({
                  where: { id: existingSub.id },
                  data: { subscriptionStatus: "expired" },
                });
              }
            } catch (_) {}
          } else {
            return ctx.badRequest(
              "This client already has an active subscription for this membership plan.",
            );
          }
        }

        /* ---------- CREATE LOCAL SUBSCRIPTION ---------- */
        let createdSub: any = null;

        if ((strapi as any).documents) {
          try {
            createdSub = await (strapi as any).documents(LOCAL_SUB_UID).create({
              data: {
                client_detail: clientDocId,
                club_owner: targetClubOwnerDocId,
                local_membership_plan: planDocId,
                membershipType: "local",
                startDate: startDate.toISOString(),
                endDate,
                subscriptionStatus: "active",
              },
              populate: {
                club_owner: true,
                local_membership_plan: true,
                client_detail: true,
              },
            });
          } catch (docErr) {
            strapi.log.warn("Documents API create fallback in create:", docErr);
          }
        }

        if (!createdSub) {
          createdSub = await strapi.entityService.create(LOCAL_SUB_UID, {
            data: {
              client_detail: clientId,
              club_owner: targetClubOwnerId,
              local_membership_plan: planId,
              membershipType: "local",
              startDate: startDate.toISOString(),
              endDate,
              subscriptionStatus: "active",
            },
            populate: {
              club_owner: true,
              local_membership_plan: true,
              client_detail: true,
            },
          });
        }

        // Relational guarantee: ensure relations are linked and populated
        if (
          (!createdSub?.club_owner || !createdSub?.local_membership_plan) &&
          createdSub?.id
        ) {
          await strapi.db.query(LOCAL_SUB_UID).update({
            where: { id: createdSub.id },
            data: {
              club_owner: targetClubOwnerId,
              local_membership_plan: planId,
              client_detail: clientId,
            },
          });

          createdSub = await strapi.db.query(LOCAL_SUB_UID).findOne({
            where: { id: createdSub.id },
            populate: {
              club_owner: true,
              local_membership_plan: true,
              client_detail: true,
            },
          });
        }

        if (createdSub?.club_owner) {
          createdSub.club_owner = formatClubOwner(createdSub.club_owner);
        }

        // 📝 Log Activity (only for club owners, NOT admin or superadmin)
        if (!isAdmin && roleName === "clubowner") {
          try {
            const activityLogService: any = strapi.service(
              "api::activity-log.activity-log",
            );
            if (activityLogService?.createActivityLog) {
              await activityLogService.createActivityLog({
                actorType: "club_owner",
                actorId: targetClubOwnerDocId || targetClubOwnerId,
                actionType: "create",
                entityName: "Local Subscription",
                entityId: createdSub?.documentId || createdSub?.id,
                description: `Assigned offline membership to client '${
                  clientRecord?.name || clientRecord?.clientId || "Client"
                }' for plan '${plan?.planName || "Membership"}'`,
              });
            }
          } catch (logErr) {
            strapi.log.warn(
              "[ActivityLog] Failed to log subscription creation:",
              logErr,
            );
          }
        }

        return ctx.send(
          {
            message:
              roleName === "clubowner"
                ? "Local membership created successfully by club owner"
                : "Local membership created successfully by admin",
            data: createdSub,
          },
          201,
        );
      } catch (error) {
        strapi.log.error("CREATE LOCAL SUBSCRIPTION ERROR:", error);
        return ctx.internalServerError("Failed to create local membership");
      }
    },

    /* =======================================================
       GET MY SUBSCRIPTIONS
       - Client: returns all their own local subscriptions
       - ClubOwner: returns all local subscriptions for their gym
    ======================================================= */
    async getMySubscriptions(ctx) {
      try {
        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        const { membershipType, subscriptionStatus } = ctx.query as any;

        const where: any = {};
        if (membershipType) {
          where.membershipType = membershipType;
        }
        if (subscriptionStatus) {
          where.subscriptionStatus = subscriptionStatus;
        }

        if (roleName === "client") {
          const clientRecord = await getClientDetailForUser(user);
          if (!clientRecord || !clientRecord.documentId) {
            return ctx.notFound("Client profile not found for this account");
          }

          where.client_detail = { documentId: clientRecord.documentId };

          const rawData: any[] = await strapi.db.query(LOCAL_SUB_UID).findMany({
            where,
            populate: {
              club_owner: {
                select: [
                  "id",
                  "documentId",
                  "clubId",
                  "clubName",
                  "ownerName",
                  "phoneNumber",
                  "email",
                  "clubAddress",
                  "city",
                  "state",
                  "pincode",
                ],
                populate: {
                  logo: {
                    select: ["url", "formats"],
                  },
                },
              },
              local_membership_plan: true,
            },
            orderBy: { id: "desc" },
          });

          const list = (Array.isArray(rawData) ? rawData : []).map(
            (item: any) => ({
              ...item,
              club_owner: item.club_owner
                ? formatClubOwner(item.club_owner)
                : null,
            }),
          );

          return ctx.send({
            total: list.length,
            data: list,
          });
        } else if (roleName === "clubowner") {
          const ownerRecord = await getClubOwnerForUser(user);
          if (!ownerRecord || !ownerRecord.documentId) {
            return ctx.notFound(
              "Club owner profile not found for this account",
            );
          }

          where.club_owner = { documentId: ownerRecord.documentId };

          const rawData: any[] = await strapi.db.query(LOCAL_SUB_UID).findMany({
            where,
            populate: {
              client_detail: {
                select: [
                  "id",
                  "documentId",
                  "clientId",
                  "name",
                  "phoneNumber",
                  "email",
                ],
              },
              local_membership_plan: true,
            },
            orderBy: { id: "desc" },
          });

          const list = Array.isArray(rawData) ? rawData : [];

          return ctx.send({
            total: list.length,
            data: list,
          });
        } else {
          return ctx.badRequest(
            "This endpoint is available for Client or ClubOwner roles.",
          );
        }
      } catch (error) {
        strapi.log.error("GET MY LOCAL SUBSCRIPTIONS ERROR:", error);
        return ctx.internalServerError("Failed to fetch subscriptions");
      }
    },

    /* =======================================================
       FIND ALL / FILTER LOCAL SUBSCRIPTIONS
    ======================================================= */
    async find(ctx) {
      try {
        const user = ctx.state.user;
        const roleName = user ? await getUserRole(user) : "";

        const {
          membershipType,
          subscriptionStatus,
          client_detail,
          club_owner,
        } = ctx.query as any;

        const where: any = {};

        if (membershipType) {
          where.membershipType = membershipType;
        }
        if (subscriptionStatus) {
          where.subscriptionStatus = subscriptionStatus;
        }

        // Role-based visibility enforcement
        if (roleName === "client") {
          const clientRecord = await getClientDetailForUser(user);
          if (clientRecord?.documentId) {
            where.client_detail = { documentId: clientRecord.documentId };
          }
        } else if (roleName === "clubowner") {
          const ownerRecord = await getClubOwnerForUser(user);
          if (ownerRecord?.documentId) {
            where.club_owner = { documentId: ownerRecord.documentId };
          }
        } else {
          // Admin / SuperAdmin filters
          if (client_detail) {
            const rawClient = String(client_detail).trim();
            where.client_detail = { documentId: rawClient };
          }
          if (club_owner) {
            const rawOwner = String(club_owner).trim();
            where.club_owner = { documentId: rawOwner };
          }
        }

        const rawData: any[] = await strapi.db.query(LOCAL_SUB_UID).findMany({
          where,
          populate: {
            club_owner: {
              select: [
                "id",
                "documentId",
                "clubId",
                "clubName",
                "ownerName",
                "phoneNumber",
                "email",
                "clubAddress",
                "city",
                "state",
                "pincode",
              ],
              populate: {
                logo: {
                  select: ["url", "formats"],
                },
              },
            },
            client_detail: {
              select: [
                "id",
                "documentId",
                "clientId",
                "name",
                "phoneNumber",
                "email",
              ],
            },
            local_membership_plan: true,
          },
          orderBy: { id: "desc" },
        });

        const list = (Array.isArray(rawData) ? rawData : []).map(
          (item: any) => ({
            ...item,
            club_owner: item.club_owner
              ? formatClubOwner(item.club_owner)
              : null,
          }),
        );

        return ctx.send({
          total: list.length,
          data: list,
        });
      } catch (error) {
        strapi.log.error("FIND LOCAL SUBSCRIPTIONS ERROR:", error);
        return ctx.internalServerError("Failed to fetch subscriptions");
      }
    },

    /* =======================================================
       GET SINGLE LOCAL SUBSCRIPTION
    ======================================================= */
    async findOne(ctx) {
      try {
        const { id } = ctx.params;

        if (id === "my-subscriptions" || id === "me") {
          return await (this as any).getMySubscriptions(ctx);
        }

        const documentId = String(id).trim();

        const entity: any = await strapi.db.query(LOCAL_SUB_UID).findOne({
          where: { documentId },
          populate: {
            club_owner: {
              select: [
                "id",
                "documentId",
                "clubId",
                "clubName",
                "ownerName",
                "phoneNumber",
                "email",
                "clubAddress",
                "city",
                "state",
                "pincode",
              ],
              populate: {
                logo: {
                  select: ["url", "formats"],
                },
              },
            },
            client_detail: {
              select: [
                "id",
                "documentId",
                "clientId",
                "name",
                "phoneNumber",
                "email",
              ],
            },
            local_membership_plan: true,
          },
        });

        if (!entity) {
          return ctx.notFound("Local subscription not found");
        }

        if (entity.club_owner) {
          entity.club_owner = formatClubOwner(entity.club_owner);
        }

        return ctx.send({
          data: entity,
        });
      } catch (error) {
        strapi.log.error("FIND ONE LOCAL SUBSCRIPTION ERROR:", error);
        return ctx.internalServerError("Failed to fetch subscription");
      }
    },

    /* =======================================================
       UPDATE LOCAL SUBSCRIPTION (STATUS / END DATE)
    ======================================================= */
    async update(ctx) {
      try {
        const { id } = ctx.params;
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        const isAdmin = roleName === "admin" || roleName === "superadmin";
        const documentId = String(id).trim();

        const existing: any = await strapi.db.query(LOCAL_SUB_UID).findOne({
          where: { documentId },
          select: ["id", "documentId", "subscriptionStatus", "endDate"],
          populate: {
            club_owner: {
              select: ["id", "documentId"],
            },
            client_detail: {
              select: ["id", "documentId", "name", "clientId"],
            },
            local_membership_plan: {
              select: ["id", "documentId", "planName"],
            },
          },
        });

        if (!existing) {
          return ctx.notFound("Local subscription not found");
        }

        if (roleName === "clubowner") {
          const ownerRecord = await getClubOwnerForUser(user);
          if (
            !ownerRecord ||
            existing.club_owner?.documentId !== ownerRecord.documentId
          ) {
            return ctx.forbidden(
              "Access denied. You can only manage subscriptions of your own club.",
            );
          }
        } else if (!isAdmin) {
          return ctx.forbidden(
            "Access denied. Only ClubOwner, Admin, or SuperAdmin can modify subscriptions.",
          );
        }

        const body = ctx.request.body;
        const payload = body?.data ? body.data : body || {};

        const { subscriptionStatus, endDate } = payload;
        const updateData: any = {};

        if (subscriptionStatus !== undefined) {
          updateData.subscriptionStatus = subscriptionStatus;
        }

        if (endDate !== undefined) {
          updateData.endDate = endDate;
        }

        let updated: any = null;

        if ((strapi as any).documents && existing.documentId) {
          try {
            updated = await (strapi as any).documents(LOCAL_SUB_UID).update({
              documentId: existing.documentId,
              data: updateData,
            });
          } catch (docErr) {
            strapi.log.warn("documents.update fallback in update:", docErr);
          }
        }

        if (!updated) {
          updated = await strapi.entityService.update(
            LOCAL_SUB_UID,
            existing.id,
            {
              data: updateData,
            },
          );
        }

        // 📝 Log Activity (only for club owners, NOT admin or superadmin)
        if (!isAdmin && roleName === "clubowner") {
          try {
            const activityLogService: any = strapi.service(
              "api::activity-log.activity-log",
            );
            if (activityLogService?.createActivityLog) {
              const ownerIdentifier =
                existing.club_owner?.documentId ||
                existing.club_owner?.id ||
                existing.club_owner;

              const changedDetails: string[] = [];

              if (
                updateData.subscriptionStatus !== undefined &&
                updateData.subscriptionStatus !== existing.subscriptionStatus
              ) {
                changedDetails.push(
                  `status: '${existing.subscriptionStatus ?? ""}' -> '${
                    updateData.subscriptionStatus
                  }'`,
                );
              }

              if (
                updateData.endDate !== undefined &&
                String(updateData.endDate) !== String(existing.endDate)
              ) {
                changedDetails.push(
                  `endDate: '${existing.endDate ?? ""}' -> '${
                    updateData.endDate
                  }'`,
                );
              }

              const clientName =
                existing.client_detail?.name ||
                existing.client_detail?.clientId ||
                "Client";
              const planName =
                existing.local_membership_plan?.planName || "Membership";

              const changeSummary =
                changedDetails.length > 0
                  ? ` (Changed: ${changedDetails.join(", ")})`
                  : "";

              await activityLogService.createActivityLog({
                actorType: "club_owner",
                actorId: ownerIdentifier,
                actionType: "update",
                entityName: "Local Subscription",
                entityId: existing.documentId || existing.id,
                description: `Updated subscription of client '${clientName}' for plan '${planName}'${changeSummary}`,
              });
            }
          } catch (logErr) {
            strapi.log.warn(
              "[ActivityLog] Failed to log subscription update:",
              logErr,
            );
          }
        }

        return ctx.send({
          message: "Local subscription updated successfully",
          data: updated,
        });
      } catch (error) {
        strapi.log.error("UPDATE LOCAL SUBSCRIPTION ERROR:", error);
        return ctx.internalServerError("Failed to update subscription");
      }
    },

    /* =======================================================
       DELETE LOCAL SUBSCRIPTION
    ======================================================= */
    async delete(ctx) {
      try {
        const { id } = ctx.params;
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        const isAdmin = roleName === "admin" || roleName === "superadmin";
        const documentId = String(id).trim();

        const existing: any = await strapi.db.query(LOCAL_SUB_UID).findOne({
          where: { documentId },
          select: ["id", "documentId"],
          populate: {
            club_owner: {
              select: ["id", "documentId"],
            },
            client_detail: {
              select: ["id", "documentId", "name", "clientId"],
            },
            local_membership_plan: {
              select: ["id", "documentId", "planName"],
            },
          },
        });

        if (!existing) {
          return ctx.notFound("Local subscription not found");
        }

        if (roleName === "clubowner") {
          const ownerRecord = await getClubOwnerForUser(user);
          if (
            !ownerRecord ||
            existing.club_owner?.documentId !== ownerRecord.documentId
          ) {
            return ctx.forbidden(
              "Access denied. You can only delete subscriptions of your own club.",
            );
          }
        } else if (!isAdmin) {
          return ctx.forbidden(
            "Access denied. Only ClubOwner, Admin, or SuperAdmin can delete subscriptions.",
          );
        }

        if ((strapi as any).documents && existing.documentId) {
          await (strapi as any).documents(LOCAL_SUB_UID).delete({
            documentId: existing.documentId,
          });
        } else {
          await strapi.entityService.delete(LOCAL_SUB_UID, existing.id);
        }

        // 📝 Log Activity (only for club owners, NOT admin or superadmin)
        if (!isAdmin && roleName === "clubowner") {
          try {
            const activityLogService: any = strapi.service(
              "api::activity-log.activity-log",
            );
            if (activityLogService?.createActivityLog) {
              const ownerIdentifier =
                existing.club_owner?.documentId ||
                existing.club_owner?.id ||
                existing.club_owner;

              const clientName =
                existing.client_detail?.name ||
                existing.client_detail?.clientId ||
                "Client";
              const planName =
                existing.local_membership_plan?.planName || "Membership";

              await activityLogService.createActivityLog({
                actorType: "club_owner",
                actorId: ownerIdentifier,
                actionType: "delete",
                entityName: "Local Subscription",
                entityId: existing.documentId || existing.id,
                description: `Deleted subscription of client '${clientName}' for plan '${planName}'`,
              });
            }
          } catch (logErr) {
            strapi.log.warn(
              "[ActivityLog] Failed to log subscription deletion:",
              logErr,
            );
          }
        }

        return ctx.send({
          message: "Local subscription deleted successfully",
          deleted: existing,
        });
      } catch (error) {
        strapi.log.error("DELETE LOCAL SUBSCRIPTION ERROR:", error);
        return ctx.internalServerError("Failed to delete subscription");
      }
    },

    /* =======================================================
       1. GYM OWNER: ADD OFFLINE MEMBER (TWILIO SMS / WHATSAPP)
       Endpoint: POST /api/club-owner/offline-members
    ======================================================= */
    async addOfflineMember(ctx: Context) {
      try {
        const user = await getAuthUser(ctx);
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        const isAdmin = roleName === "admin" || roleName === "superadmin";

        if (roleName !== "clubowner" && !isAdmin) {
          return ctx.forbidden(
            "Access denied. Only ClubOwner, Admin, or SuperAdmin can add offline members."
          );
        }

        const body = (ctx.request.body as any)?.data || ctx.request.body || {};
        const {
          name,
          phoneNumber,
          local_membership_plan,
          planId,
          membership_plan_price,
          startDate,
          endDate,
          channel = "both",
        } = body;

        if (!name || !String(name).trim()) {
          return ctx.badRequest("Member full name is required");
        }

        if (!phoneNumber || !String(phoneNumber).trim()) {
          return ctx.badRequest("Member +91 mobile number is required");
        }

        const planInput =
          membership_plan_price ||
          planId ||
          body.membershipPlanPriceId ||
          local_membership_plan;

        if (!planInput) {
          return ctx.badRequest("Membership plan is required");
        }

        // Clean & format phone number
        const rawDigits = String(phoneNumber).replace(/\D/g, "");
        if (rawDigits.length < 10) {
          return ctx.badRequest("Please enter a valid 10-digit mobile number");
        }
        const cleanPhone = `+91${rawDigits.slice(-10)}`;
        const memberName = String(name).trim();

        // Resolve club owner
        let clubOwner: any = null;
        if (roleName === "clubowner") {
          clubOwner = await getClubOwnerForUser(user);
        } else {
          const ownerId = body.club_owner || body.ownerId;
          if (ownerId) {
            clubOwner = await resolveClubOwner(ownerId);
          }
        }

        if (!clubOwner) {
          return ctx.badRequest("Club owner profile not found");
        }

        // Resolve plan from membership-plan-price
        const plan = await resolveMembershipPlanPrice(planInput);
        if (!plan) {
          return ctx.notFound("Membership plan not found");
        }

        // Verify plan belongs to this club owner if it's a legacy local plan with club_owner
        const planOwnerDocId = plan.club_owner?.documentId || plan.club_owner?.id;
        const currentOwnerDocId = clubOwner.documentId || clubOwner.id;
        if (
          planOwnerDocId &&
          currentOwnerDocId &&
          String(planOwnerDocId) !== String(currentOwnerDocId)
        ) {
          return ctx.forbidden(
            "Access denied. You can only assign membership plans belonging to your own club."
          );
        }

        const planTitle = getPlanTitle(plan);
        const planPrice = getPlanPriceAmount(plan);

        // Calculate dates
        const todayStr = getISTDateString(0);
        const startDateStr = startDate ? String(startDate).split("T")[0] : todayStr;
        const monthDuration = getPlanDurationMonths(plan);
        const calculatedEndDateStr = calculateEndDate(
          new Date(`${startDateStr}T00:00:00Z`),
          monthDuration
        );
        const finalEndDateStr = endDate
          ? String(endDate).split("T")[0]
          : calculatedEndDateStr;

        // Resolve or create client detail placeholder
        let client = await resolveClientDetail(cleanPhone);
        if (!client) {
          client = await strapi.db.query(CLIENT_UID).create({
            data: {
              name: memberName,
              phoneNumber: cleanPhone,
            },
          });
        }

        // Check if client already has an active subscription for this plan at this gym
        const existingActiveWhere: any = {
          client_detail: client.id,
          club_owner: clubOwner.id,
          subscriptionStatus: "active",
          endDate: { $gte: todayStr },
        };
        if (plan.isPlanPrice) {
          existingActiveWhere.membership_plan_price = plan.id;
        } else {
          existingActiveWhere.local_membership_plan = plan.id;
        }

        const existingActive = await strapi.db.query(LOCAL_SUB_UID).findOne({
          where: existingActiveWhere,
        });

        if (existingActive) {
          return ctx.badRequest(
            `Member ${memberName} already has an active subscription for ${planTitle} expiring on ${existingActive.endDate}.`
          );
        }

        // Create local subscription
        const subData: any = {
          client_detail: client.documentId || client.id,
          club_owner: clubOwner.documentId || clubOwner.id,
          membershipType: "local",
          subscriptionStatus: "active",
          claimStatus: "unclaimed",
          paymentType: "offline_manual",
          paymentStatus: "paid",
          collectedPaymentMode: "cash",
          invitedName: memberName,
          invitedPhone: cleanPhone,
          startDate: new Date(`${startDateStr}T00:00:00Z`).toISOString(),
          endDate: finalEndDateStr,
          amountDue: planPrice != null ? planPrice : 0,
        };

        if (plan.isPlanPrice) {
          subData.membership_plan_price = plan.documentId || plan.id;
        } else {
          subData.local_membership_plan = plan.documentId || plan.id;
        }

        let createdSub: any = null;
        if ((strapi as any).documents) {
          try {
            createdSub = await (strapi as any).documents(LOCAL_SUB_UID).create({
              data: subData,
              populate: {
                club_owner: true,
                membership_plan_price: {
                  populate: { membership_tier: true },
                },
                local_membership_plan: true,
                client_detail: true,
              },
            });
          } catch (_) {}
        }

        if (!createdSub) {
          const entityData: any = {
            ...subData,
            client_detail: client.id,
            club_owner: clubOwner.id,
          };
          if (plan.isPlanPrice) {
            entityData.membership_plan_price = plan.id;
          } else {
            entityData.local_membership_plan = plan.id;
          }
          createdSub = await strapi.entityService.create(LOCAL_SUB_UID, {
            data: entityData,
            populate: {
              club_owner: true,
              membership_plan_price: {
                populate: { membership_tier: true },
              },
              local_membership_plan: true,
              client_detail: true,
            },
          });
        }

        // Build invite link
        const baseUrl = strapi.config.get("server.url") || "https://fitfob.com";
        const inviteLink = `${baseUrl}/invite?phone=${encodeURIComponent(
          cleanPhone
        )}&subId=${createdSub.documentId || createdSub.id}`;

        // Send Twilio Invite (SMS / WhatsApp)
        const inviteResult = await sendTwilioOfflineMemberInvite({
          phone: cleanPhone,
          memberName,
          gymName: clubOwner.clubName || "your gym",
          planName: planTitle,
          expiryDate: finalEndDateStr,
          inviteLink,
          channel: channel || "both",
        });

        // Log Activity
        try {
          const activityLogService: any = strapi.service(
            "api::activity-log.activity-log"
          );
          if (activityLogService?.createActivityLog) {
            await activityLogService.createActivityLog({
              actorType: "club_owner",
              actorId: clubOwner.documentId || clubOwner.id,
              actionType: "create",
              entityName: "local-subscription",
              entityId: createdSub.documentId || createdSub.id,
              description: `Added offline member '${memberName}' (${cleanPhone}) for plan '${planTitle}' (Expiry: ${finalEndDateStr})`,
            });
          }
        } catch (actErr) {
          strapi.log.warn("[OfflineMember] Activity logging failed:", actErr);
        }

        return ctx.send({
          success: true,
          message: "Offline member added successfully and invite sent",
          data: {
            id: createdSub.id,
            documentId: createdSub.documentId || null,
            name: memberName,
            phoneNumber: cleanPhone,
            planName: planTitle,
            startDate: startDateStr,
            endDate: finalEndDateStr,
            claimStatus: "unclaimed",
            subscriptionStatus: "active",
            inviteResult,
          },
        });
      } catch (error) {
        strapi.log.error("ADD OFFLINE MEMBER ERROR:", error);
        return ctx.internalServerError("Failed to add offline member");
      }
    },

    /* =======================================================
       2. GYM OWNER: LIST OFFLINE MEMBERS (ACTIVE MEMBERS LIST)
       Endpoint: GET /api/club-owner/offline-members
    ======================================================= */
    async listOfflineMembers(ctx: Context) {
      try {
        const user = await getAuthUser(ctx);
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        const isAdmin = roleName === "admin" || roleName === "superadmin";

        let clubOwner: any = null;
        if (roleName === "clubowner") {
          clubOwner = await getClubOwnerForUser(user);
        } else if (isAdmin && (ctx.query.clubOwnerId || ctx.query.ownerDocId)) {
          clubOwner = await resolveClubOwner(
            (ctx.query.clubOwnerId || ctx.query.ownerDocId) as string | number
          );
        }

        if (!clubOwner) {
          return ctx.badRequest("Club owner profile not found");
        }

        const todayStr = getISTDateString(0);
        const inSevenDaysStr = getISTDateString(7);

        // Fetch subscriptions for this club owner
        const subscriptions: any[] = await strapi.db
          .query(LOCAL_SUB_UID)
          .findMany({
            where: {
              club_owner: clubOwner.id,
              membershipType: "local",
            },
            populate: {
              client_detail: {
                populate: { selfieUpload: true },
              },
              local_membership_plan: true,
              membership_plan_price: {
                populate: { membership_tier: true },
              },
            },
            orderBy: { id: "desc" },
          });

        const query = (ctx.query || {}) as any;
        const searchQuery = String(query.search || query.q || "")
          .toLowerCase()
          .trim();
        const filterStatus = String(query.filter || "all")
          .toLowerCase()
          .trim();

        const formatted = subscriptions
          .map((sub: any) => {
            const client = sub.client_detail || {};
            const plan = sub.membership_plan_price || sub.local_membership_plan || {};
            const memberName =
              sub.invitedName || client.name || client.fullName || "Guest Member";
            const phone = sub.invitedPhone || client.phoneNumber || "";
            const planName = getPlanTitle(plan);
            const endDateStr = sub.endDate
              ? String(sub.endDate).split("T")[0]
              : null;
            const startDateStr = sub.startDate
              ? String(sub.startDate).split("T")[0]
              : null;

            const isExpired = endDateStr ? endDateStr < todayStr : false;
            const isExpiringSoon =
              endDateStr && !isExpired
                ? endDateStr <= inSevenDaysStr
                : false;
            const isUnclaimed = sub.claimStatus === "unclaimed";

            // Status color: Green means active, Red means expiring soon or expired, Yellow means unclaimed
            let statusColor = "green";
            let statusBadge = "Active";

            if (isExpired) {
              statusColor = "red";
              statusBadge = "Expired";
            } else if (isExpiringSoon) {
              statusColor = "red";
              statusBadge = "Expiring Soon";
            } else if (isUnclaimed) {
              statusColor = "yellow";
              statusBadge = "Invite Sent";
            }

            return {
              id: sub.id,
              documentId: sub.documentId || null,
              name: memberName,
              phoneNumber: phone,
              planName,
              startDate: startDateStr,
              endDate: endDateStr,
              claimStatus: sub.claimStatus || "claimed",
              subscriptionStatus: sub.subscriptionStatus || "active",
              statusBadge,
              statusColor,
              isExpiringSoon,
              isExpired,
              isUnclaimed,
              createdAt: sub.createdAt || null,
            };
          })
          .filter((item: any) => {
            // Apply search
            if (searchQuery) {
              const matchesName = item.name.toLowerCase().includes(searchQuery);
              const matchesPhone = item.phoneNumber.toLowerCase().includes(searchQuery);
              const matchesPlan = item.planName.toLowerCase().includes(searchQuery);
              if (!matchesName && !matchesPhone && !matchesPlan) return false;
            }

            // Apply filter
            if (filterStatus === "active") return !item.isExpired && item.claimStatus !== "unclaimed";
            if (filterStatus === "unclaimed") return item.isUnclaimed;
            if (filterStatus === "expiring") return item.isExpiringSoon;
            if (filterStatus === "expired") return item.isExpired;

            return true;
          });

        return ctx.send({
          count: formatted.length,
          data: formatted,
        });
      } catch (error) {
        strapi.log.error("LIST OFFLINE MEMBERS ERROR:", error);
        return ctx.internalServerError("Failed to fetch offline members");
      }
    },

    /* =======================================================
       3. GYM OWNER: UPDATE OFFLINE MEMBER (EDIT WRONG PHONE OR DETAILS)
       Endpoint: PUT /api/club-owner/offline-members/:id
    ======================================================= */
    async updateOfflineMember(ctx: Context) {
      try {
        const user = await getAuthUser(ctx);
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        const isAdmin = roleName === "admin" || roleName === "superadmin";

        let clubOwner: any = null;
        if (roleName === "clubowner") {
          clubOwner = await getClubOwnerForUser(user);
        } else if (isAdmin) {
          clubOwner = true; // Admin can update
        }

        if (!clubOwner) {
          return ctx.badRequest("Club owner profile not found");
        }

        const targetId = ctx.params.id;
        const isNum = !isNaN(Number(targetId)) && /^\d+$/.test(String(targetId));

        const existing: any = await strapi.db.query(LOCAL_SUB_UID).findOne({
          where: isNum
            ? { $or: [{ id: Number(targetId) }, { documentId: String(targetId) }] }
            : { documentId: String(targetId) },
          populate: {
            club_owner: true,
            local_membership_plan: true,
            membership_plan_price: {
              populate: { membership_tier: true },
            },
            client_detail: true,
          },
        });

        if (!existing) {
          return ctx.notFound("Offline member subscription not found");
        }

        // Verify ownership
        if (roleName === "clubowner") {
          const ownerDocId = clubOwner.documentId || clubOwner.id;
          const subOwnerDocId =
            existing.club_owner?.documentId || existing.club_owner?.id;
          if (String(ownerDocId) !== String(subOwnerDocId)) {
            return ctx.forbidden(
              "Access denied. You can only update members of your own gym."
            );
          }
        }

        if (existing.claimStatus === "claimed") {
          return ctx.badRequest(
            "This membership has already been claimed by the member. Details cannot be modified."
          );
        }

        const body = (ctx.request.body as any)?.data || ctx.request.body || {};
        const updateData: any = {};

        if (body.name && String(body.name).trim()) {
          updateData.invitedName = String(body.name).trim();
        }

        let newPhone = existing.invitedPhone;
        if (body.phoneNumber && String(body.phoneNumber).trim()) {
          const rawDigits = String(body.phoneNumber).replace(/\D/g, "");
          if (rawDigits.length >= 10) {
            newPhone = `+91${rawDigits.slice(-10)}`;
            updateData.invitedPhone = newPhone;
          }
        }

        if (body.endDate && String(body.endDate).trim()) {
          updateData.endDate = String(body.endDate).trim().split("T")[0];
        }

        // Update in DB
        if ((strapi as any).documents && existing.documentId) {
          await (strapi as any).documents(LOCAL_SUB_UID).update({
            documentId: existing.documentId,
            data: updateData,
          });
        } else {
          await strapi.db.query(LOCAL_SUB_UID).update({
            where: { id: existing.id },
            data: updateData,
          });
        }

        // Resend invite if requested
        let inviteResult = null;
        if (body.resendInvite || body.phoneNumber) {
          const baseUrl = strapi.config.get("server.url") || "https://fitfob.com";
          const inviteLink = `${baseUrl}/invite?phone=${encodeURIComponent(
            newPhone
          )}&subId=${existing.documentId || existing.id}`;

          inviteResult = await sendTwilioOfflineMemberInvite({
            phone: newPhone,
            memberName: updateData.invitedName || existing.invitedName || "Member",
            gymName: existing.club_owner?.clubName || "your gym",
            planName: getPlanTitle(
              existing.membership_plan_price || existing.local_membership_plan
            ),
            expiryDate: updateData.endDate || existing.endDate,
            inviteLink,
            channel: body.channel || "both",
          });
        }

        return ctx.send({
          success: true,
          message: "Offline member details updated successfully",
          data: {
            ...existing,
            ...updateData,
            inviteResult,
          },
        });
      } catch (error) {
        strapi.log.error("UPDATE OFFLINE MEMBER ERROR:", error);
        return ctx.internalServerError("Failed to update offline member");
      }
    },

    /* =======================================================
       4. GYM OWNER: CANCEL UNCLAIMED OFFLINE INVITE
       Endpoint: DELETE /api/club-owner/offline-members/:id
    ======================================================= */
    async cancelOfflineInvite(ctx: Context) {
      try {
        const user = await getAuthUser(ctx);
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        const targetId = ctx.params.id;
        const isNum = !isNaN(Number(targetId)) && /^\d+$/.test(String(targetId));

        const existing: any = await strapi.db.query(LOCAL_SUB_UID).findOne({
          where: isNum
            ? { $or: [{ id: Number(targetId) }, { documentId: String(targetId) }] }
            : { documentId: String(targetId) },
          populate: { club_owner: true },
        });

        if (!existing) {
          return ctx.notFound("Offline invite not found");
        }

        if (roleName === "clubowner") {
          const owner = await getClubOwnerForUser(user);
          const ownerDocId = owner?.documentId || owner?.id;
          const subOwnerDocId =
            existing.club_owner?.documentId || existing.club_owner?.id;
          if (String(ownerDocId) !== String(subOwnerDocId)) {
            return ctx.forbidden("Access denied");
          }
        }

        if (existing.claimStatus === "claimed") {
          return ctx.badRequest(
            "This membership has already been claimed and cannot be deleted here."
          );
        }

        if ((strapi as any).documents && existing.documentId) {
          await (strapi as any).documents(LOCAL_SUB_UID).delete({
            documentId: existing.documentId,
          });
        } else {
          await strapi.db.query(LOCAL_SUB_UID).delete({
            where: { id: existing.id },
          });
        }

        return ctx.send({
          success: true,
          message: "Offline invite cancelled successfully",
        });
      } catch (error) {
        strapi.log.error("CANCEL OFFLINE INVITE ERROR:", error);
        return ctx.internalServerError("Failed to cancel offline invite");
      }
    },

    /* =======================================================
       5. CUSTOMER: CHECK PENDING OFFLINE CLAIM ON LOGIN
       Endpoint: GET /api/client/pending-claim
    ======================================================= */
    async getPendingClaim(ctx: Context) {
      try {
        const user = await getAuthUser(ctx);
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const client = await getClientDetailForUser(user);
        const userPhone = user.phoneNumber || client?.phoneNumber || "";

        if (!userPhone) {
          return ctx.send({ hasPendingClaim: false, pendingMemberships: [] });
        }

        const rawDigits = userPhone.replace(/\D/g, "").slice(-10);
        const fullPhone = `+91${rawDigits}`;
        const todayStr = getISTDateString(0);

        const whereOr: any[] = [
          { invitedPhone: fullPhone },
          { invitedPhone: rawDigits },
        ];
        if (client?.id) {
          whereOr.push({ client_detail: client.id });
        }

        const pendingSubs: any[] = await strapi.db
          .query(LOCAL_SUB_UID)
          .findMany({
            where: {
              $or: whereOr,
              claimStatus: "unclaimed",
              subscriptionStatus: "active",
              endDate: { $gte: todayStr },
            },
            populate: {
              club_owner: {
                populate: { logo: true },
              },
              local_membership_plan: true,
              membership_plan_price: {
                populate: { membership_tier: true },
              },
            },
            orderBy: { id: "desc" },
          });

        if (!pendingSubs || pendingSubs.length === 0) {
          return ctx.send({ hasPendingClaim: false, pendingMemberships: [] });
        }

        const formatted = pendingSubs.map((sub: any) => {
          const club = sub.club_owner || {};
          const plan = sub.membership_plan_price || sub.local_membership_plan || {};
          return {
            id: sub.id,
            documentId: sub.documentId || null,
            gymName: club.clubName || club.name || "Gym",
            clubAddress: club.clubAddress || club.address || null,
            logo: extractLogoUrl(club.logo),
            planName: getPlanTitle(plan),
            startDate: sub.startDate ? String(sub.startDate).split("T")[0] : null,
            endDate: sub.endDate || null,
            claimStatus: "unclaimed",
            membershipStatus: "active",
          };
        });

        return ctx.send({
          hasPendingClaim: true,
          pendingMemberships: formatted,
          primaryPending: formatted[0],
        });
      } catch (error) {
        strapi.log.error("GET PENDING CLAIM ERROR:", error);
        return ctx.internalServerError("Failed to check pending memberships");
      }
    },

    /* =======================================================
       6. CUSTOMER: CLAIM MEMBERSHIP & UNLOCK DIGITAL QR
       Endpoint: POST /api/client/claim-membership/:id
    ======================================================= */
    async claimMembership(ctx: Context) {
      try {
        const user = await getAuthUser(ctx);
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const client = await getClientDetailForUser(user);
        if (!client) {
          return ctx.badRequest("Client profile not found");
        }

        const targetId = ctx.params.id;
        const isNum = !isNaN(Number(targetId)) && /^\d+$/.test(String(targetId));

        const sub: any = await strapi.db.query(LOCAL_SUB_UID).findOne({
          where: isNum
            ? { $or: [{ id: Number(targetId) }, { documentId: String(targetId) }] }
            : { documentId: String(targetId) },
          populate: {
            club_owner: true,
            local_membership_plan: true,
            membership_plan_price: {
              populate: { membership_tier: true },
            },
            client_detail: true,
          },
        });

        if (!sub) {
          return ctx.notFound("Membership record not found");
        }

        if (sub.claimStatus === "claimed") {
          return ctx.send({
            success: true,
            message: "Membership is already claimed and active",
            data: sub,
          });
        }

        // Verify phone match
        const userPhoneDigits = (user.phoneNumber || client.phoneNumber || "")
          .replace(/\D/g, "")
          .slice(-10);
        const subPhoneDigits = (sub.invitedPhone || sub.client_detail?.phoneNumber || "")
          .replace(/\D/g, "")
          .slice(-10);

        if (userPhoneDigits && subPhoneDigits && userPhoneDigits !== subPhoneDigits) {
          return ctx.forbidden(
            "This membership was issued to a different mobile number."
          );
        }

        // Link client_detail and update claimStatus to claimed
        const updatePayload: any = {
          client_detail: client.documentId || client.id,
          claimStatus: "claimed",
        };

        if ((strapi as any).documents && sub.documentId) {
          await (strapi as any).documents(LOCAL_SUB_UID).update({
            documentId: sub.documentId,
            data: updatePayload,
          });
        } else {
          await strapi.db.query(LOCAL_SUB_UID).update({
            where: { id: sub.id },
            data: updatePayload,
          });
        }

        // Log Activity
        const planTitle = getPlanTitle(
          sub.membership_plan_price || sub.local_membership_plan
        );
        try {
          const activityLogService: any = strapi.service(
            "api::activity-log.activity-log"
          );
          if (activityLogService?.createActivityLog) {
            await activityLogService.createActivityLog({
              actorType: "client",
              actorId: client.documentId || client.id,
              actionType: "update",
              entityName: "local-subscription",
              entityId: sub.documentId || sub.id,
              description: `Claimed active membership for '${planTitle}' at '${sub.club_owner?.clubName || "Gym"}'`,
            });
          }
        } catch (actErr) {
          strapi.log.warn("[Claim] Activity logging failed:", actErr);
        }

        return ctx.send({
          success: true,
          message: "Membership claimed successfully! Your digital Entry QR is ready.",
          data: {
            id: sub.id,
            documentId: sub.documentId || null,
            gymName: sub.club_owner?.clubName || "Gym",
            planName: planTitle,
            startDate: sub.startDate ? String(sub.startDate).split("T")[0] : null,
            endDate: sub.endDate,
            claimStatus: "claimed",
            membershipStatus: "active",
            clientId: client.clientId,
          },
        });
      } catch (error) {
        strapi.log.error("CLAIM MEMBERSHIP ERROR:", error);
        return ctx.internalServerError("Failed to claim membership");
      }
    },

    /* =======================================================
       7. CUSTOMER: REQUEST "PAY DIRECTLY AT GYM" (CASH/RECEPTION UPI)
       Endpoint: POST /api/client/pay-at-gym
    ======================================================= */
    async requestPayAtGym(ctx: Context) {
      try {
        const user = await getAuthUser(ctx);
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const client = await getClientDetailForUser(user);
        if (!client) {
          return ctx.badRequest("Client profile not found");
        }

        const body = (ctx.request.body as any)?.data || ctx.request.body || {};
        const { club_owner, local_membership_plan, planId, membership_plan_price } =
          body;

        if (!club_owner) {
          return ctx.badRequest("Gym (club_owner) is required");
        }

        const planInput =
          membership_plan_price ||
          planId ||
          body.membershipPlanPriceId ||
          local_membership_plan;

        if (!planInput) {
          return ctx.badRequest(
            "Membership plan (membership_plan_price or planId) is required"
          );
        }

        const resolvedOwner = await resolveClubOwner(club_owner);
        if (!resolvedOwner) {
          return ctx.notFound("Gym not found");
        }

        const resolvedPlan = await resolveMembershipPlanPrice(planInput);
        if (!resolvedPlan) {
          return ctx.notFound("Membership plan not found");
        }

        // Anti-duplicate check: block if customer already has a pending approval request at this gym
        const existingPending = await strapi.db.query(LOCAL_SUB_UID).findOne({
          where: {
            client_detail: client.id,
            club_owner: resolvedOwner.id,
            paymentStatus: "pending_approval",
          },
        });

        if (existingPending) {
          return ctx.badRequest(
            "You already have a pending 'Pay at Gym' request waiting for approval at this gym. Please pay at the front desk or cancel the existing request."
          );
        }

        const todayStr = getISTDateString(0);
        const monthDuration = getPlanDurationMonths(resolvedPlan);
        const planTitle = getPlanTitle(resolvedPlan);
        const planPrice = getPlanPriceAmount(resolvedPlan);
        const endDateStr = calculateEndDate(
          new Date(`${todayStr}T00:00:00Z`),
          monthDuration
        );

        const subPayload: any = {
          client_detail: client.documentId || client.id,
          club_owner: resolvedOwner.documentId || resolvedOwner.id,
          membershipType: "local",
          subscriptionStatus: "pending",
          claimStatus: "claimed",
          paymentType: "pay_at_gym",
          paymentStatus: "pending_approval",
          amountDue: planPrice != null ? planPrice : 0,
          startDate: new Date(`${todayStr}T00:00:00Z`).toISOString(),
          endDate: endDateStr,
        };

        if (resolvedPlan.isPlanPrice) {
          subPayload.membership_plan_price =
            resolvedPlan.documentId || resolvedPlan.id;
        } else {
          subPayload.local_membership_plan =
            resolvedPlan.documentId || resolvedPlan.id;
        }

        let createdSub: any = null;
        if ((strapi as any).documents) {
          try {
            createdSub = await (strapi as any).documents(LOCAL_SUB_UID).create({
              data: subPayload,
              populate: {
                club_owner: true,
                membership_plan_price: {
                  populate: { membership_tier: true },
                },
                local_membership_plan: true,
                client_detail: true,
              },
            });
          } catch (_) {}
        }

        if (!createdSub) {
          const entityData: any = {
            ...subPayload,
            client_detail: client.id,
            club_owner: resolvedOwner.id,
          };
          if (resolvedPlan.isPlanPrice) {
            entityData.membership_plan_price = resolvedPlan.id;
          } else {
            entityData.local_membership_plan = resolvedPlan.id;
          }
          createdSub = await strapi.entityService.create(LOCAL_SUB_UID, {
            data: entityData,
            populate: {
              club_owner: true,
              membership_plan_price: {
                populate: { membership_tier: true },
              },
              local_membership_plan: true,
              client_detail: true,
            },
          });
        }

        // Dispatch FCM Push Notification to Gym Owner
        try {
          await sendClubOwnerPayAtGymNotification(resolvedOwner, {
            subscription: createdSub,
            client,
            planName: planTitle,
            amount: subPayload.amountDue,
          });
        } catch (pushErr) {
          strapi.log.warn("[PayAtGym] Failed to dispatch owner push notification:", pushErr);
        }

        // Log Activity
        try {
          const activityLogService: any = strapi.service(
            "api::activity-log.activity-log"
          );
          if (activityLogService?.createActivityLog) {
            await activityLogService.createActivityLog({
              actorType: "client",
              actorId: client.documentId || client.id,
              actionType: "create",
              entityName: "local-subscription",
              entityId: createdSub.documentId || createdSub.id,
              description: `Submitted 'Pay at Gym' request for ${planTitle} (₹${subPayload.amountDue}) at ${resolvedOwner.clubName || "Gym"}`,
            });
          }
        } catch (actErr) {
          strapi.log.warn("[PayAtGym] Activity logging failed:", actErr);
        }

        return ctx.send({
          success: true,
          message:
            "Payment request submitted. Please visit the gym reception to pay via Cash or UPI and activate your pass.",
          data: {
            id: createdSub.id,
            documentId: createdSub.documentId || null,
            gymName: resolvedOwner.clubName || "Gym",
            gymAddress: resolvedOwner.clubAddress || null,
            planName: resolvedPlan.planName,
            amountDue: subPayload.amountDue,
            paymentStatus: "pending_approval",
            subscriptionStatus: "pending",
            requestedAt: createdSub.createdAt || new Date().toISOString(),
          },
        });
      } catch (error) {
        strapi.log.error("REQUEST PAY AT GYM ERROR:", error);
        return ctx.internalServerError("Failed to submit Pay at Gym request");
      }
    },

    /* =======================================================
       8. CUSTOMER: CANCEL "PAY DIRECTLY AT GYM" REQUEST
       Endpoint: POST /api/client/pay-at-gym/:id/cancel
    ======================================================= */
    async cancelPayAtGymRequest(ctx: Context) {
      try {
        const user = await getAuthUser(ctx);
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const client = await getClientDetailForUser(user);
        if (!client) {
          return ctx.badRequest("Client profile not found");
        }

        const targetId = ctx.params.id;
        const isNum = !isNaN(Number(targetId)) && /^\d+$/.test(String(targetId));

        const sub: any = await strapi.db.query(LOCAL_SUB_UID).findOne({
          where: isNum
            ? { $or: [{ id: Number(targetId) }, { documentId: String(targetId) }] }
            : { documentId: String(targetId) },
          populate: { client_detail: true, club_owner: true },
        });

        if (!sub) {
          return ctx.notFound("Payment request not found");
        }

        // Ownership verification
        const subClientDocId =
          sub.client_detail?.documentId || sub.client_detail?.id;
        const clientDocId = client.documentId || client.id;
        if (String(subClientDocId) !== String(clientDocId)) {
          return ctx.forbidden("You can only cancel your own payment request.");
        }

        if (sub.paymentStatus !== "pending_approval") {
          return ctx.badRequest(
            `Cannot cancel request with paymentStatus '${sub.paymentStatus}'`
          );
        }

        const updatePayload: any = {
          paymentStatus: "cancelled",
          subscriptionStatus: "cancelled",
        };

        if ((strapi as any).documents && sub.documentId) {
          await (strapi as any).documents(LOCAL_SUB_UID).update({
            documentId: sub.documentId,
            data: updatePayload,
          });
        } else {
          await strapi.db.query(LOCAL_SUB_UID).update({
            where: { id: sub.id },
            data: updatePayload,
          });
        }

        return ctx.send({
          success: true,
          message: "Payment request cancelled successfully",
        });
      } catch (error) {
        strapi.log.error("CANCEL PAY AT GYM REQUEST ERROR:", error);
        return ctx.internalServerError("Failed to cancel payment request");
      }
    },

    /* =======================================================
       9. GYM OWNER: GET PENDING APPROVALS LIST
       Endpoint: GET /api/club-owner/pending-approvals
    ======================================================= */
    async getPendingApprovals(ctx: Context) {
      try {
        const user = await getAuthUser(ctx);
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        const isAdmin = roleName === "admin" || roleName === "superadmin";

        let clubOwner: any = null;
        if (roleName === "clubowner") {
          clubOwner = await getClubOwnerForUser(user);
        } else if (isAdmin && (ctx.query.clubOwnerId || ctx.query.ownerDocId)) {
          clubOwner = await resolveClubOwner(
            (ctx.query.clubOwnerId || ctx.query.ownerDocId) as string | number
          );
        }

        if (!clubOwner) {
          return ctx.badRequest("Club owner profile not found");
        }

        const pendingRequests: any[] = await strapi.db
          .query(LOCAL_SUB_UID)
          .findMany({
            where: {
              club_owner: clubOwner.id,
              paymentStatus: "pending_approval",
            },
            populate: {
              client_detail: {
                populate: { selfieUpload: true },
              },
              local_membership_plan: true,
              membership_plan_price: {
                populate: { membership_tier: true },
              },
            },
            orderBy: { id: "desc" },
          });

        const formatted = (pendingRequests || []).map((req: any) => {
          const client = req.client_detail || {};
          const plan = req.membership_plan_price || req.local_membership_plan || {};
          const planTitle = getPlanTitle(plan);
          const customerName =
            client.name || client.fullName || req.invitedName || "Guest Customer";
          const phone = client.phoneNumber || req.invitedPhone || "";
          const amountDue =
            req.amountDue != null
              ? Number(req.amountDue)
              : getPlanPriceAmount(plan) ?? 0;

          return {
            id: req.id,
            documentId: req.documentId || null,
            customerName,
            phoneNumber: phone,
            planName: planTitle,
            amountDue,
            currency: "INR",
            requestedAt: req.createdAt || null,
            timeAgo: formatTimeAgo(req.createdAt),
          };
        });

        return ctx.send({
          count: formatted.length,
          requests: formatted,
        });
      } catch (error) {
        strapi.log.error("GET PENDING APPROVALS ERROR:", error);
        return ctx.internalServerError("Failed to fetch pending approvals");
      }
    },

    /* =======================================================
       10. GYM OWNER: APPROVE "PAY AT GYM" REQUEST
       Endpoint: POST /api/club-owner/pending-approvals/:id/approve
    ======================================================= */
    async approvePayAtGym(ctx: Context) {
      try {
        const user = await getAuthUser(ctx);
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        const isAdmin = roleName === "admin" || roleName === "superadmin";

        let clubOwner: any = null;
        if (roleName === "clubowner") {
          clubOwner = await getClubOwnerForUser(user);
        } else if (isAdmin) {
          clubOwner = true;
        }

        if (!clubOwner) {
          return ctx.badRequest("Club owner profile not found");
        }

        const targetId = ctx.params.id;
        const isNum = !isNaN(Number(targetId)) && /^\d+$/.test(String(targetId));

        const sub: any = await strapi.db.query(LOCAL_SUB_UID).findOne({
          where: isNum
            ? { $or: [{ id: Number(targetId) }, { documentId: String(targetId) }] }
            : { documentId: String(targetId) },
          populate: {
            club_owner: true,
            local_membership_plan: true,
            membership_plan_price: {
              populate: { membership_tier: true },
            },
            client_detail: {
              populate: { user: true },
            },
          },
        });

        if (!sub) {
          return ctx.notFound("Pending approval request not found");
        }

        // Ownership verification
        if (roleName === "clubowner") {
          const ownerDocId = clubOwner.documentId || clubOwner.id;
          const subOwnerDocId =
            sub.club_owner?.documentId || sub.club_owner?.id;
          if (String(ownerDocId) !== String(subOwnerDocId)) {
            return ctx.forbidden(
              "Access denied. You can only approve requests for your own gym."
            );
          }
        }

        if (sub.paymentStatus !== "pending_approval") {
          return ctx.badRequest(
            `Request is not pending approval (Current status: ${sub.paymentStatus})`
          );
        }

        const body = (ctx.request.body as any)?.data || ctx.request.body || {};
        const paymentMode =
          body.paymentMode || body.collectedPaymentMode || "cash";

        const plan = sub.membership_plan_price || sub.local_membership_plan || {};
        const planTitle = getPlanTitle(plan);
        const todayStr = getISTDateString(0);
        const monthDuration = getPlanDurationMonths(plan);
        const endDateStr = calculateEndDate(
          new Date(`${todayStr}T00:00:00Z`),
          monthDuration
        );

        const updatePayload: any = {
          paymentStatus: "paid",
          subscriptionStatus: "active",
          claimStatus: "claimed",
          collectedPaymentMode: paymentMode,
          startDate: new Date(`${todayStr}T00:00:00Z`).toISOString(),
          endDate: endDateStr,
        };

        if ((strapi as any).documents && sub.documentId) {
          await (strapi as any).documents(LOCAL_SUB_UID).update({
            documentId: sub.documentId,
            data: updatePayload,
          });
        } else {
          await strapi.db.query(LOCAL_SUB_UID).update({
            where: { id: sub.id },
            data: updatePayload,
          });
        }

        // Notify client via push notification
        const clientUserId = sub.client_detail?.user?.id;
        if (clientUserId) {
          try {
            await sendClientMembershipDecisionPush(clientUserId, "approved", {
              gymName: sub.club_owner?.clubName || "Gym",
              planName: planTitle,
            });
          } catch (pushErr) {
            strapi.log.warn("[Approve] Push notification warning:", pushErr);
          }
        }

        // Log Activity
        try {
          const activityLogService: any = strapi.service(
            "api::activity-log.activity-log"
          );
          if (activityLogService?.createActivityLog) {
            const customerName =
              sub.client_detail?.name || sub.invitedName || "Customer";
            await activityLogService.createActivityLog({
              actorType: "club_owner",
              actorId: sub.club_owner?.documentId || sub.club_owner?.id,
              actionType: "approve",
              entityName: "local-subscription",
              entityId: sub.documentId || sub.id,
              description: `Approved Pay-at-Gym membership for '${customerName}' (Plan: ${planTitle}, Mode: ${paymentMode})`,
            });
          }
        } catch (actErr) {
          strapi.log.warn("[Approve] Activity logging failed:", actErr);
        }

        return ctx.send({
          success: true,
          message: "Membership activated successfully and Customer Entry QR unlocked!",
          data: {
            id: sub.id,
            documentId: sub.documentId || null,
            subscriptionStatus: "active",
            paymentStatus: "paid",
            collectedPaymentMode: paymentMode,
            startDate: todayStr,
            endDate: endDateStr,
          },
        });
      } catch (error) {
        strapi.log.error("APPROVE PAY AT GYM ERROR:", error);
        return ctx.internalServerError("Failed to approve membership request");
      }
    },

    /* =======================================================
       11. GYM OWNER: REJECT "PAY AT GYM" REQUEST
       Endpoint: POST /api/club-owner/pending-approvals/:id/reject
    ======================================================= */
    async rejectPayAtGym(ctx: Context) {
      try {
        const user = await getAuthUser(ctx);
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        const isAdmin = roleName === "admin" || roleName === "superadmin";

        let clubOwner: any = null;
        if (roleName === "clubowner") {
          clubOwner = await getClubOwnerForUser(user);
        } else if (isAdmin) {
          clubOwner = true;
        }

        if (!clubOwner) {
          return ctx.badRequest("Club owner profile not found");
        }

        const targetId = ctx.params.id;
        const isNum = !isNaN(Number(targetId)) && /^\d+$/.test(String(targetId));

        const sub: any = await strapi.db.query(LOCAL_SUB_UID).findOne({
          where: isNum
            ? { $or: [{ id: Number(targetId) }, { documentId: String(targetId) }] }
            : { documentId: String(targetId) },
          populate: {
            club_owner: true,
            local_membership_plan: true,
            membership_plan_price: {
              populate: { membership_tier: true },
            },
            client_detail: {
              populate: { user: true },
            },
          },
        });

        if (!sub) {
          return ctx.notFound("Pending approval request not found");
        }

        if (roleName === "clubowner") {
          const ownerDocId = clubOwner.documentId || clubOwner.id;
          const subOwnerDocId =
            sub.club_owner?.documentId || sub.club_owner?.id;
          if (String(ownerDocId) !== String(subOwnerDocId)) {
            return ctx.forbidden("Access denied");
          }
        }

        if (sub.paymentStatus !== "pending_approval") {
          return ctx.badRequest(
            `Request is not pending approval (Current status: ${sub.paymentStatus})`
          );
        }

        const body = (ctx.request.body as any)?.data || ctx.request.body || {};
        const reason = body.reason || "Payment not received at front desk";

        const plan = sub.membership_plan_price || sub.local_membership_plan || {};
        const planTitle = getPlanTitle(plan);

        const updatePayload: any = {
          paymentStatus: "rejected",
          subscriptionStatus: "cancelled",
          rejectionReason: reason,
        };

        if ((strapi as any).documents && sub.documentId) {
          await (strapi as any).documents(LOCAL_SUB_UID).update({
            documentId: sub.documentId,
            data: updatePayload,
          });
        } else {
          await strapi.db.query(LOCAL_SUB_UID).update({
            where: { id: sub.id },
            data: updatePayload,
          });
        }

        // Notify client via push notification
        const clientUserId = sub.client_detail?.user?.id;
        if (clientUserId) {
          try {
            await sendClientMembershipDecisionPush(clientUserId, "rejected", {
              gymName: sub.club_owner?.clubName || "Gym",
              planName: planTitle,
              reason,
            });
          } catch (pushErr) {
            strapi.log.warn("[Reject] Push notification warning:", pushErr);
          }
        }

        // Log Activity
        try {
          const activityLogService: any = strapi.service(
            "api::activity-log.activity-log"
          );
          if (activityLogService?.createActivityLog) {
            const customerName =
              sub.client_detail?.name || sub.invitedName || "Customer";
            await activityLogService.createActivityLog({
              actorType: "club_owner",
              actorId: sub.club_owner?.documentId || sub.club_owner?.id,
              actionType: "rejected",
              entityName: "local-subscription",
              entityId: sub.documentId || sub.id,
              description: `Declined Pay-at-Gym request for '${customerName}' (Reason: ${reason})`,
            });
          }
        } catch (actErr) {
          strapi.log.warn("[Reject] Activity logging failed:", actErr);
        }

        return ctx.send({
          success: true,
          message: "Request declined and customer notified",
        });
      } catch (error) {
        strapi.log.error("REJECT PAY AT GYM ERROR:", error);
        return ctx.internalServerError("Failed to decline request");
      }
    },
  }),
);
