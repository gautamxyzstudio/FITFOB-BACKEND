import QRCode from "qrcode";
import { Context } from "koa";

export default {

  async getQR(ctx: Context) {
    const user = ctx.state.user;

    if (!user) {
      return ctx.unauthorized("Login required");
    }

    const client = await strapi.db
      .query("api::client-detail.client-detail")
      .findOne({
        where: { user: user.id },
      });

    if (!client) {
      return ctx.badRequest("Client profile not found");
    }

    const qr = await QRCode.toDataURL(client.clientId);

    ctx.send({
      clientId: client.clientId,
      qrCode: qr,
    });
  },

};