import axios from "axios";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { normalizeIdentifier } from "../../../utils/normalize-identifier";
import { sendTwilioOtp } from "../../../services/twilio-sms";
import { cognitoForceChangePassword } from "../../../services/cognito-reset";

/* generate OTP */
const generateOtp = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

export default {

  /* =========================================================
      1) SEND RESET OTP
  ========================================================= */
  async sendOtp(ctx) {
    try {
      let { identifier } = ctx.request.body;
      if (!identifier) return ctx.badRequest("Identifier required");

      identifier = normalizeIdentifier(identifier);
      strapi.log.info(`[RESET OTP REQUEST] ${identifier}`);

      const email = identifier.includes("@") ? identifier : null;
      const phone = email ? null : identifier;

      const user = await strapi.db
        .query("plugin::users-permissions.user")
        .findOne({
          where: email ? { email } : { phoneNumber: phone },
        });

      if (!user) {
        strapi.log.warn(`[RESET OTP] User not found but response hidden (${identifier})`);
        return ctx.send({ message: "If account exists, OTP sent" });
      }

      const otp = generateOtp();
      const otpHash = await bcrypt.hash(otp, 10);

      /* SEND */
      if (email) {
        strapi.log.info(`[OTP SEND - EMAIL] ${identifier}`);
        await axios.post(
          "https://api.brevo.com/v3/smtp/email",
          {
            sender: { name: "FitFob", email: "amit@thexyzstudio.com" },
            to: [{ email }],
            subject: "FitFob Password Reset OTP",
            htmlContent: `<h2>Your OTP is <b>${otp}</b><br/>Valid for 2 minutes</h2>`,
          },
          { headers: { "api-key": process.env.BREVO_API_KEY } }
        );
      } else {
        strapi.log.info(`[OTP SEND - SMS] ${phone}`);
        await sendTwilioOtp(phone!, otp);
      }

      await strapi.db.query("api::otp-request.otp-request").deleteMany({
        where: { identifier, purpose: "reset_password" },
      });

      await strapi.entityService.create("api::otp-request.otp-request", {
        data: {
          identifier,
          otp_hash: otpHash,
          expires_at: new Date(Date.now() + 2 * 60 * 1000),
          attempts: 0,
          verified: false,
          purpose: "reset_password",
          last_sent_at: new Date(),
        },
      });

      strapi.log.info(`[OTP STORED] ${identifier}`);
      ctx.send({ message: "OTP sent successfully" });

    } catch (err) {
      strapi.log.error("[SEND OTP ERROR]", err);
      ctx.internalServerError("Unable to send OTP");
    }
  },

  /* =========================================================
      2) RESEND OTP
  ========================================================= */
  async resendOtp(ctx) {
    try {
      let { identifier } = ctx.request.body;
      identifier = normalizeIdentifier(identifier);

      strapi.log.info(`[RESEND OTP REQUEST] ${identifier}`);

      const existing = await strapi.db
        .query("api::otp-request.otp-request")
        .findOne({ where: { identifier, purpose: "reset_password" } });

      if (existing) {
        const now = Date.now();
        const last = new Date(existing.last_sent_at).getTime();

        if (now - last < 30000) {
          strapi.log.warn(`[RESEND BLOCKED - COOLDOWN] ${identifier}`);
          return ctx.badRequest("Please wait 30 seconds before requesting again");
        }
      }

      const otp = generateOtp();
      const otpHash = await bcrypt.hash(otp, 10);

      if (identifier.includes("@")) {
        strapi.log.info(`[RESEND EMAIL OTP] ${identifier}`);
        await axios.post(
          "https://api.brevo.com/v3/smtp/email",
          {
            sender: { name: "FitFob", email: "amit@thexyzstudio.com" },
            to: [{ email: identifier }],
            subject: "FitFob Password Reset OTP",
            htmlContent: `<h2>Your OTP is <b>${otp}</b><br/>Valid for 2 minutes</h2>`,
          },
          { headers: { "api-key": process.env.BREVO_API_KEY } }
        );
      } else {
        strapi.log.info(`[RESEND SMS OTP] ${identifier}`);
        await sendTwilioOtp(identifier, otp);
      }

      await strapi.db.query("api::otp-request.otp-request").deleteMany({
        where: { identifier, purpose: "reset_password" },
      });

      await strapi.entityService.create("api::otp-request.otp-request", {
        data: {
          identifier,
          otp_hash: otpHash,
          expires_at: new Date(Date.now() + 2 * 60 * 1000),
          attempts: 0,
          verified: false,
          purpose: "reset_password",
          last_sent_at: new Date(),
        },
      });

      strapi.log.info(`[OTP RESENT & STORED] ${identifier}`);
      ctx.send({ message: "OTP resent successfully" });

    } catch (err) {
      strapi.log.error("[RESEND OTP ERROR]", err);
      ctx.internalServerError("Unable to resend OTP");
    }
  },

  /* =========================================================
      3) VERIFY OTP
  ========================================================= */
  async verifyOtp(ctx) {
    try {
      let { identifier, otp } = ctx.request.body;
      identifier = normalizeIdentifier(identifier);

      strapi.log.info(`[OTP VERIFY ATTEMPT] ${identifier}`);

      const record = await strapi.db
        .query("api::otp-request.otp-request")
        .findOne({ where: { identifier, purpose: "reset_password" } });

      if (!record) {
        strapi.log.warn(`[OTP NOT FOUND] ${identifier}`);
        return ctx.badRequest("OTP not found");
      }

      if (new Date(record.expires_at) < new Date()) {
        strapi.log.warn(`[OTP EXPIRED] ${identifier}`);
        return ctx.badRequest("OTP expired");
      }

      const valid = await bcrypt.compare(otp, record.otp_hash);
      if (!valid) {
        strapi.log.warn(`[OTP INCORRECT] ${identifier}`);
        await strapi.db.query("api::otp-request.otp-request").update({
          where: { id: record.id },
          data: { attempts: record.attempts + 1 },
        });
        return ctx.badRequest("Incorrect OTP");
      }

      strapi.log.info(`[OTP VERIFIED] ${identifier}`);

      await strapi.db.query("api::otp-request.otp-request").delete({
        where: { id: record.id },
      });

      const token = crypto.randomBytes(32).toString("hex");

      await strapi.db.query("api::reset-password-session.reset-password-session")
        .deleteMany({ where: { identifier } });

      await strapi.db.query("api::reset-password-session.reset-password-session")
        .create({
          data: {
            identifier,
            token,
            expiresAt: new Date(Date.now() + 5 * 60 * 1000),
            used: false,
          },
        });

      strapi.log.info(`[RESET SESSION CREATED] ${identifier}`);

      ctx.send({ verified: true, resetToken: token });

    } catch (err) {
      strapi.log.error("[VERIFY OTP ERROR]", err);
      ctx.internalServerError("Verification failed");
    }
  },

  /* =========================================================
      4) RESET PASSWORD
  ========================================================= */
  async resetPassword(ctx) {
    try {
      let { identifier, password, confirmPassword, resetToken } = ctx.request.body;
      identifier = normalizeIdentifier(identifier);

      strapi.log.info(`[PASSWORD RESET ATTEMPT] ${identifier}`);

      if (password !== confirmPassword)
        return ctx.badRequest("Passwords do not match");

      const session = await strapi.db
        .query("api::reset-password-session.reset-password-session")
        .findOne({ where: { identifier, token: resetToken, used: false } });

      if (!session) {
        strapi.log.warn(`[INVALID RESET SESSION] ${identifier}`);
        return ctx.badRequest("Invalid or expired session");
      }

      if (new Date(session.expiresAt) < new Date()) {
        strapi.log.warn(`[RESET SESSION EXPIRED] ${identifier}`);
        return ctx.badRequest("Session expired");
      }

      const user = await strapi.db
        .query("plugin::users-permissions.user")
        .findOne({
          where: { $or: [{ email: identifier }, { phoneNumber: identifier }] },
        });

      if (!user) {
        strapi.log.error(`[USER NOT FOUND DURING RESET] ${identifier}`);
        return ctx.badRequest("User not found");
      }

      /* COGNITO */
      await cognitoForceChangePassword(user.cognitoSub, password);
      strapi.log.info(`[COGNITO PASSWORD UPDATED] ${identifier}`);

      /* STRAPI */
      const hashed = await bcrypt.hash(password, 10);
      await strapi.db.query("plugin::users-permissions.user").update({
        where: { id: user.id },
        data: { password: hashed },
      });

      strapi.log.info(`[STRAPI PASSWORD UPDATED] ${identifier}`);

      await strapi.db.query("api::reset-password-session.reset-password-session")
        .update({ where: { id: session.id }, data: { used: true } });

      strapi.log.info(`[RESET COMPLETE SUCCESS] ${identifier}`);

      ctx.send({ message: "Password reset successful" });

    } catch (err) {
      strapi.log.error("[RESET PASSWORD ERROR]", err);
      ctx.internalServerError("Password reset failed");
    }
  }
  
};