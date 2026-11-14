import { factories } from "@strapi/strapi";
import { Context } from "koa";

const CLUB_OWNER_UID = "api::club-owner.club-owner" as any;
const CLIENT_DETAIL_UID = "api::client-detail.client-detail" as any;

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

/* ---------- CLUB OWNER LOOKUP FOR AUTH USER ---------- */
async function getClubOwnerForUser(user: any) {
  if (!user) return null;
  const userId = typeof user === "object" ? user.id : user;

  let owner: any = await strapi.db.query(CLUB_OWNER_UID).findOne({
    where: { user: userId },
    select: ["id", "documentId", "clubId", "clubName", "ownerName"],
  });

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

  return owner || null;
}

/* ---------- CLIENT DETAIL LOOKUP FOR AUTH USER ---------- */
async function getClientDetailForUser(user: any) {
  if (!user) return null;
  const userId = typeof user === "object" ? user.id : user;

  let client: any = await strapi.db.query(CLIENT_DETAIL_UID).findOne({
    where: { user: userId },
    select: ["id", "documentId", "clientId", "name"],
  });

  if (!client) {
    const userWithDetail: any = await strapi.db
      .query("plugin::users-permissions.user")
      .findOne({
        where: { id: userId },
        select: ["id"],
        populate: {
          client_detail: {
            select: ["id", "documentId", "clientId", "name"],
          },
        },
      });

    client = userWithDetail?.client_detail || null;
  }

  return client || null;
}

export default factories.createCoreController(
  "api::activity-log.activity-log",
  ({ strapi }) => ({
    /**
     * GET /api/activity-logs/club-owner/:documentId
     * Fetch all activities for a club owner (self-performed + admin actions on this club owner)
     */
    async getClubOwnerLogs(ctx: Context) {
      try {
        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        const isAdmin = roleName === "admin" || roleName === "superadmin";

        const { documentId } = ctx.params as any;
        if (!documentId || !String(documentId).trim()) {
          return ctx.badRequest("Club owner documentId is required");
        }

        const targetDocId = String(documentId).trim();

        if (!isAdmin) {
          // Verify owner is only accessing their own logs
          const myOwner = await getClubOwnerForUser(user);
          if (
            !myOwner ||
            (myOwner.documentId !== targetDocId &&
              String(myOwner.id) !== targetDocId &&
              myOwner.clubId !== targetDocId)
          ) {
            return ctx.forbidden(
              "Access denied. You can only view your own activity logs.",
            );
          }
        }

        const service: any = strapi.service("api::activity-log.activity-log");
        const result = await service.getClubOwnerTimeline(targetDocId, ctx.query);

        if (!result) {
          return ctx.notFound(`Club owner '${targetDocId}' not found`);
        }

        return ctx.send(result);
      } catch (error) {
        strapi.log.error("GET CLUB OWNER LOGS ERROR:", error);
        return ctx.internalServerError("Failed to fetch club owner activity logs");
      }
    },

    /**
     * GET /api/activity-logs/client/:documentId
     * Fetch all activities for a client (self-performed + admin/club owner actions on this client)
     */
    async getClientLogs(ctx: Context) {
      try {
        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        const isAdmin = roleName === "admin" || roleName === "superadmin";

        const { documentId } = ctx.params as any;
        if (!documentId || !String(documentId).trim()) {
          return ctx.badRequest("Client documentId is required");
        }

        const targetDocId = String(documentId).trim();

        if (!isAdmin) {
          // Verify client is only accessing their own logs
          const myClient = await getClientDetailForUser(user);
          if (
            !myClient ||
            (myClient.documentId !== targetDocId &&
              String(myClient.id) !== targetDocId &&
              myClient.clientId !== targetDocId)
          ) {
            return ctx.forbidden(
              "Access denied. You can only view your own activity logs.",
            );
          }
        }

        const service: any = strapi.service("api::activity-log.activity-log");
        const result = await service.getClientTimeline(targetDocId, ctx.query);

        if (!result) {
          return ctx.notFound(`Client '${targetDocId}' not found`);
        }

        return ctx.send(result);
      } catch (error) {
        strapi.log.error("GET CLIENT LOGS ERROR:", error);
        return ctx.internalServerError("Failed to fetch client activity logs");
      }
    },

    /**
     * GET /api/activity-logs/admin
     * Fetch activities performed by Admin users
     */
    async getAdminLogs(ctx: Context) {
      try {
        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        if (roleName !== "admin" && roleName !== "superadmin") {
          return ctx.forbidden(
            "Access denied. Only Admins can access admin activity logs.",
          );
        }

        const service: any = strapi.service("api::activity-log.activity-log");
        const result = await service.getAdminTimeline(ctx.query);

        return ctx.send(result);
      } catch (error) {
        strapi.log.error("GET ADMIN LOGS ERROR:", error);
        return ctx.internalServerError("Failed to fetch admin activity logs");
      }
    },

    /**
     * GET /api/activity-logs/entity/:entityName/:entityId
     * Fetch activities for a specific entity
     */
    async getEntityLogs(ctx: Context) {
      try {
        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        if (roleName !== "admin" && roleName !== "superadmin") {
          return ctx.forbidden(
            "Access denied. Only Admins can access entity activity logs.",
          );
        }

        const { entityName, entityId } = ctx.params as any;
        if (!entityName || !entityId) {
          return ctx.badRequest("entityName and entityId are required");
        }

        const service: any = strapi.service("api::activity-log.activity-log");
        const result = await service.getEntityTimeline(
          entityName,
          entityId,
          ctx.query,
        );

        return ctx.send(result);
      } catch (error) {
        strapi.log.error("GET ENTITY LOGS ERROR:", error);
        return ctx.internalServerError("Failed to fetch entity activity logs");
      }
    },

    /**
     * GET /api/activity-logs/me
     * Automatically returns the relevant activity logs for whoever is currently logged in.
     */
    async getMyLogs(ctx: Context) {
      try {
        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        const service: any = strapi.service("api::activity-log.activity-log");

        if (roleName === "admin" || roleName === "superadmin") {
          const result = await service.getAdminTimeline({
            ...ctx.query,
            adminUserId: user.id,
          });
          return ctx.send(result);
        }

        const owner = await getClubOwnerForUser(user);
        if (owner) {
          const result = await service.getClubOwnerTimeline(
            owner.documentId || owner.id,
            ctx.query,
          );
          return ctx.send(result);
        }

        const client = await getClientDetailForUser(user);
        if (client) {
          const result = await service.getClientTimeline(
            client.documentId || client.id,
            ctx.query,
          );
          return ctx.send(result);
        }

        return ctx.notFound("No active profile found for this user");
      } catch (error) {
        strapi.log.error("GET MY LOGS ERROR:", error);
        return ctx.internalServerError("Failed to fetch your activity logs");
      }
    },
  }),
);
