import { factories } from "@strapi/strapi";

const OUTDOOR_SUB_UID =
  "api::outdoor-subscription.outdoor-subscription" as any;
const OUTDOOR_PLAN_UID =
  "api::outdoor-membership-plan.outdoor-membership-plan" as any;
const CLIENT_UID = "api::client-detail.client-detail" as any;

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
async function getClientDetailForUser(userId: number) {
  const userWithDetail: any = await strapi.db
    .query("plugin::users-permissions.user")
    .findOne({
      where: { id: userId },
      populate: {
        client_detail: true,
      },
    });

  if (
    userWithDetail?.client_detail?.id ||
    userWithDetail?.client_detail?.documentId
  ) {
    return userWithDetail.client_detail;
  }

  const directClient: any = await strapi.db.query(CLIENT_UID).findOne({
    where: {
      $or: [{ user: userId }, { user: { id: userId } }],
    },
  });

  return directClient || null;
}

/* ---------- HELPER: RESOLVE CLIENT DETAIL BY VARIOUS IDENTIFIERS ---------- */
async function resolveClientDetail(identifier: string | number | any) {
  if (!identifier) return null;

  if (typeof identifier === "object" && identifier !== null) {
    if (Array.isArray(identifier) && identifier.length > 0) {
      identifier = identifier[0];
    }
    if (typeof identifier === "object") {
      identifier =
        identifier.documentId ||
        identifier.id ||
        identifier.clientId ||
        (Array.isArray(identifier.connect) ? identifier.connect[0] : null);
    }
  }

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

  let client = await strapi.db.query(CLIENT_UID).findOne({
    where: {
      $or: whereConditions,
    },
  });

  if (!client && isNumeric) {
    client = await getClientDetailForUser(Number(rawStr));
  }

  return client || null;
}

/* ---------- HELPER: RESOLVE OUTDOOR PLAN ---------- */
async function resolveOutdoorPlan(identifier: string | number | any) {
  if (!identifier) return null;

  if (typeof identifier === "object" && identifier !== null) {
    if (Array.isArray(identifier) && identifier.length > 0) {
      identifier = identifier[0];
    }
    if (typeof identifier === "object") {
      identifier =
        identifier.documentId ||
        identifier.id ||
        (Array.isArray(identifier.connect) ? identifier.connect[0] : null);
    }
  }

  if (!identifier) return null;

  const rawStr = String(identifier).trim();
  const isNumeric = !isNaN(Number(rawStr)) && /^\d+$/.test(rawStr);

  const plan = await strapi.db.query(OUTDOOR_PLAN_UID).findOne({
    where: isNumeric
      ? { $or: [{ documentId: rawStr }, { id: Number(rawStr) }] }
      : { documentId: rawStr },
  });

  return plan || null;
}

