import Twilio from "twilio";
import bcrypt from "bcryptjs";
import { cognitoForceChangePassword } from "../../../services/cognito-reset";

const client = Twilio(
  process.env.TWILIO_ACCOUNT_SID as string,
  process.env.TWILIO_AUTH_TOKEN as string
);

const VERIFY_SID = process.env.TWILIO_VERIFY_SERVICE_SID as string;

/* ================= NORMALIZER (CRITICAL FIX) ================= */

const normalizeIdentifier = (identifier: string) => {
  if (!identifier) return identifier;

  identifier = identifier.trim();

  // email
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier)) {
    return identifier.toLowerCase();
  }

  // phone normalize
  const digits = identifier.replace(/\D/g, "");

  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91"))
    return `+${digits}`;

  return identifier;
};

export default {

  /* ======================================================
     1️⃣ SEND OTP (TWILIO ONLY)
  ====================================================== */
  async sendOtp(ctx) {
    try {
      let { identifier } = ctx.request.body;

      if (!identifier)
        return ctx.badRequest("Email or phone is required");

      identifier = normalizeIdentifier(identifier);

      /* ---------- FIND USER ---------- */
      const user = await strapi.db
        .query("plugin::users-permissions.user")
        .findOne({
          where: {
            $or: [
              { email: identifier },
              { phoneNumber: identifier },
            ],
          },
        });

      if (!user) return ctx.badRequest("User not found");

      /* ---------- DECIDE CHANNEL ---------- */
      let channel: "sms" | "email";
      let to: string;

      if (identifier.includes("@")) {
        channel = "email";
        to = identifier;
      } else {
        channel = "sms";
        to = identifier;
      }

      await client.verify.v2.services(VERIFY_SID).verifications.create({
        to,
        channel,
      });

      strapi.log.info(`[RESET OTP SENT] ${to}`);

      return ctx.send({ message: "OTP sent successfully" });

    } catch (err) {
      strapi.log.error("SEND OTP ERROR", err);
      return ctx.internalServerError("Failed to send OTP");
    }
  },

  /* ======================================================
     2️⃣ VERIFY OTP
  ====================================================== */
  async verifyOtp(ctx) {
    try {
      let { identifier, otp } = ctx.request.body;

      if (!identifier || !otp)
        return ctx.badRequest("Identifier and OTP required");

      identifier = normalizeIdentifier(identifier);

      const verification = await client.verify.v2
        .services(VERIFY_SID)
        .verificationChecks.create({
          to: identifier,
          code: otp,
        });

      if (verification.status !== "approved")
        return ctx.badRequest("Incorrect OTP");

      /* ---------- STORE TEMP SESSION ---------- */
      await strapi.db
        .query("api::reset-password-session.reset-password-session")
        .deleteMany({
          where: { identifier: identifier },
        });

      await strapi.db
        .query("api::reset-password-session.reset-password-session")
        .create({
          data: {
            identifier: identifier,
            expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          },
        });

      return ctx.send({ verified: true });

    } catch (err) {
      strapi.log.error("VERIFY OTP ERROR", err);
      return ctx.badRequest("Invalid or expired OTP");
    }
  },

  /* ======================================================
     3️⃣ RESET PASSWORD (COGNITO + STRAPI)
  ====================================================== */
  async resetPassword(ctx) {
    try {
      let { identifier, password, confirmPassword } = ctx.request.body;

      if (!identifier || !password || !confirmPassword)
        return ctx.badRequest("All fields required");

      if (password !== confirmPassword)
        return ctx.badRequest("Passwords do not match");

      if (password.length < 6)
        return ctx.badRequest("Password must be at least 6 characters");

      identifier = normalizeIdentifier(identifier);

      /* ---------- CHECK VERIFIED SESSION ---------- */
      const session = await strapi.db
        .query("api::reset-password-session.reset-password-session")
        .findOne({
          where: { identifier: identifier },
        });

      if (!session)
        return ctx.badRequest("OTP verification required");

      if (new Date(session.expiresAt) < new Date())
        return ctx.badRequest("OTP expired");

      /* ---------- FIND USER ---------- */
      const user = await strapi.db
        .query("plugin::users-permissions.user")
        .findOne({
          where: {
            $or: [
              { email: identifier },
              { phoneNumber: identifier },
            ],
          },
        });

      if (!user) return ctx.badRequest("User not found");

      /* ======================================================
         🔴 CHANGE PASSWORD IN COGNITO FIRST
      ====================================================== */

      // VERY IMPORTANT FIX
      const cognitoUsername =
        user.phoneNumber && !user.email.includes("@phone.user")
          ? user.phoneNumber
          : user.email;

      await cognitoForceChangePassword(cognitoUsername, password);

      /* ======================================================
         🔴 UPDATE STRAPI PASSWORD
      ====================================================== */

      const hashedPassword = await bcrypt.hash(password, 10);

      await strapi.db.query("plugin::users-permissions.user").update({
        where: { id: user.id },
        data: { password: hashedPassword },
      });

      /* ---------- DELETE SESSION ---------- */
      await strapi.db
        .query("api::reset-password-session.reset-password-session")
        .deleteMany({
          where: { identifier: identifier },
        });

      return ctx.send({
        message: "Password reset successful",
      });

    } catch (err) {
      strapi.log.error("RESET PASSWORD ERROR", err);
      return ctx.internalServerError("Password reset failed");
    }
  },
};
