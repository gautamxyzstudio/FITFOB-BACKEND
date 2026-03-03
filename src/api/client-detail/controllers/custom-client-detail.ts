import { Context } from "koa";
import { generateQR } from "../../../utils/generateQr";

export default {
  async getMyQR(ctx: Context) {
    const user = ctx.state.user;

    if (!user) {
      return ctx.unauthorized("Login required");
    }

    if (user.role?.name !== "Client") {
      return ctx.forbidden("Only clients can access QR");
    }

    const client = await strapi.db
      .query("api::client-detail.client-detail")
      .findOne({
        where: { user: user.id },
      });

    if (!client) {
      return ctx.badRequest("Client profile not found");
    }

    const qrCode = await generateQR(client.clientId);

    ctx.body = {
      qrCode,
    };
  },
};