export default factories.createCoreController(
  "api::outdoor-subscription.outdoor-subscription",
  ({ strapi }) => ({
    /* =======================================================
       1. BUY OUTDOOR MEMBERSHIP (CLIENT - ONLINE / APP)
       membershipType: "app"
       totalVisitsAllowed: plan.visitAllowed
       usedVisits: 0
       remainingVisits: plan.visitAllowed
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
            "Access denied. Only registered clients can buy outdoor passes online.",
          );
        }

        const clientRecord = await getClientDetailForUser(user.id);
        if (!clientRecord) {
          return ctx.badRequest(
            "Client profile not found for this account. Please complete client profile registration first.",
          );
        }

        const body = ctx.request.body;
        const payload = body?.data ? body.data : body || {};

        const { outdoor_membership_plan } = payload;

        if (!outdoor_membership_plan) {
          return ctx.badRequest(
            "outdoor_membership_plan is required (provide plan documentId or numeric id)",
          );
        }

        const plan = await resolveOutdoorPlan(outdoor_membership_plan);
        if (!plan) {
          return ctx.notFound("Outdoor membership plan not found");
        }

        if (plan.isActive === false) {
          return ctx.badRequest(
            "This outdoor membership plan is currently inactive and cannot be purchased.",
          );
        }

        const visits = Number(plan.visitAllowed) || 0;
        const clientId = clientRecord.id;
        const clientDocId = clientRecord.documentId;
        const planId = plan.id;
        const planDocId = plan.documentId;

        /* ---------- CHECK EXISTING ACTIVE SUBSCRIPTION (SAME PLAN) ---------- */
        let existingSub: any = null;

        if ((strapi as any).documents && clientDocId && planDocId) {
          try {
            existingSub = await (strapi as any).documents(OUTDOOR_SUB_UID).findFirst({
              filters: {
                $and: [
                  {
                    client_detail: {
                      $or: [
                        { documentId: clientDocId },
                        { id: clientId },
                      ],
                    },
                  },
                  {
                    outdoor_membership_plan: {
                      $or: [
                        { documentId: planDocId },
                        { id: planId },
                      ],
                    },
                  },
                  {
                    subscriptionStatus: "active",
                  },
                ],
              },
            });
          } catch (_) {}
        }

        if (!existingSub) {
          existingSub = await strapi.db.query(OUTDOOR_SUB_UID).findOne({
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
                    { outdoor_membership_plan: planId },
                    { outdoor_membership_plan: { id: planId } },
                    { outdoor_membership_plan: { documentId: planDocId } },
                  ],
                },
                { subscriptionStatus: "active" },
              ],
            },
            orderBy: { id: "desc" },
          });
        }

        if (existingSub) {
          const isVisitsExhausted =
            existingSub.remainingVisits !== undefined &&
            existingSub.remainingVisits !== null &&
            Number(existingSub.remainingVisits) <= 0;

          if (isVisitsExhausted) {
            try {
              if ((strapi as any).documents && existingSub.documentId) {
                await (strapi as any).documents(OUTDOOR_SUB_UID).update({
                  documentId: existingSub.documentId,
                  data: { subscriptionStatus: "expired" },
                });
              } else {
                await strapi.db.query(OUTDOOR_SUB_UID).update({
                  where: { id: existingSub.id },
                  data: { subscriptionStatus: "expired" },
                });
              }
            } catch (_) {}
          } else {
            return ctx.badRequest(
              "You already have an active subscription for this membership plan.",
            );
          }
        }

        /* ---------- CREATE APP OUTDOOR SUBSCRIPTION ---------- */
        let createdSub: any = null;

        if ((strapi as any).documents) {
          try {
            createdSub = await (strapi as any)
              .documents(OUTDOOR_SUB_UID)
              .create({
                data: {
                  client_detail: clientDocId || clientId,
                  outdoor_membership_plan: planDocId || planId,
                  membershipType: "app",
                  totalVisitsAllowed: visits,
                  usedVisits: 0,
                  remainingVisits: visits,
                  subscriptionStatus: "active",
                },
                populate: {
                  client_detail: true,
                  outdoor_membership_plan: true,
                },
              });
          } catch (docErr) {
            strapi.log.warn("Documents API create fallback in outdoor buy:", docErr);
          }
        }

        if (!createdSub) {
          createdSub = await strapi.entityService.create(OUTDOOR_SUB_UID, {
            data: {
              client_detail: clientId,
              outdoor_membership_plan: planId,
              membershipType: "app",
              totalVisitsAllowed: visits,
              usedVisits: 0,
              remainingVisits: visits,
              subscriptionStatus: "active",
            },
            populate: {
              client_detail: true,
              outdoor_membership_plan: true,
            },
          });
        }

        // Relational guarantee
        if (!createdSub?.client_detail && createdSub?.id) {
          await strapi.db.query(OUTDOOR_SUB_UID).update({
            where: { id: createdSub.id },
            data: {
              client_detail: clientId,
              outdoor_membership_plan: planId,
            },
          });

          createdSub = await strapi.db.query(OUTDOOR_SUB_UID).findOne({
            where: { id: createdSub.id },
            populate: {
              client_detail: true,
              outdoor_membership_plan: true,
            },
          });
        }

        return ctx.send(
          {
            message: "Outdoor pass purchased successfully via app",
            data: createdSub,
          },
          201,
        );
      } catch (error) {
        strapi.log.error("BUY OUTDOOR SUBSCRIPTION ERROR:", error);
        return ctx.internalServerError("Failed to purchase outdoor pass");
      }
    },

    /* =======================================================
       2. MANUAL / OFFLINE OUTDOOR PASS CREATION (ADMIN / OWNER)
       membershipType: "local"
    ======================================================= */
    async create(ctx) {
      try {
        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        if (roleName !== "admin" && roleName !== "superadmin") {
          return ctx.forbidden(
            "Access denied. Only Admin and SuperAdmin can assign outdoor memberships.",
          );
        }

        const body = ctx.request.body;
        const payload = body?.data ? body.data : body || {};

        const rawClient =
          payload.client_detail ||
          payload.client ||
          payload.clientId ||
          payload.client_id ||
          payload.clientDetail ||
          payload.user;

        const rawPlan =
          payload.outdoor_membership_plan ||
          payload.plan ||
          payload.planId ||
          payload.plan_id ||
          payload.outdoorPlan ||
          payload.membership_plan;

        if (!rawClient) {
          return ctx.badRequest(
            "client_detail is required (provide documentId, clientId, phone, email, or id)",
          );
        }

        if (!rawPlan) {
          return ctx.badRequest(
            "outdoor_membership_plan is required (provide plan documentId or id)",
          );
        }

        const clientRecord = await resolveClientDetail(rawClient);
        if (!clientRecord) {
          return ctx.notFound(
            `Client matching '${JSON.stringify(rawClient)}' not found.`,
          );
        }

        const plan = await resolveOutdoorPlan(rawPlan);
        if (!plan) {
          return ctx.notFound("Outdoor membership plan not found");
        }

        const visits = Number(plan.visitAllowed) || 0;
        const clientId = clientRecord.id;
        const clientDocId = clientRecord.documentId;
        const planId = plan.id;
        const planDocId = plan.documentId;

        /* ---------- CHECK EXISTING ACTIVE SUBSCRIPTION (SAME PLAN) ---------- */
        let existingSub: any = null;

        if ((strapi as any).documents && clientDocId && planDocId) {
          try {
            existingSub = await (strapi as any).documents(OUTDOOR_SUB_UID).findFirst({
              filters: {
                $and: [
                  {
                    client_detail: {
                      $or: [
                        { documentId: clientDocId },
                        { id: clientId },
                      ],
                    },
                  },
                  {
                    outdoor_membership_plan: {
                      $or: [
                        { documentId: planDocId },
                        { id: planId },
                      ],
                    },
                  },
                  {
                    subscriptionStatus: "active",
                  },
                ],
              },
            });
          } catch (_) {}
        }

        if (!existingSub) {
          existingSub = await strapi.db.query(OUTDOOR_SUB_UID).findOne({
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
                    { outdoor_membership_plan: planId },
                    { outdoor_membership_plan: { id: planId } },
                    { outdoor_membership_plan: { documentId: planDocId } },
                  ],
                },
                { subscriptionStatus: "active" },
              ],
            },
            orderBy: { id: "desc" },
          });
        }

        if (existingSub) {
          const isVisitsExhausted =
            existingSub.remainingVisits !== undefined &&
            existingSub.remainingVisits !== null &&
            Number(existingSub.remainingVisits) <= 0;

          if (isVisitsExhausted) {
            try {
              if ((strapi as any).documents && existingSub.documentId) {
                await (strapi as any).documents(OUTDOOR_SUB_UID).update({
                  documentId: existingSub.documentId,
                  data: { subscriptionStatus: "expired" },
                });
              } else {
                await strapi.db.query(OUTDOOR_SUB_UID).update({
                  where: { id: existingSub.id },
                  data: { subscriptionStatus: "expired" },
                });
              }
            } catch (_) {}
          } else {
            return ctx.badRequest(
              "An active subscription for this membership plan already exists for this user.",
            );
          }
        }

        /* ---------- CREATE LOCAL OUTDOOR SUBSCRIPTION ---------- */
        let createdSub: any = null;

        if ((strapi as any).documents) {
          try {
            createdSub = await (strapi as any)
              .documents(OUTDOOR_SUB_UID)
              .create({
                data: {
                  client_detail: clientDocId || clientId,
                  outdoor_membership_plan: planDocId || planId,
                  membershipType: "local",
                  totalVisitsAllowed: visits,
                  usedVisits: 0,
                  remainingVisits: visits,
                  subscriptionStatus: "active",
                },
                populate: {
                  client_detail: true,
                  outdoor_membership_plan: true,
                },
              });
          } catch (docErr) {
            strapi.log.warn("Documents API create fallback in create:", docErr);
          }
        }

        if (!createdSub) {
          createdSub = await strapi.entityService.create(OUTDOOR_SUB_UID, {
            data: {
              client_detail: clientId,
              outdoor_membership_plan: planId,
              membershipType: "local",
              totalVisitsAllowed: visits,
              usedVisits: 0,
              remainingVisits: visits,
              subscriptionStatus: "active",
            },
            populate: {
              client_detail: true,
              outdoor_membership_plan: true,
            },
          });
        }

        // Relational guarantee
        if (!createdSub?.client_detail && createdSub?.id) {
          await strapi.db.query(OUTDOOR_SUB_UID).update({
            where: { id: createdSub.id },
            data: {
              client_detail: clientId,
              outdoor_membership_plan: planId,
            },
          });

          createdSub = await strapi.db.query(OUTDOOR_SUB_UID).findOne({
            where: { id: createdSub.id },
            populate: {
              client_detail: true,
              outdoor_membership_plan: true,
            },
          });
        }

        return ctx.send(
          {
            message: "Outdoor membership pass assigned successfully",
            data: createdSub,
          },
          201,
        );
      } catch (error) {
        strapi.log.error("CREATE OUTDOOR SUBSCRIPTION ERROR:", error);
        return ctx.internalServerError("Failed to assign outdoor membership");
      }
    },

    /* =======================================================
       3. GET MY OUTDOOR SUBSCRIPTIONS (CLIENT)
    ======================================================= */
    async getMySubscriptions(ctx) {
      try {
        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const clientRecord = await getClientDetailForUser(user.id);
        if (!clientRecord) {
          return ctx.notFound("Client profile not found for this account");
        }

        const { membershipType, subscriptionStatus } = ctx.query as any;
        const filters: any = {
          client_detail: { id: clientRecord.id },
        };

        if (membershipType) {
          filters.membershipType = membershipType;
        }
        if (subscriptionStatus) {
          filters.subscriptionStatus = subscriptionStatus;
        }

        const data = await strapi.entityService.findMany(OUTDOOR_SUB_UID, {
          filters,
          populate: {
            outdoor_membership_plan: true,
          },
          sort: { id: "desc" },
        });

        const list = Array.isArray(data) ? data : data ? [data] : [];
        return ctx.send({
          total: list.length,
          data: list,
        });
      } catch (error) {
        strapi.log.error("GET MY OUTDOOR SUBSCRIPTIONS ERROR:", error);
        return ctx.internalServerError("Failed to fetch outdoor passes");
      }
    },

    /* =======================================================
       4. FIND ALL / FILTER OUTDOOR SUBSCRIPTIONS
    ======================================================= */
    async find(ctx) {
      try {
        const user = ctx.state.user;
        const roleName = user ? await getUserRole(user) : "";

        const { membershipType, subscriptionStatus, client_detail } =
          ctx.query as any;

        const filters: any = {};

        if (membershipType) {
          filters.membershipType = membershipType;
        }
        if (subscriptionStatus) {
          filters.subscriptionStatus = subscriptionStatus;
        }

        if (roleName === "client") {
          const clientRecord = await getClientDetailForUser(user.id);
          if (clientRecord) {
            filters.client_detail = { id: clientRecord.id };
          }
        } else if (client_detail) {
          const resolved = await resolveClientDetail(client_detail);
          if (resolved) {
            filters.client_detail = { id: resolved.id };
          }
        }

        const data: any = await strapi.entityService.findMany(OUTDOOR_SUB_UID, {
          filters,
          populate: {
            client_detail: true,
            outdoor_membership_plan: true,
          },
          sort: { id: "desc" },
        });

        const list = Array.isArray(data) ? data : data ? [data] : [];

        return ctx.send({
          total: list.length,
          data: list,
        });
      } catch (error) {
        strapi.log.error("FIND OUTDOOR SUBSCRIPTIONS ERROR:", error);
        return ctx.internalServerError("Failed to fetch outdoor passes");
      }
    },

    /* =======================================================
       5. GET SINGLE OUTDOOR SUBSCRIPTION
    ======================================================= */
    async findOne(ctx) {
      try {
        const { id } = ctx.params;

        if (id === "my-subscriptions" || id === "me") {
          return await (this as any).getMySubscriptions(ctx);
        }

        const isNumeric = !isNaN(Number(id)) && /^\d+$/.test(String(id).trim());

        const entity: any = await strapi.db.query(OUTDOOR_SUB_UID).findOne({
          where: isNumeric
            ? { $or: [{ documentId: String(id) }, { id: Number(id) }] }
            : { documentId: String(id) },
          populate: {
            client_detail: true,
            outdoor_membership_plan: true,
          },
        });

        if (!entity) {
          return ctx.notFound("Outdoor subscription not found");
        }

        return ctx.send({
          data: entity,
        });
      } catch (error) {
        strapi.log.error("FIND ONE OUTDOOR SUBSCRIPTION ERROR:", error);
        return ctx.internalServerError("Failed to fetch outdoor pass");
      }
    },

    /* =======================================================
       6. UPDATE OUTDOOR SUBSCRIPTION (ADMIN / SUPERADMIN ONLY)
    ======================================================= */
    async update(ctx) {
      try {
        const { id } = ctx.params;
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        if (roleName !== "admin" && roleName !== "superadmin") {
          return ctx.forbidden(
            "Access denied. Only Admin and SuperAdmin can modify outdoor passes.",
          );
        }

        const isNumeric = !isNaN(Number(id)) && /^\d+$/.test(String(id).trim());

        const existing: any = await strapi.db.query(OUTDOOR_SUB_UID).findOne({
          where: isNumeric
            ? { $or: [{ documentId: String(id) }, { id: Number(id) }] }
            : { documentId: String(id) },
        });

        if (!existing) {
          return ctx.notFound("Outdoor subscription not found");
        }

        const body = ctx.request.body;
        const payload = body?.data ? body.data : body || {};

        const { subscriptionStatus, remainingVisits, usedVisits } = payload;
        const updateData: any = {};

        if (subscriptionStatus !== undefined) {
          updateData.subscriptionStatus = subscriptionStatus;
        }

        if (remainingVisits !== undefined) {
          updateData.remainingVisits = Number(remainingVisits);
        }

        if (usedVisits !== undefined) {
          updateData.usedVisits = Number(usedVisits);
        }

        const updated = await strapi.entityService.update(
          OUTDOOR_SUB_UID,
          existing.id,
          {
            data: updateData,
            populate: {
              client_detail: true,
              outdoor_membership_plan: true,
            },
          },
        );

        return ctx.send({
          message: "Outdoor subscription updated successfully",
          data: updated,
        });
      } catch (error) {
        strapi.log.error("UPDATE OUTDOOR SUBSCRIPTION ERROR:", error);
        return ctx.internalServerError("Failed to update outdoor pass");
      }
    },

    /* =======================================================
       7. DELETE OUTDOOR SUBSCRIPTION (ADMIN / SUPERADMIN ONLY)
    ======================================================= */
    async delete(ctx) {
      try {
        const { id } = ctx.params;
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        if (roleName !== "admin" && roleName !== "superadmin") {
          return ctx.forbidden(
            "Access denied. Only Admin and SuperAdmin can delete outdoor passes.",
          );
        }

        const isNumeric = !isNaN(Number(id)) && /^\d+$/.test(String(id).trim());

        const existing: any = await strapi.db.query(OUTDOOR_SUB_UID).findOne({
          where: isNumeric
            ? { $or: [{ documentId: String(id) }, { id: Number(id) }] }
            : { documentId: String(id) },
        });

        if (!existing) {
          return ctx.notFound("Outdoor subscription not found");
        }

        await strapi.entityService.delete(OUTDOOR_SUB_UID, existing.id);

        return ctx.send({
          message: "Outdoor subscription deleted successfully",
          deleted: existing,
        });
      } catch (error) {
        strapi.log.error("DELETE OUTDOOR SUBSCRIPTION ERROR:", error);
        return ctx.internalServerError("Failed to delete outdoor pass");
      }
    },
  })
);
