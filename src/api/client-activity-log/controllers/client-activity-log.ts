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

export default factories.createCoreController(
  "api::client-activity-log.client-activity-log",
  ({ strapi }) => ({
    /**
     * Legacy route: GET /api/client-activity-logs?documentId=...
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

        const { documentId, clientDocumentId } = (ctx.query as any) || {};
        const paramDocId = (ctx.params as any)?.documentId || (ctx.params as any)?.id;
        const targetDocumentId = paramDocId || documentId || clientDocumentId;

        if (!targetDocumentId || !String(targetDocumentId).trim()) {
          return ctx.badRequest("Please provide client documentId");
        }

        const service: any = strapi.service("api::activity-log.activity-log");
        const result = await service.getClientTimeline(
          String(targetDocumentId).trim(),
          { ...ctx.query, pageSize: ctx.query.pageSize || 100 },
        );

        if (!result) {
          return ctx.notFound(
            `Client with documentId '${targetDocumentId}' not found`,
          );
        }

        // Return array directly for legacy frontend compatibility (e.g. getClientActivityLogsApi)
        return ctx.send(result.data);
      } catch (error) {
        strapi.log.error("FIND CLIENT ACTIVITY LOGS ERROR:", error);
        return ctx.internalServerError("Failed to fetch client activity logs");
      }
    },
  }),
);
