import { factories } from "@strapi/strapi";
import { Context } from "koa";

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

  let owner: any = await strapi.db.query("api::club-owner.club-owner").findOne({
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

export default factories.createCoreController(
  "api::club-owner-activity-log.club-owner-activity-log",
  ({ strapi }) => ({
    /**
     * Legacy route: GET /api/club-owner-activity-logs/me
     */
    async getMyLogs(ctx: Context) {
      try {
        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const owner = await getClubOwnerForUser(user);
        if (!owner) {
          return ctx.notFound("Club owner profile not found for this user");
        }

        const service: any = strapi.service("api::activity-log.activity-log");
        const result = await service.getClubOwnerTimeline(
          owner.documentId || owner.id,
          ctx.query,
        );

        if (!result) {
          return ctx.send({ data: [], meta: { pagination: { page: 1, pageSize: 20, pageCount: 1, total: 0 } } });
        }

        return ctx.send(result);
      } catch (error) {
        strapi.log.error("GET MY ACTIVITY LOGS ERROR:", error);
        return ctx.internalServerError("Failed to fetch activity logs");
      }
    },

    /**
     * Legacy route: GET /api/club-owner-activity-logs?documentId=...
     */
    async find(ctx: Context) {
      try {
        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        if (roleName !== "admin" && roleName !== "superadmin") {
          return ctx.forbidden(
            "Access denied. Only Admin and SuperAdmin can access this endpoint.",
          );
        }

        const { documentId, ownerDocumentId } = (ctx.query as any) || {};
        const paramDocId = (ctx.params as any)?.documentId || (ctx.params as any)?.id;
        const targetDocumentId = documentId || ownerDocumentId || paramDocId;

        if (!targetDocumentId || !String(targetDocumentId).trim()) {
          return ctx.badRequest("Please provide owner documentId");
        }

        const service: any = strapi.service("api::activity-log.activity-log");
        const result = await service.getClubOwnerTimeline(
          String(targetDocumentId).trim(),
          { ...ctx.query, pageSize: ctx.query.pageSize || 100 },
        );

        if (!result) {
          return ctx.notFound(
            `Club owner with documentId '${targetDocumentId}' not found`,
          );
        }

        // Return array directly for legacy frontend compatibility (e.g. getClubOwnerActivityLogsApi)
        return ctx.send(result.data);
      } catch (error) {
        strapi.log.error("FIND CLUB OWNER ACTIVITY LOGS ERROR:", error);
        return ctx.internalServerError("Failed to fetch activity logs");
      }
    },
  }),
);
