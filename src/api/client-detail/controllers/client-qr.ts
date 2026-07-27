import QRCode from "qrcode";
import sharp from "sharp";
import { Context } from "koa";

export default {
  async getQR(ctx: Context) {
    try {
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

      /* ============================================
         QR SETTINGS
      ============================================ */

      const width = 500;
      const margin = 2;

      const qrBuffer = await QRCode.toBuffer(client.clientId, {
        errorCorrectionLevel: "H",
        type: "png",
        width,
        margin,
        color: {
          dark: "#111111",
          light: "#FFFFFF",
        },
      });

      /* ============================================
         GET QR MODULE COUNT
      ============================================ */

      const qrData = QRCode.create(client.clientId, {
        errorCorrectionLevel: "H",
      });

      const moduleCount = qrData.modules.size;
      const totalModules = moduleCount + margin * 2;
      const moduleSize = width / totalModules;

      const red = "#E23744";

      /* ============================================
         FINDER CENTER POSITIONS
      ============================================ */

      const innerSize = moduleSize * 3;

      const cleanupPadding = 2;

      const cleanupSize = Math.ceil(innerSize) + cleanupPadding * 2;

      const topLeft = {
        left:
          Math.floor((margin + 2) * moduleSize) -
          cleanupPadding,

        top:
          Math.floor((margin + 2) * moduleSize) -
          cleanupPadding,
      };

      const topRight = {
        left:
          Math.floor(
            (margin + moduleCount - 5) * moduleSize
          ) - cleanupPadding,

        top:
          Math.floor((margin + 2) * moduleSize) -
          cleanupPadding,
      };

      const bottomLeft = {
        left:
          Math.floor((margin + 2) * moduleSize) -
          cleanupPadding,

        top:
          Math.floor(
            (margin + moduleCount - 5) * moduleSize
          ) - cleanupPadding,
      };

      /* ============================================
         CREATE CLEAN FINDER CENTER
      ============================================ */

      const redInset = cleanupPadding;

      const redSize =
        cleanupSize - redInset * 2;

      const finderCenter = Buffer.from(`
        <svg
          width="${cleanupSize}"
          height="${cleanupSize}"
          viewBox="0 0 ${cleanupSize} ${cleanupSize}"
          xmlns="http://www.w3.org/2000/svg"
        >

          <!--
            WHITE CLEANUP AREA

            Slightly larger than original black
            center so no black border survives.
          -->
          <rect
            x="0"
            y="0"
            width="${cleanupSize}"
            height="${cleanupSize}"
            fill="#FFFFFF"
          />

          <!-- RED ROUNDED CENTER -->
          <rect
            x="${redInset}"
            y="${redInset}"
            width="${redSize}"
            height="${redSize}"
            rx="8"
            ry="8"
            fill="${red}"
          />

        </svg>
      `);

      /* ============================================
         APPLY TO ALL 3 FINDER PATTERNS
      ============================================ */

      const styledQR = await sharp(qrBuffer)
        .composite([
          {
            input: finderCenter,
            left: topLeft.left,
            top: topLeft.top,
          },
          {
            input: finderCenter,
            left: topRight.left,
            top: topRight.top,
          },
          {
            input: finderCenter,
            left: bottomLeft.left,
            top: bottomLeft.top,
          },
        ])
        .png()
        .toBuffer();

      /* ============================================
         CONVERT TO BASE64
      ============================================ */

      const qrCode =
        `data:image/png;base64,${styledQR.toString("base64")}`;

      ctx.send({
        clientId: client.clientId,
        qrCode,
      });
    } catch (error) {
      console.error("QR generation error:", error);

      return ctx.internalServerError(
        "Failed to generate QR code"
      );
    }
  },
};