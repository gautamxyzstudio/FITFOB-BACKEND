/**
 * notification controller
 */

import { factories } from "@strapi/strapi";
import { Context } from "koa";

const NOTIFICATION_UID = "api::notification.notification" as any;

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

export default factories.createCoreController(
  "api::notification.notification",
  ({ strapi }) => ({
   
    async find(ctx: Context) {
      try {
        const user = await getAuthUser(ctx);
        if (!user?.id) {
          return ctx.unauthorized("Authentication required");
        }

        const query = (ctx.query || {}) as any;

        // Strictly isolate notifications to the logged-in user
        ctx.query = {
          ...query,
          filters: {
            ...(query.filters || {}),
            users_permissions_user: {
              id: user.id,
            },
          },
          sort: query.sort || ["createdAt:desc"],
        };

        return await super.find(ctx);
      } catch (error) {
        strapi.log.error("Failed to fetch notifications:", error);
        return ctx.internalServerError("Failed to fetch notifications");
      }
    },

  })
);
