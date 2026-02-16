import Twilio from "twilio";
import bcrypt from "bcryptjs";


const client = Twilio(
  process.env.TWILIO_ACCOUNT_SID as string,
  process.env.TWILIO_AUTH_TOKEN as string
);

const VERIFY_SID = process.env.TWILIO_VERIFY_SERVICE_SID as string;

/* ---------------- HELPERS ---------------- */

// detect email
const isEmail = (value: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

// detect indian phone (10 digit)
const isPhone = (value: string) =>
  /^[6-9]\d{9}$/.test(value);

// format for Twilio
const formatPhone = (phone: string) => `+91${phone}`;

export default {

  /* ======================================================
     1) SEND OTP
  ====================================================== */
  async sendOtp(ctx) {
    try {
      let { identifier } = ctx.request.body;

      if (!identifier)
        return ctx.badRequest("Email or phone is required");

      let user;
      let to;
      let channel: "sms" | "email" = "email";

      /* -------- EMAIL -------- */
      if (isEmail(identifier)) {
        const email = identifier.toLowerCase();
        to = email;

        user = await strapi.db
          .query("plugin::users-permissions.user")
          .findOne({ where: { email } });
      }

      /* -------- PHONE -------- */
      else if (isPhone(identifier)) {
        to = formatPhone(identifier);
        channel = "sms";

        user = await strapi.db
          .query("plugin::users-permissions.user")
          .findOne({ where: { phoneNumber: identifier } });
      }

      else {
        return ctx.badRequest("Invalid email or phone format");
      }

      if (!user)
        return ctx.badRequest("User not found");

      // send OTP via Twilio
      await client.verify.v2.services(VERIFY_SID).verifications.create({
        to,
        channel,
      });

      strapi.log.info(`[OTP SENT] ${to}`);

      return ctx.send({ message: "OTP sent successfully" });

    } catch (err: any) {
      strapi.log.error("SEND OTP ERROR:", err?.message || err);
      return ctx.badRequest("Unable to send OTP. Try again later.");
    }
  },


  /* ======================================================
     2) VERIFY OTP
  ====================================================== */
 async verifyOtp(ctx) {
  try {
    const { identifier, otp } = ctx.request.body;

    if (!identifier || !otp)
      return ctx.badRequest("Identifier and OTP required");

    let to;

    if (isEmail(identifier)) {
      to = identifier.toLowerCase();
    } else if (isPhone(identifier)) {
      to = formatPhone(identifier);
    } else {
      return ctx.badRequest("Invalid identifier");
    }

    const verification = await client.verify.v2
      .services(VERIFY_SID)
      .verificationChecks.create({
        to,
        code: otp,
      });

    if (verification.status !== "approved")
      return ctx.badRequest("Incorrect OTP");

    // ✅ STORE VERIFIED SESSION (10 min)
    await strapi.db.query("api::reset-password-session.reset-password-session").deleteMany({
      where: { identifier }
    });

    await strapi.db.query("api::reset-password-session.reset-password-session").create({
      data: {
        identifier,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      }
    });

    return ctx.send({ verified: true });

  } catch (err) {
    strapi.log.error(err);
    return ctx.badRequest("Invalid or expired OTP");
  }
},

  /* ======================================================
     3) RESET PASSWORD
  ====================================================== */
 async resetPassword(ctx) {
  try {
    const { identifier, password, confirmPassword } = ctx.request.body;

    // validate fields
    if (!identifier || !password || !confirmPassword)
      return ctx.badRequest("All fields are required");

    if (password !== confirmPassword)
      return ctx.badRequest("Passwords do not match");

    if (password.length < 6)
      return ctx.badRequest("Password must be at least 6 characters");

    /* ---------- CHECK VERIFIED SESSION ---------- */
    const session = await strapi.db
      .query("api::reset-password-session.reset-password-session")
      .findOne({ where: { identifier } });

    if (!session)
      return ctx.badRequest("OTP verification required");

    if (new Date(session.expiresAt) < new Date())
      return ctx.badRequest("Session expired. Request OTP again.");

    /* ---------- FIND USER ---------- */
    let user;

    if (isEmail(identifier)) {
      user = await strapi.db.query("plugin::users-permissions.user").findOne({
        where: { email: identifier.toLowerCase() },
      });
    } else if (isPhone(identifier)) {
      user = await strapi.db.query("plugin::users-permissions.user").findOne({
        where: { phoneNumber: identifier },
      });
    } else {
      return ctx.badRequest("Invalid identifier");
    }

    if (!user) return ctx.badRequest("User not found");

    /* ---------- HASH PASSWORD (STRAPI v5 WAY) ---------- */
    const hashedPassword = await bcrypt.hash(password, 10);

    /* ---------- UPDATE PASSWORD ---------- */
    await strapi.db.query("plugin::users-permissions.user").update({
      where: { id: user.id },
      data: { password: hashedPassword },
    });

    /* ---------- DELETE SESSION AFTER SUCCESS ---------- */
    await strapi.db
      .query("api::reset-password-session.reset-password-session")
      .deleteMany({ where: { identifier } });

    return ctx.send({
      message: "Password reset successful",
    });

  } catch (err) {
    strapi.log.error(err);
    return ctx.internalServerError("Password reset failed");
  }
}

};
