import { Context } from "koa";

export default {
  async scan(ctx: Context) {
    try {
      const user = ctx.state.user;

      if (!user) {
        return ctx.unauthorized("Authentication required");
      }

      const { clientId } = ctx.request.body || {};

      if (!clientId) {
        return ctx.badRequest("clientId required");
      }

      const result = await strapi
        .service("api::client-checkin.custom-client-checkin")
        .scan(clientId, user.id);

      return ctx.send(result);
    } catch (error: any) {
      return ctx.badRequest(error.message || "Failed to process check-in");
    }
  },
};
