import { factories } from "@strapi/strapi";

const LOCAL_SUB_UID = "api::local-subscription.local-subscription" as any;
const LOCAL_PLAN_UID = "api::local-membership-plan.local-membership-plan" as any;
const CLIENT_UID = "api::client-detail.client-detail" as any;
const CLUB_OWNER_UID = "api::club-owner.club-owner" as any;

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
    logo.url ||
    logo.formats?.thumbnail?.url ||
    logo.formats?.small?.url ||
    null
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
    select: [
      "id",
      "documentId",
      "clientId",
      "name",
      "phoneNumber",
      "email",
    ],
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

  const client = await strapi.db.query(CLIENT_UID).findOne({
    where: {
      $or: [
        { documentId: rawStr },
        { clientId: rawStr },
        { phoneNumber: rawStr },
        { email: rawStr },
      ],
    },
    select: [
      "id",
      "documentId",
      "clientId",
      "name",
      "phoneNumber",
      "email",
    ],
  });

  return client || null;
}

/* ---------- HELPER: RESOLVE CLUB OWNER ---------- */
async function resolveClubOwner(identifier: string | number) {
  if (!identifier) return null;
  const rawStr = String(identifier).trim();

  const owner = await strapi.db.query(CLUB_OWNER_UID).findOne({
    where: {
      $or: [{ documentId: rawStr }, { clubId: rawStr }],
    },
    select: [
      "id",
      "documentId",
      "clubId",
      "clubName",
      "ownerName",
      "phoneNumber",
      "email",
    ],
  });

  return owner || null;
}

