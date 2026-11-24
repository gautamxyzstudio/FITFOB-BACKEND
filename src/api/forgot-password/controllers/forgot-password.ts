import axios from "axios";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { sendTwilioOtp } from "../../../services/twilio-sms";
import { cognitoForceChangePassword } from "../../../services/cognito-reset";
import { getOtpEmailTemplate } from "../../../utils/otpEmailTemplate";

/* ================= HELPERS ================= */

// email detector
const isEmail = (val: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(val).trim());

// phone helpers
const getClean10Digits = (val: string): string => {
  if (!val) return "";
  return String(val).replace(/\D/g, "").slice(-10);
};

const getFormattedPhone = (clean10: string): string => `+91${clean10}`;

const getPhoneVariants = (clean10: string): string[] => [
  `+91${clean10}`,
  clean10,
  `91${clean10}`,
];

/* generate OTP */
const generateOtp = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

export default {
  /* =========================================================
      1) SEND RESET OTP
  ========================================================= */
  async sendOtp(ctx: any) {
    try {
      const body = (ctx.request.body as any)?.data || ctx.request.body || {};
      let identifier = body.identifier || body.phoneNumber || body.phone;

      if (!identifier) {
        return ctx.badRequest("Identifier (email or phone number) is required");
      }

      identifier = String(identifier).trim();
      const isEmailIdentifier = isEmail(identifier);

      let user: any = null;
      let clean10 = "";
      let formattedPhone = "";
      let phoneVariants: string[] = [];

      if (isEmailIdentifier) {
        identifier = identifier.toLowerCase();
        user = await strapi.db
          .query("plugin::users-permissions.user")
          .findOne({
            where: { email: identifier },
          });
      } else {
        clean10 = getClean10Digits(identifier);
        if (clean10.length !== 10) {
          return ctx.badRequest(
            "Please provide a valid 10-digit mobile number or email address",
          );
        }
        formattedPhone = getFormattedPhone(clean10);
        phoneVariants = getPhoneVariants(clean10);

        // Find user across phone number and username
        user = await strapi.db
          .query("plugin::users-permissions.user")
          .findOne({
            where: {
              $or: [
                { phoneNumber: { $in: phoneVariants } },
                { username: { $in: phoneVariants } },
              ],
            },
          });

        // Fallback: search via client_detail if phone is linked
        if (!user) {
          const clientDetail: any = await strapi.db
            .query("api::client-detail.client-detail")
            .findOne({
              where: {
                phoneNumber: { $in: phoneVariants },
              },
              populate: ["user"],
            });
          if (clientDetail?.user) {
            user = clientDetail.user;
          }
        }
      }

      if (!user) {
        strapi.log.warn(`[RESET OTP] User not found (${identifier})`);
        return ctx.badRequest("User not found with this identifier");
      }

      const otp = generateOtp();
      const otpHash = await bcrypt.hash(otp, 10);
      const storageIdentifier = isEmailIdentifier ? identifier : formattedPhone;

      // Delete old reset OTPs for this identifier / phone variants
      await strapi.db.query("api::otp-request.otp-request").deleteMany({
        where: {
          identifier: isEmailIdentifier ? identifier : { $in: phoneVariants },
          purpose: "reset_password",
        },
      });

      // Save new OTP request (valid for 10 minutes)
      await strapi.entityService.create("api::otp-request.otp-request", {
        data: {
          identifier: storageIdentifier,
          otp_hash: otpHash,
          expires_at: new Date(Date.now() + 10 * 60 * 1000),
          attempts: 0,
          verified: false,
          purpose: "reset_password",
          last_sent_at: new Date(),
        },
      });

      let channel = "email";
      let twilioSent = false;
      let twilioError: string | null = null;

      if (isEmailIdentifier) {
        channel = "email";
        await axios.post(
          "https://api.brevo.com/v3/smtp/email",
          {
            sender: { name: "FitFob", email: "qaxyzstudio@gmail.com" },
            to: [{ email: identifier }],
            subject: "FitFob Password Reset OTP",
            htmlContent: getOtpEmailTemplate(otp, {
              title: "FitFob Password Reset OTP",
              subtext:
                "We received a request to reset your password. Use the verification code below to complete your password reset:",
              validityMinutes: 10,
            }),
          },
          { headers: { "api-key": process.env.BREVO_API_KEY } },
        );
      } else {
        channel = "sms";
        try {
          await sendTwilioOtp(formattedPhone, otp);
          twilioSent = true;
          strapi.log.info(
            `[RESET OTP] Twilio OTP sent successfully to ${formattedPhone}`,
          );
        } catch (smsErr: any) {
          twilioError = smsErr?.message || "Failed to send SMS";
          strapi.log.warn(
            `[RESET OTP] Twilio error for ${formattedPhone}: ${twilioError}`,
          );
        }
      }

      return ctx.send({
        message: `OTP sent successfully to ${storageIdentifier}`,
        identifier: storageIdentifier,
        channel,
        ...(process.env.NODE_ENV !== "production" && {
          devOtp: otp,
          twilioSent,
          twilioError,
        }),
      });
    } catch (err: any) {
      strapi.log.error("[SEND OTP ERROR]", err?.response?.data || err);
      return ctx.internalServerError({
        message: err?.message || "Unable to send OTP",
      });
    }
  },

  /* =========================================================
      2) RESEND OTP
  ========================================================= */
  async resendOtp(ctx: any) {
    try {
      const body = (ctx.request.body as any)?.data || ctx.request.body || {};
      let identifier = body.identifier || body.phoneNumber || body.phone;

      if (!identifier) {
        return ctx.badRequest("Identifier required");
      }

      identifier = String(identifier).trim();
      const isEmailIdentifier = isEmail(identifier);

      let clean10 = "";
      let formattedPhone = "";
      let phoneVariants: string[] = [];

      if (isEmailIdentifier) {
        identifier = identifier.toLowerCase();
      } else {
        clean10 = getClean10Digits(identifier);
        if (clean10.length !== 10) {
          return ctx.badRequest(
            "Please provide a valid 10-digit mobile number or email address",
          );
        }
        formattedPhone = getFormattedPhone(clean10);
        phoneVariants = getPhoneVariants(clean10);
      }

      const storageIdentifier = isEmailIdentifier ? identifier : formattedPhone;

      // Check existing OTP cooldown (30 seconds)
      const existing: any = await strapi.db
        .query("api::otp-request.otp-request")
        .findOne({
          where: {
            identifier: isEmailIdentifier ? identifier : { $in: phoneVariants },
            purpose: "reset_password",
          },
        });

      if (existing?.last_sent_at) {
        const last = new Date(existing.last_sent_at).getTime();
        if (Date.now() - last < 30000) {
          return ctx.badRequest(
            "Please wait 30 seconds before requesting again",
          );
        }
      }

      const otp = generateOtp();
      const otpHash = await bcrypt.hash(otp, 10);

      // Delete old OTP records
      await strapi.db.query("api::otp-request.otp-request").deleteMany({
        where: {
          identifier: isEmailIdentifier ? identifier : { $in: phoneVariants },
          purpose: "reset_password",
        },
      });

      // Save new OTP
      await strapi.entityService.create("api::otp-request.otp-request", {
        data: {
          identifier: storageIdentifier,
          otp_hash: otpHash,
          expires_at: new Date(Date.now() + 10 * 60 * 1000),
          attempts: 0,
          verified: false,
          purpose: "reset_password",
          last_sent_at: new Date(),
        },
      });

      let channel = "email";
      let twilioSent = false;
      let twilioError: string | null = null;

      if (isEmailIdentifier) {
        channel = "email";
        await axios.post(
          "https://api.brevo.com/v3/smtp/email",
          {
            sender: { name: "FitFob", email: "qaxyzstudio@gmail.com" },
            to: [{ email: identifier }],
            subject: "FitFob Password Reset OTP",
            htmlContent: getOtpEmailTemplate(otp, {
              title: "FitFob Password Reset OTP",
              subtext:
                "Here is your requested verification code to reset your password:",
              validityMinutes: 10,
            }),
          },
          { headers: { "api-key": process.env.BREVO_API_KEY } },
        );
      } else {
        channel = "sms";
        try {
          await sendTwilioOtp(formattedPhone, otp);
          twilioSent = true;
        } catch (smsErr: any) {
          twilioError = smsErr?.message || "Failed to send SMS";
          strapi.log.warn(
            `[RESEND OTP] Twilio error for ${formattedPhone}: ${twilioError}`,
          );
        }
      }

      return ctx.send({
        message: `OTP resent successfully to ${storageIdentifier}`,
        identifier: storageIdentifier,
        channel,
        ...(process.env.NODE_ENV !== "production" && {
          devOtp: otp,
          twilioSent,
          twilioError,
        }),
      });
    } catch (err: any) {
      strapi.log.error("[RESEND OTP ERROR]", err?.response?.data || err);
      return ctx.internalServerError({
        message: err?.message || "Unable to resend OTP",
      });
    }
  },

  /* =========================================================
      3) VERIFY OTP
  ========================================================= */
  async verifyOtp(ctx: any) {
    try {
      const body = (ctx.request.body as any)?.data || ctx.request.body || {};
      let identifier = body.identifier || body.phoneNumber || body.phone;
      const otp = body.otp || body.code;

      if (!identifier || !otp) {
        return ctx.badRequest("Identifier and OTP are required");
      }

      identifier = String(identifier).trim();
      const isEmailIdentifier = isEmail(identifier);
      let phoneVariants: string[] = [];
      let formattedPhone = "";

      if (isEmailIdentifier) {
        identifier = identifier.toLowerCase();
      } else {
        const clean10 = getClean10Digits(identifier);
        formattedPhone = getFormattedPhone(clean10);
        phoneVariants = getPhoneVariants(clean10);
      }

      const storageIdentifier = isEmailIdentifier ? identifier : formattedPhone;

      // Find active reset OTP record
      const records: any[] = await strapi.entityService.findMany(
        "api::otp-request.otp-request",
        {
          filters: {
            identifier: isEmailIdentifier ? identifier : { $in: phoneVariants },
            purpose: "reset_password",
          },
          sort: { id: "desc" },
          limit: 1,
        },
      );

      const record = records?.[0];
      if (!record) {
        return ctx.badRequest(
          "No password reset OTP found. Please request a new OTP.",
        );
      }

      if (Date.now() >= new Date(record.expires_at).getTime()) {
        await strapi.entityService.delete("api::otp-request.otp-request", record.id);
        return ctx.badRequest("OTP expired. Please request a new OTP.");
      }

      if ((record.attempts || 0) >= 5) {
        await strapi.entityService.delete("api::otp-request.otp-request", record.id);
        return ctx.badRequest("Too many failed attempts. Please request a new OTP.");
      }

      const valid = await bcrypt.compare(String(otp).trim(), record.otp_hash);
      if (!valid) {
        await strapi.entityService.update("api::otp-request.otp-request", record.id, {
          data: { attempts: (record.attempts || 0) + 1 },
        });
        return ctx.badRequest("Invalid OTP");
      }

      // Consume OTP record
      await strapi.entityService.delete("api::otp-request.otp-request", record.id);

      // Generate reset session token
      const token = crypto.randomBytes(32).toString("hex");

      // Invalidate previous sessions
      await strapi.db
        .query("api::reset-password-session.reset-password-session")
        .deleteMany({
          where: {
            identifier: isEmailIdentifier ? identifier : { $in: phoneVariants },
          },
        });

      // Create new reset session (valid for 15 minutes)
      await strapi.db
        .query("api::reset-password-session.reset-password-session")
        .create({
          data: {
            identifier: storageIdentifier,
            token,
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            used: false,
          },
        });

      return ctx.send({
        verified: true,
        resetToken: token,
        identifier: storageIdentifier,
      });
    } catch (err: any) {
      strapi.log.error("[VERIFY OTP ERROR]", err);
      return ctx.internalServerError({
        message: err?.message || "Verification failed",
      });
    }
  },

  /* =========================================================
      4) RESET PASSWORD
  ========================================================= */
  async resetPassword(ctx: any) {
    try {
      const body = (ctx.request.body as any)?.data || ctx.request.body || {};
      let identifier = body.identifier || body.phoneNumber || body.phone;
      const { password, confirmPassword, resetToken } = body;

      if (!identifier || !password || !confirmPassword || !resetToken) {
        return ctx.badRequest(
          "Identifier, password, confirmPassword, and resetToken are required",
        );
      }

      if (password !== confirmPassword) {
        return ctx.badRequest("Passwords do not match");
      }

      identifier = String(identifier).trim();
      const isEmailIdentifier = isEmail(identifier);
      let phoneVariants: string[] = [];
      let formattedPhone = "";

      if (isEmailIdentifier) {
        identifier = identifier.toLowerCase();
      } else {
        const clean10 = getClean10Digits(identifier);
        formattedPhone = getFormattedPhone(clean10);
        phoneVariants = getPhoneVariants(clean10);
      }

      // Validate reset session
      const session: any = await strapi.db
        .query("api::reset-password-session.reset-password-session")
        .findOne({
          where: {
            identifier: isEmailIdentifier ? identifier : { $in: phoneVariants },
            token: resetToken,
            used: false,
          },
        });

      if (!session) {
        return ctx.badRequest("Invalid or expired password reset session");
      }

      if (Date.now() >= new Date(session.expiresAt).getTime()) {
        return ctx.badRequest(
          "Password reset session expired. Please request a new OTP.",
        );
      }

      // Find user
      let user: any = null;
      if (isEmailIdentifier) {
        user = await strapi.db
          .query("plugin::users-permissions.user")
          .findOne({
            where: { email: identifier },
          });
      } else {
        user = await strapi.db
          .query("plugin::users-permissions.user")
          .findOne({
            where: {
              $or: [
                { phoneNumber: { $in: phoneVariants } },
                { username: { $in: phoneVariants } },
              ],
            },
          });

        if (!user) {
          const clientDetail: any = await strapi.db
            .query("api::client-detail.client-detail")
            .findOne({
              where: {
                phoneNumber: { $in: phoneVariants },
              },
              populate: ["user"],
            });
          if (clientDetail?.user) {
            user = clientDetail.user;
          }
        }
      }

      if (!user) {
        return ctx.badRequest("User not found");
      }

      // 1. Sync / change password in Cognito
      const cognitoUsername =
        user.cognitoSub || (isEmailIdentifier ? identifier : formattedPhone);
      try {
        await cognitoForceChangePassword(cognitoUsername, password);
        strapi.log.info(
          `[RESET PASSWORD] Cognito password updated for ${cognitoUsername}`,
        );
      } catch (cognitoErr: any) {
        strapi.log.warn(
          `[RESET PASSWORD] Cognito password update warning for ${cognitoUsername}: ${cognitoErr?.message || cognitoErr}`,
        );
      }

      // 2. Update Strapi password
      const hashed = await bcrypt.hash(password, 10);
      await strapi.db.query("plugin::users-permissions.user").update({
        where: { id: user.id },
        data: { password: hashed },
      });

      // 3. Invalidate reset session
      await strapi.db
        .query("api::reset-password-session.reset-password-session")
        .update({
          where: { id: session.id },
          data: { used: true },
        });

      return ctx.send({
        message: "Password reset successfully. You can now login with your new password.",
      });
    } catch (err: any) {
      strapi.log.error("[RESET PASSWORD ERROR]", err);
      return ctx.internalServerError({
        message: err?.message || "Password reset failed",
      });
    }
  },
};
