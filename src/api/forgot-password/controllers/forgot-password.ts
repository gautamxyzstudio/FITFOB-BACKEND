import axios from "axios";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { normalizeIdentifier } from "../../../utils/normalize-identifier";
import { sendTwilioOtp } from "../../../services/twilio-sms";
import { cognitoForceChangePassword } from "../../../services/cognito-reset";

/* post-response logger */
const afterResponse = (ctx, fn: () => void) => {
  if (!ctx?.res) return fn();

  ctx.res.once("finish", () => {
    setTimeout(fn, 0);
  });
};

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

      const email = identifier.includes("@") ? identifier : null;
      const phone = email ? null : identifier;

      const user = await strapi.db
        .query("plugin::users-permissions.user")
        .findOne({
          where: email ? { email } : { phoneNumber: phone },
        });

      if (!user) {
        afterResponse(ctx, () => {
          strapi.log.warn(`[RESET OTP] User not found but response hidden (${identifier})`);
        });

        return ctx.send({ message: "If account exists, OTP sent" });
      }

      const otp = generateOtp();
      const otpHash = await bcrypt.hash(otp, 10);

      /* SEND */
      if (email) {
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

      afterResponse(ctx, () => {
        strapi.log.info(`[RESET OTP REQUEST] ${identifier}`);
        strapi.log.info(`[OTP SEND - ${email ? "EMAIL" : "SMS"}] ${identifier}`);
        strapi.log.info(`[OTP STORED] ${identifier}`);
      });

      return ctx.send({ message: "OTP sent successfully" });


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
      /* ---------- SAFE BODY READ ---------- */
      const body = ctx.request.body ?? {};
      let identifier = body.identifier;

      if (!identifier || typeof identifier !== "string") {
        strapi.log.warn("[RESEND OTP] Missing identifier in request body");
        return ctx.badRequest("Identifier required");
      }

      /* ---------- NORMALIZE ---------- */
      identifier = normalizeIdentifier(identifier);

      /* ---------- CHECK OLD OTP ---------- */
      const existing = await strapi.db
        .query("api::otp-request.otp-request")
        .findOne({
          where: { identifier, purpose: "reset_password" },
        });

      /* cooldown 30 sec */
      if (existing?.last_sent_at) {
        const now = Date.now();
        const last = new Date(existing.last_sent_at).getTime();

        if (now - last < 30000) {
          strapi.log.warn(`[RESEND BLOCKED - COOLDOWN] ${identifier}`);
          return ctx.badRequest("Please wait 30 seconds before requesting again");
        }
      }

      /* ---------- GENERATE OTP ---------- */
      const otp = generateOtp();
      const otpHash = await bcrypt.hash(otp, 10);

      /* ---------- SEND OTP ---------- */
      if (identifier.includes("@")) {

        await axios.post(
          "https://api.brevo.com/v3/smtp/email",
          {
            sender: { name: "FitFob", email: "amit@thexyzstudio.com" },
            to: [{ email: identifier }],
            subject: "FitFob Password Reset OTP",
            htmlContent: `<h2>Your OTP is <b>${otp}</b><br/>Valid for 2 minutes</h2>`,
          },
          {
            headers: {
              "api-key": process.env.BREVO_API_KEY,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
          }
        );

      } else {

        await sendTwilioOtp(identifier, otp);
      }

      /* ---------- DELETE OLD OTP ---------- */
      await strapi.db.query("api::otp-request.otp-request").deleteMany({
        where: { identifier, purpose: "reset_password" },
      });

      /* ---------- STORE NEW OTP ---------- */
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

      afterResponse(ctx, () => {
        strapi.log.info(`[RESEND OTP REQUEST] ${identifier}`);
        strapi.log.info(`[OTP RESENT & STORED] ${identifier}`);
      });

      return ctx.send({ message: "OTP resent successfully" });


    } catch (err) {
      strapi.log.error("[RESEND OTP ERROR]", err);
      return ctx.internalServerError("Unable to resend OTP");
    }
  },

  /* =========================================================
      3) VERIFY OTP
  ========================================================= */
  async verifyOtp(ctx) {
    try {
      let { identifier, otp } = ctx.request.body;
      identifier = normalizeIdentifier(identifier);

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

      afterResponse(ctx, () => {
        strapi.log.info(`[OTP VERIFY ATTEMPT] ${identifier}`);
        strapi.log.info(`[OTP VERIFIED] ${identifier}`);
        strapi.log.info(`[RESET SESSION CREATED] ${identifier}`);
      });

      return ctx.send({ verified: true, resetToken: token });

    } catch (err) {
      strapi.log.error("[VERIFY OTP ERROR]", err);
      ctx.internalServerError("Verification failed");
    }
  },

  /* =========================================================
      4) RESET PASSWORD
  ========================================================= */
  async resetPassword(ctx) {
    let identifier = "UNKNOWN";

    try {
      /* ---------------- READ BODY SAFELY ---------------- */
      const body = ctx.request.body ?? {};
      identifier = body.identifier;

      const { password, confirmPassword, resetToken } = body;

      if (!identifier || !password || !confirmPassword || !resetToken)
        return ctx.badRequest("All fields required");

      identifier = normalizeIdentifier(identifier);

      if (password !== confirmPassword)
        return ctx.badRequest("Passwords do not match");

      /* ---------------- VALIDATE RESET SESSION ---------------- */
      const session = await strapi.db
        .query("api::reset-password-session.reset-password-session")
        .findOne({
          where: { identifier, token: resetToken, used: false },
        });

      if (!session) {
        strapi.log.warn(`[RESET BLOCKED - INVALID SESSION] ${identifier}`);
        return ctx.badRequest("Invalid or expired session");
      }

      if (new Date(session.expiresAt) < new Date()) {
        strapi.log.warn(`[RESET BLOCKED - SESSION EXPIRED] ${identifier}`);
        return ctx.badRequest("Session expired");
      }

      /* ---------------- FIND USER ---------------- */
      const user = await strapi.db
        .query("plugin::users-permissions.user")
        .findOne({
          where: { $or: [{ email: identifier }, { phoneNumber: identifier }] },
        });

      if (!user) {
        strapi.log.error(`[RESET FAILED - USER NOT FOUND] ${identifier}`);
        return ctx.badRequest("User not found");
      }

      /* =====================================================
         STEP 1 — COGNITO PASSWORD (CRITICAL)
      ===================================================== */
      try {
        await cognitoForceChangePassword(user.cognitoSub, password);
      } catch (cognitoErr) {
        // DO NOT TOUCH STRAPI PASSWORD
        strapi.log.error(`[COGNITO PASSWORD CHANGE FAILED] ${identifier}`, cognitoErr);
        return ctx.internalServerError("Unable to reset password. Please try again.");
      }

      /* =====================================================
         STEP 2 — STRAPI PASSWORD ONLY AFTER COGNITO SUCCESS
      ===================================================== */
      try {
        const hashed = await bcrypt.hash(password, 10);

        await strapi.db.query("plugin::users-permissions.user").update({
          where: { id: user.id },
          data: { password: hashed },
        });
      } catch (dbErr) {
        // EXTREMELY IMPORTANT SAFETY LOG
        strapi.log.error(
          `[CRITICAL] Cognito password changed but Strapi update failed for ${identifier}`,
          dbErr
        );

        return ctx.internalServerError("Password partially updated. Contact support.");
      }

      /* ---------------- INVALIDATE SESSION ---------------- */
      await strapi.db
        .query("api::reset-password-session.reset-password-session")
        .update({
          where: { id: session.id },
          data: { used: true },
        });

      afterResponse(ctx, () => {
        strapi.log.info(`[RESET REQUEST RECEIVED] ${identifier}`);
        strapi.log.info(`[RESET SESSION VALIDATED] ${identifier}`);
        strapi.log.info(`[COGNITO PASSWORD CHANGE SUCCESS] ${identifier}`);
        strapi.log.info(`[STRAPI PASSWORD UPDATED] ${identifier}`);
        strapi.log.info(`[PASSWORD RESET COMPLETED] ${identifier}`);
      });

      return ctx.send({ message: "Password reset successful" });

    } catch (err) {
      strapi.log.error(`[RESET PASSWORD FATAL ERROR] ${identifier}`, err);
      return ctx.internalServerError("Password reset failed");
    }
  }

};