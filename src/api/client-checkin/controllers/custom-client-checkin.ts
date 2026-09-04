import { Context } from "koa";

export default {

  async scan(ctx: Context) {

    const user = ctx.state.user;

    if (!user) {
      return ctx.unauthorized("Authentication required");
    }

    const { clientId } = ctx.request.body;

    if (!clientId) {
      return ctx.badRequest("clientId required");
    }

    const result = await strapi
      .service("api::client-checkin.custom-client-checkin")
      .scan(clientId, user.id);

    ctx.send(result);
  },

  async confirmOutdoor(ctx: Context) {

    const user = ctx.state.user;

    if (!user) {
      return ctx.unauthorized("Authentication required");
    }

    const { clientId } = ctx.request.body;

    if (!clientId) {
      return ctx.badRequest("clientId required");
    }

    const result = await strapi
      .service("api::client-checkin.custom-client-checkin")
      .confirmOutdoor(clientId, user.id);

    ctx.send(result);
  },

  async checkout(ctx: Context) {
    const user = ctx.state.user;

    if (!user) {
      return ctx.unauthorized("Authentication required");
    }

    const { clientId } = ctx.request.body;

    if (!clientId) {
      return ctx.badRequest("clientId required");
    }

    const result = await strapi
      .service("api::client-checkin.custom-client-checkin")
      .checkout(clientId, user.id);

    ctx.send(result);
  },

async manualCheckin(ctx: Context) {
    try {
      const user = ctx.state.user;

      if (!user) {
        return ctx.unauthorized("Authentication required");
      }

      const { clientId } = ctx.request.body;

      if (!clientId) {
        return ctx.badRequest("clientId required");
      }

      const result = await strapi
        .service("api::client-checkin.custom-client-checkin")
        .manualCheckin(clientId, user.id);

      ctx.send(result);
    } catch (error: any) {
      return ctx.badRequest(error.message);
    }
  },


};