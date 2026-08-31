import { factories } from "@strapi/strapi";

const LOCAL_SUB_UID = "api::local-subscription.local-subscription" as any;
const LOCAL_PLAN_UID = "api::local-membership-plan.local-membership-plan" as any;
const CLIENT_UID = "api::client-detail.client-detail" as any;
const CLUB_OWNER_UID = "api::club-owner.club-owner" as any;

/* ---------- FAST ROLE HELPER ---------- */
async function getUserRole(user: any): Promise<string> {
  if (!user) return "";

  if (user.role?.name || user.role?.type) {
    return (
      user.role.name?.toLowerCase().replace(/[\s_-]+/g, "") ||
      user.role.type?.toLowerCase().replace(/[\s_-]+/g, "") ||
      ""
    );
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

  return (
    fullUser?.role?.name?.toLowerCase().replace(/[\s_-]+/g, "") ||
    fullUser?.role?.type?.toLowerCase().replace(/[\s_-]+/g, "") ||
    ""
  );
}

/* ---------- HELPER: GET CLIENT DETAIL FOR AUTH USER ---------- */
async function getClientDetailForUser(userId: number | string) {
  if (!userId) return null;

  const isNumeric =
    typeof userId === "number" ||
    (!isNaN(Number(userId)) && /^\d+$/.test(String(userId).trim()));

  const userWhere = isNumeric
    ? { $or: [{ id: Number(userId) }, { documentId: String(userId) }] }
    : { documentId: String(userId) };

  // 1. Try finding via users-permissions user
  const userWithDetail: any = await strapi.db
    .query("plugin::users-permissions.user")
    .findOne({
      where: userWhere,
      populate: {
        client_detail: true,
      },
    });

  let client = userWithDetail?.client_detail;

  // 2. If client not found or missing documentId, query client_detail directly
  if (!client || !client.documentId) {
    const directConditions: any[] = [];
    if (isNumeric) {
      directConditions.push({ user: Number(userId) });
      directConditions.push({ user: { id: Number(userId) } });
    }
    directConditions.push({ user: { documentId: String(userId) } });

    if (client?.id) {
      directConditions.push({ id: client.id });
    }

    const directClient: any = await strapi.db.query(CLIENT_UID).findOne({
      where: {
        $or: directConditions,
      },
    });

    if (directClient) {
      client = directClient;
    }
  }

  return client || null;
}

/* ---------- HELPER: GET CLUB OWNER FOR AUTH USER ---------- */
async function getClubOwnerForUser(userId: number | string) {
  if (!userId) return null;

  const isNumeric =
    typeof userId === "number" ||
    (!isNaN(Number(userId)) && /^\d+$/.test(String(userId).trim()));

  const userWhere = isNumeric
    ? { $or: [{ id: Number(userId) }, { documentId: String(userId) }] }
    : { documentId: String(userId) };

  const userWithDetail: any = await strapi.db
    .query("plugin::users-permissions.user")
    .findOne({
      where: userWhere,
      populate: {
        club_owner: {
          populate: {
            logo: true,
          },
        },
      },
    });

  let owner = userWithDetail?.club_owner;

  if (!owner || !owner.documentId) {
    const directConditions: any[] = [];
    if (isNumeric) {
      directConditions.push({ user: Number(userId) });
      directConditions.push({ user: { id: Number(userId) } });
    }
    directConditions.push({ user: { documentId: String(userId) } });

    if (owner?.id) {
      directConditions.push({ id: owner.id });
    }

    const directClubOwner: any = await strapi.db.query(CLUB_OWNER_UID).findOne({
      where: {
        $or: directConditions,
      },
      populate: {
        logo: true,
      },
    });

    if (directClubOwner) {
      owner = directClubOwner;
    }
  }

  return owner || null;
}

/* ---------- HELPER: RESOLVE CLIENT DETAIL BY VARIOUS IDENTIFIERS ---------- */
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
  });

  return client || null;
}

