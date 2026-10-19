/**
 * client-activity-log controller
 */

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
    async find(ctx: Context) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);

        // Strictly for Admin & SuperAdmin
        if (roleName !== "admin" && roleName !== "superadmin") {
          return ctx.forbidden(
            "Access denied. Only Admin and SuperAdmin can access this endpoint.",
          );
        }

        const { documentId, clientDocumentId } = (ctx.query as any) || {};
        const paramDocId =
          (ctx.params as any)?.documentId || (ctx.params as any)?.id;

        const targetDocumentId = paramDocId || documentId || clientDocumentId;

        if (!targetDocumentId || !String(targetDocumentId).trim()) {
          return ctx.badRequest("Please provide client documentId");
        }

        const docId = String(targetDocumentId).trim();

        // 1. Fetch client details directly via PostgreSQL
        const clientRes = await strapi.db.connection.raw(
          `SELECT id, document_id, name 
           FROM client_details 
           WHERE document_id = ? 
           LIMIT 1`,
          [docId],
        );

        const client = clientRes?.rows?.[0];
        if (!client) {
          return ctx.notFound(`Client with documentId '${docId}' not found`);
        }

        // 2. Fetch all activity logs of that client in DESC order directly via PostgreSQL
        const logsRes = await strapi.db.connection.raw(
          `SELECT 
            al.created_at AS "createdAt",
            al.description,
            al.entity_name AS "entityName",
            al.action_type AS "actionType"
          FROM client_activity_logs al
          JOIN client_activity_logs_client_detail_lnk lnk ON lnk.client_activity_log_id = al.id
          WHERE lnk.client_detail_id = ?
          ORDER BY al.created_at DESC`,
          [client.id],
        );

        const rawLogs = logsRes?.rows || [];

        const data = rawLogs.map((row: any) => ({
          clientDocumentId: client.document_id,
          entityName: row.entityName,
          actionType: row.actionType,
          description: row.description,
          createdAt: row.createdAt,
        }));

        return ctx.send(data);
      } catch (error) {
        strapi.log.error("FIND CLIENT ACTIVITY LOGS ERROR:", error);
        return ctx.internalServerError("Failed to fetch client activity logs");
      }
    },
  }),
);