/* ---------- HELPER: RESOLVE LOCAL PLAN ---------- */
async function resolveLocalPlan(identifier: string | number) {
  if (!identifier) return null;
  const rawStr = String(identifier).trim();

  const plan: any = await strapi.db.query(LOCAL_PLAN_UID).findOne({
    where: { documentId: rawStr },
    populate: {
      club_owner: {
        select: ["id", "documentId", "clubId", "clubName", "ownerName"],
      },
    },
  });

  if (!plan) return null;

  if (plan.club_owner && !plan.club_owner.documentId) {
    const ownerIdentifier = plan.club_owner.id || plan.club_owner;
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

export default factories.createCoreController(
  "api::local-subscription.local-subscription",
  ({ strapi }) => ({
    /* =======================================================
       1. BUY LOCAL MEMBERSHIP (CLIENT - ONLINE / APP)
       membershipType: "app"
       startDate: automatically set to now
       endDate: calculated based on plan.monthDuration
    ======================================================= */
    async buy(ctx) {
      try {
        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        if (roleName !== "client") {
          return ctx.forbidden(
            "Access denied. Only registered clients can buy memberships online.",
          );
        }

        const clientRecord = await getClientDetailForUser(user);
        if (!clientRecord || !clientRecord.documentId) {
          return ctx.badRequest(
            "Client profile not found for this account. Please complete client profile registration first.",
          );
        }

        const clientDocId = clientRecord.documentId;
        const clientId = clientRecord.id;

        const body = ctx.request.body;
        const payload = body?.data ? body.data : body || {};

        const { local_membership_plan } = payload;

        if (!local_membership_plan) {
          return ctx.badRequest(
            "local_membership_plan is required (provide plan documentId)",
          );
        }

        // Resolve plan
        const plan = await resolveLocalPlan(local_membership_plan);
        if (!plan) {
          return ctx.notFound("Local membership plan not found");
        }

        if (plan.isActive === false) {
          return ctx.badRequest(
            "This local membership plan is currently inactive and cannot be purchased.",
          );
        }

        if (!plan.club_owner) {
          return ctx.badRequest(
            "This membership plan is not associated with any club.",
          );
        }

        let ownerRecord = plan.club_owner;
        if (!ownerRecord.documentId) {
          const ownerIdentifier = ownerRecord.id || ownerRecord;
          const resolvedOwner = await resolveClubOwner(ownerIdentifier);
          if (resolvedOwner) {
            ownerRecord = resolvedOwner;
          }
        }

        const clubOwnerDocId = ownerRecord.documentId;
        const clubOwnerId = ownerRecord.id || ownerRecord;
        const planDocId = plan.documentId;
        const planId = plan.id;

        const startDate = new Date();
        const monthDuration = Number(plan.monthDuration) || 1;
        const endDate = calculateEndDate(startDate, monthDuration);

        /* ---------- CREATE APP SUBSCRIPTION (NO LOGO POPULATED) ---------- */
        let createdSub: any = null;

        if ((strapi as any).documents) {
          try {
            createdSub = await (strapi as any).documents(LOCAL_SUB_UID).create({
              data: {
                client_detail: clientDocId,
                club_owner: clubOwnerDocId,
                local_membership_plan: planDocId,
                membershipType: "app",
                startDate: startDate.toISOString(),
                endDate,
                subscriptionStatus: "active",
              },
              populate: {
                club_owner: {
                  select: [
                    "id",
                    "documentId",
                    "clubId",
                    "clubName",
                    "ownerName",
                  ],
                },
                local_membership_plan: true,
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
          } catch (docErr) {
            strapi.log.warn("Documents API create fallback in buy:", docErr);
          }
        }

        if (!createdSub) {
          createdSub = await strapi.entityService.create(LOCAL_SUB_UID, {
            data: {
              client_detail: clientId,
              club_owner: clubOwnerId,
              local_membership_plan: planId,
              membershipType: "app",
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

        return ctx.send(
          {
            message: "Membership purchased successfully via app",
            data: createdSub,
          },
          201,
        );
      } catch (error) {
        strapi.log.error("BUY LOCAL SUBSCRIPTION ERROR:", error);
        return ctx.internalServerError("Failed to purchase membership");
      }
    },

    /* =======================================================
       2. MANUAL / OFFLINE MEMBERSHIP CREATION (CLUB OWNER / ADMIN)
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
        if (
          roleName !== "clubowner" &&
          roleName !== "admin" &&
          roleName !== "superadmin"
        ) {
          return ctx.forbidden(
            "Access denied. Only ClubOwner, Admin, or SuperAdmin can create offline memberships.",
          );
        }

        const body = ctx.request.body;
        const payload = body?.data ? body.data : body || {};

        const {
          client_detail,
          local_membership_plan,
          club_owner,
          ownerId,
        } = payload;

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
          const providedOwner = club_owner || ownerId;

          if (providedOwner) {
            const resolvedOwner = await resolveClubOwner(providedOwner);
            if (!resolvedOwner) {
              return ctx.notFound(`Club owner '${providedOwner}' not found.`);
            }

            const planOwnerDocId = plan.club_owner?.documentId;
            if (
              planOwnerDocId &&
              String(planOwnerDocId) !== String(resolvedOwner.documentId)
            ) {
              return ctx.badRequest(
                "The selected local_membership_plan does not belong to the specified club_owner.",
              );
            }

            targetClubOwnerId = resolvedOwner.id;
            targetClubOwnerDocId = resolvedOwner.documentId;
          } else {
            if (!plan.club_owner) {
              return ctx.badRequest(
                "This membership plan is not associated with any club. Please specify club_owner in the payload.",
              );
            }
            targetClubOwnerId = plan.club_owner.id || plan.club_owner;
            targetClubOwnerDocId = plan.club_owner.documentId;
          }
        }

        const startDate = new Date();
        const monthDuration = Number(plan.monthDuration) || 1;
        const endDate = calculateEndDate(startDate, monthDuration);

        const clientId = clientRecord.id;
        const clientDocId = clientRecord.documentId;
        const planId = plan.id;
        const planDocId = plan.documentId;

        /* ---------- CREATE LOCAL SUBSCRIPTION (NO LOGO POPULATED) ---------- */
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
                club_owner: {
                  select: [
                    "id",
                    "documentId",
                    "clubId",
                    "clubName",
                    "ownerName",
                  ],
                },
                local_membership_plan: true,
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
       3. GET MY SUBSCRIPTIONS
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
       4. FIND ALL / FILTER LOCAL SUBSCRIPTIONS
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
       5. GET SINGLE LOCAL SUBSCRIPTION
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
       6. UPDATE LOCAL SUBSCRIPTION (STATUS / END DATE)
    ======================================================= */
    async update(ctx) {
      try {
        const { id } = ctx.params;
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        const documentId = String(id).trim();

        const existing: any = await strapi.db.query(LOCAL_SUB_UID).findOne({
          where: { documentId },
          select: ["id", "documentId", "subscriptionStatus", "endDate"],
          populate: {
            club_owner: {
              select: ["id", "documentId"],
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
        } else if (roleName !== "admin" && roleName !== "superadmin") {
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
       7. DELETE LOCAL SUBSCRIPTION
    ======================================================= */
    async delete(ctx) {
      try {
        const { id } = ctx.params;
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        const documentId = String(id).trim();

        const existing: any = await strapi.db.query(LOCAL_SUB_UID).findOne({
          where: { documentId },
          select: ["id", "documentId"],
          populate: {
            club_owner: {
              select: ["id", "documentId"],
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
        } else if (roleName !== "admin" && roleName !== "superadmin") {
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

        return ctx.send({
          message: "Local subscription deleted successfully",
          deleted: existing,
        });
      } catch (error) {
        strapi.log.error("DELETE LOCAL SUBSCRIPTION ERROR:", error);
        return ctx.internalServerError("Failed to delete subscription");
      }
    },
  })
);