/* ---------- HELPER: RESOLVE CLUB OWNER ---------- */
async function resolveClubOwner(identifier: string | number) {
  if (!identifier) return null;

  const rawStr = String(identifier).trim();
  const isNumeric = !isNaN(Number(rawStr)) && /^\d+$/.test(rawStr);

  const whereConditions: any[] = [
    { documentId: rawStr },
    { clubId: rawStr },
  ];

  if (isNumeric) {
    whereConditions.push({ id: Number(rawStr) });
  }

  const owner = await strapi.db.query(CLUB_OWNER_UID).findOne({
    where: {
      $or: whereConditions,
    },
    populate: {
      logo: true,
    },
  });

  return owner || null;
}

/* ---------- HELPER: RESOLVE LOCAL PLAN ---------- */
async function resolveLocalPlan(identifier: string | number) {
  if (!identifier) return null;

  const rawStr = String(identifier).trim();
  const isNumeric = !isNaN(Number(rawStr)) && /^\d+$/.test(rawStr);

  const plan: any = await strapi.db.query(LOCAL_PLAN_UID).findOne({
    where: isNumeric
      ? { $or: [{ documentId: rawStr }, { id: Number(rawStr) }] }
      : { documentId: rawStr },
    populate: {
      club_owner: {
        populate: ["logo"],
      },
    },
  });

  if (!plan) return null;

  // Guarantee owner documentId is resolved from plan
  if (plan.club_owner) {
    if (!plan.club_owner.documentId) {
      const ownerIdentifier = plan.club_owner.id || plan.club_owner;
      const fullOwner = await resolveClubOwner(ownerIdentifier);
      if (fullOwner) {
        plan.club_owner = fullOwner;
      }
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
        // 1. Get authenticated user from token
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

        // Get client documentId from token (ctx.state.user)
        const clientRecord = await getClientDetailForUser(user.id || user.documentId);
        if (!clientRecord) {
          return ctx.badRequest(
            "Client profile not found for this account. Please complete client profile registration first.",
          );
        }

        const clientDocId = clientRecord.documentId;
        const clientId = clientRecord.id;

        if (!clientDocId && !clientId) {
          return ctx.badRequest(
            "Unable to determine client documentId from authentication token.",
          );
        }

        const body = ctx.request.body;
        const payload = body?.data ? body.data : body || {};

        const { local_membership_plan } = payload;

        if (!local_membership_plan) {
          return ctx.badRequest(
            "local_membership_plan is required (provide plan documentId or numeric id)",
          );
        }

        // 2. Resolve plan and get owner documentId from plan
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

        // Get owner documentId and ID from plan
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

        /* ---------- CREATE APP SUBSCRIPTION ---------- */
        let createdSub: any = null;

        if ((strapi as any).documents) {
          try {
            createdSub = await (strapi as any).documents(LOCAL_SUB_UID).create({
              data: {
                client_detail: clientDocId || clientId,
                club_owner: clubOwnerDocId || clubOwnerId,
                local_membership_plan: planDocId || planId,
                membershipType: "app",
                startDate: startDate.toISOString(),
                endDate,
                subscriptionStatus: "active",
              },
              populate: {
                club_owner: {
                  populate: ["logo"],
                },
                local_membership_plan: true,
                client_detail: true,
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
              club_owner: {
                populate: ["logo"],
              },
              local_membership_plan: true,
              client_detail: true,
            },
          });
        }

        // Relational guarantee
        if ((!createdSub?.club_owner || !createdSub?.client_detail) && (createdSub?.id || createdSub?.documentId)) {
          const whereClause = createdSub.id ? { id: createdSub.id } : { documentId: createdSub.documentId };
          await strapi.db.query(LOCAL_SUB_UID).update({
            where: whereClause,
            data: {
              client_detail: clientId,
              club_owner: clubOwnerId,
              local_membership_plan: planId,
            },
          });

          createdSub = await strapi.db.query(LOCAL_SUB_UID).findOne({
            where: whereClause,
            populate: {
              club_owner: {
                populate: ["logo"],
              },
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
            "client_detail is required (provide documentId, clientId, phone, email, or id)",
          );
        }

        if (!local_membership_plan) {
          return ctx.badRequest(
            "local_membership_plan is required (provide plan documentId or id)",
          );
        }

        const clientRecord = await resolveClientDetail(client_detail);
        if (!clientRecord) {
          return ctx.notFound(
            `Client matching '${client_detail}' not found.`,
          );
        }

        const plan = await resolveLocalPlan(local_membership_plan);
        if (!plan) {
          return ctx.notFound("Local membership plan not found");
        }

        let targetClubOwnerId: number;
        let targetClubOwnerDocId: string;

        if (roleName === "clubowner") {
          // 1. ClubOwner: Extract owner documentId / id directly from JWT token
          const ownerRecord = await getClubOwnerForUser(user.id);
          if (!ownerRecord) {
            return ctx.badRequest("Club owner profile not found for this account.");
          }

          const planOwnerId = plan.club_owner?.id || plan.club_owner;
          const planOwnerDocId = plan.club_owner?.documentId;

          // Enforce ownership: club owner can only create memberships of his/her own gym
          if (
            Number(planOwnerId) !== Number(ownerRecord.id) &&
            String(planOwnerDocId) !== String(ownerRecord.documentId)
          ) {
            return ctx.forbidden(
              "Access denied. You can only assign membership plans belonging to your own club.",
            );
          }

          targetClubOwnerId = ownerRecord.id;
          targetClubOwnerDocId = ownerRecord.documentId;
        } else {
          // 2. Admin / SuperAdmin: Can pass owner documentId / id in payload or use plan's club_owner
          const providedOwner = club_owner || ownerId;

          if (providedOwner) {
            const resolvedOwner = await resolveClubOwner(providedOwner);
            if (!resolvedOwner) {
              return ctx.notFound(`Club owner '${providedOwner}' not found.`);
            }

            const planOwnerId = plan.club_owner?.id || plan.club_owner;
            const planOwnerDocId = plan.club_owner?.documentId;

            if (
              planOwnerId &&
              Number(planOwnerId) !== Number(resolvedOwner.id) &&
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

        /* ---------- CREATE LOCAL SUBSCRIPTION ---------- */
        let createdSub: any = null;

        if ((strapi as any).documents) {
          try {
            createdSub = await (strapi as any).documents(LOCAL_SUB_UID).create({
              data: {
                client_detail: clientDocId || clientId,
                club_owner: targetClubOwnerDocId || targetClubOwnerId,
                local_membership_plan: planDocId || planId,
                membershipType: "local",
                startDate: startDate.toISOString(),
                endDate,
                subscriptionStatus: "active",
              },
              populate: {
                club_owner: {
                  populate: ["logo"],
                },
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
              club_owner: {
                populate: ["logo"],
              },
              local_membership_plan: true,
              client_detail: true,
            },
          });
        }

        // Relational guarantee
        if ((!createdSub?.club_owner || !createdSub?.client_detail) && createdSub?.id) {
          await strapi.db.query(LOCAL_SUB_UID).update({
            where: { id: createdSub.id },
            data: {
              client_detail: clientId,
              club_owner: targetClubOwnerId,
              local_membership_plan: planId,
            },
          });

          createdSub = await strapi.db.query(LOCAL_SUB_UID).findOne({
            where: { id: createdSub.id },
            populate: {
              club_owner: {
                populate: ["logo"],
              },
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

        const filters: any = {};
        if (membershipType) {
          filters.membershipType = membershipType;
        }
        if (subscriptionStatus) {
          filters.subscriptionStatus = subscriptionStatus;
        }

        if (roleName === "client") {
          const clientRecord = await getClientDetailForUser(user.id);
          if (!clientRecord) {
            return ctx.notFound("Client profile not found for this account");
          }

          filters.client_detail = { id: clientRecord.id };

          const data = await strapi.entityService.findMany(LOCAL_SUB_UID, {
            filters,
            populate: {
              club_owner: {
                populate: ["logo"],
              },
              local_membership_plan: true,
            },
            sort: { id: "desc" },
          });

          const list = Array.isArray(data) ? data : data ? [data] : [];
          return ctx.send({
            total: list.length,
            data: list,
          });
        } else if (roleName === "clubowner") {
          const ownerRecord = await getClubOwnerForUser(user.id);
          if (!ownerRecord) {
            return ctx.notFound("Club owner profile not found for this account");
          }

          filters.club_owner = { id: ownerRecord.id };

          const data = await strapi.entityService.findMany(LOCAL_SUB_UID, {
            filters,
            populate: {
              client_detail: true,
              local_membership_plan: true,
            },
            sort: { id: "desc" },
          });

          const list = Array.isArray(data) ? data : data ? [data] : [];
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

        const filters: any = {};

        if (membershipType) {
          filters.membershipType = membershipType;
        }
        if (subscriptionStatus) {
          filters.subscriptionStatus = subscriptionStatus;
        }

        // Role-based visibility enforcement
        if (roleName === "client") {
          const clientRecord = await getClientDetailForUser(user.id);
          if (clientRecord) {
            filters.client_detail = { id: clientRecord.id };
          }
        } else if (roleName === "clubowner") {
          const ownerRecord = await getClubOwnerForUser(user.id);
          if (ownerRecord) {
            filters.club_owner = { id: ownerRecord.id };
          }
        } else {
          // Admin / SuperAdmin can filter by query params
          if (client_detail) {
            const resolved = await resolveClientDetail(client_detail);
            if (resolved) {
              filters.client_detail = { id: resolved.id };
            }
          }
          if (club_owner) {
            const rawOwner = String(club_owner).trim();
            const isNum = !isNaN(Number(rawOwner)) && /^\d+$/.test(rawOwner);
            filters.club_owner = isNum
              ? { id: Number(rawOwner) }
              : { documentId: rawOwner };
          }
        }

        const data: any = await strapi.entityService.findMany(LOCAL_SUB_UID, {
          filters,
          populate: {
            club_owner: {
              populate: ["logo"],
            },
            client_detail: true,
            local_membership_plan: true,
          },
          sort: { id: "desc" },
        });

        const list = Array.isArray(data) ? data : data ? [data] : [];

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

        const isNumeric = !isNaN(Number(id)) && /^\d+$/.test(String(id).trim());

        const entity: any = await strapi.db.query(LOCAL_SUB_UID).findOne({
          where: isNumeric
            ? { $or: [{ documentId: String(id) }, { id: Number(id) }] }
            : { documentId: String(id) },
          populate: {
            club_owner: {
              populate: ["logo"],
            },
            client_detail: true,
            local_membership_plan: true,
          },
        });

        if (!entity) {
          return ctx.notFound("Local subscription not found");
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
        const isNumeric = !isNaN(Number(id)) && /^\d+$/.test(String(id).trim());

        const existing: any = await strapi.db.query(LOCAL_SUB_UID).findOne({
          where: isNumeric
            ? { $or: [{ documentId: String(id) }, { id: Number(id) }] }
            : { documentId: String(id) },
          populate: { club_owner: true, client_detail: true },
        });

        if (!existing) {
          return ctx.notFound("Local subscription not found");
        }

        if (roleName === "clubowner") {
          const ownerRecord = await getClubOwnerForUser(user.id);
          if (
            !ownerRecord ||
            (existing.club_owner?.id !== ownerRecord.id &&
              existing.club_owner?.documentId !== ownerRecord.documentId)
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

        const updated = await strapi.entityService.update(
          LOCAL_SUB_UID,
          existing.id,
          {
            data: updateData,
            populate: {
              club_owner: {
                populate: ["logo"],
              },
              client_detail: true,
              local_membership_plan: true,
            },
          },
        );

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
        const isNumeric = !isNaN(Number(id)) && /^\d+$/.test(String(id).trim());

        const existing: any = await strapi.db.query(LOCAL_SUB_UID).findOne({
          where: isNumeric
            ? { $or: [{ documentId: String(id) }, { id: Number(id) }] }
            : { documentId: String(id) },
          populate: { club_owner: true },
        });

        if (!existing) {
          return ctx.notFound("Local subscription not found");
        }

        if (roleName === "clubowner") {
          const ownerRecord = await getClubOwnerForUser(user.id);
          if (
            !ownerRecord ||
            (existing.club_owner?.id !== ownerRecord.id &&
              existing.club_owner?.documentId !== ownerRecord.documentId)
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

        await strapi.entityService.delete(LOCAL_SUB_UID, existing.id);

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
