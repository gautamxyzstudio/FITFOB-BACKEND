import bcrypt from "bcryptjs";
import axios from "axios";
import { normalizeIdentifier } from "../../../utils/normalize-identifier";
import { sendTwilioOtp } from "../../../services/twilio-sms";

const generateOtp = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

const normalizePhone = (identifier: string) => {
  if (identifier.includes("@")) return identifier.trim().toLowerCase();

  let num = identifier.replace(/\D/g, "");
  if (num.length === 10) return `+91${num}`;
  if (num.length === 12 && num.startsWith("91")) return `+${num}`;

  return identifier;
};

export default {
  async resend(ctx: any) {
    try {
      let { identifier } = ctx.request.body;

      identifier = normalizeIdentifier(identifier);
      identifier = normalizePhone(identifier);

      /* FIND SESSION */
      const pending = await strapi.db
        .query("api::pending-signup.pending-signup")
        .findOne({ where: { identifier } });

      if (!pending)
        return ctx.badRequest("Signup session expired. Please register again.");

      /* CHECK SESSION EXPIRY */
      if (Date.now() > Number(pending.expiresAt)) {
        await strapi.entityService.delete(
          "api::pending-signup.pending-signup",
          pending.id
        );
        return ctx.badRequest("Signup session expired. Please register again.");
      }

      /* CREATE NEW OTP */
      const otp = generateOtp();
      const otpHash = await bcrypt.hash(otp, 10);

      await strapi.db.query("api::otp-request.otp-request").deleteMany({
        where: { identifier, purpose: "register" },
      });

      await strapi.entityService.create("api::otp-request.otp-request", {
        data: {
          identifier,
          otp_hash: otpHash,
          expires_at: new Date(Date.now() + 2 * 60 * 1000),
          attempts: 0,
          verified: false,
          purpose: "register",
          last_sent_at: new Date(),
        },
      });

      /* SEND */
      if (identifier.includes("@")) {
        await axios.post(
          "https://api.brevo.com/v3/smtp/email",
          {
            sender: { name: "FitFob", email: "amit@thexyzstudio.com" },
            to: [{ email: identifier }],
            subject: "Your FitFob OTP",
            htmlContent: `<h2>Your OTP is <b>${otp}</b></h2>`,
          },
          { headers: { "api-key": process.env.BREVO_API_KEY } }
        );
      } else {
        await sendTwilioOtp(identifier, otp);
      }

      ctx.send({ message: "OTP resent successfully" });

    } catch (err) {
      strapi.log.error("RESEND OTP ERROR", err);
      ctx.internalServerError("Failed to resend OTP");
    }
  },
};