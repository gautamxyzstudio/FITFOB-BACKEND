import axios from "axios";
import bcrypt from "bcryptjs";
import { normalizeIdentifier } from "../../../utils/normalize-identifier";
import { checkCognitoUser } from "../../../services/cognito-user-check";
import { sendTwilioOtp } from "../../../services/twilio-sms";

/* OTP */
const generateOtp = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

/* Normalize Phone */
const normalizePhone = (identifier: string) => {
  if (identifier.includes("@")) return identifier.trim().toLowerCase();

  let num = identifier.replace(/\D/g, "");

  if (num.length === 10) return `+91${num}`;
  if (num.length === 12 && num.startsWith("91")) return `+${num}`;

  return identifier;
};

export default {
  async register(ctx: any) {
    try {
      let { identifier, password, confirmPassword, role } =
        ctx.request.body;

      identifier = normalizeIdentifier(identifier);
      identifier = normalizePhone(identifier);

      if (!identifier || !password || !confirmPassword) {
        return ctx.badRequest(
          "identifier, password, confirmPassword required"
        );
      }

      if (password !== confirmPassword) {
        return ctx.badRequest("Passwords do not match");
      }

      const email = identifier.includes("@") ? identifier : null;
      const phone = email ? null : identifier;

      /* ---------- EXISTING USER CHECK ---------- */
      const existingUser = await strapi.db
        .query("plugin::users-permissions.user")
        .findOne({
          where: email ? { email } : { phoneNumber: phone },
        });

      if (existingUser) {
        return ctx.badRequest("User already exists. Please login.");
      }

      const existsInCognito = await checkCognitoUser(identifier);
      if (existsInCognito) {
        return ctx.badRequest("User already exists. Please login.");
      }

      /* ---------- OTP GENERATE ---------- */
      const otp = generateOtp();
      const otpHash = await bcrypt.hash(otp, 10);

      /* ---------- SEND OTP FIRST ---------- */
      try {
        if (email) {
          await axios.post(
            "https://api.brevo.com/v3/smtp/email",
            {
              sender: {
                name: "FitFob",
                email: "amit@thexyzstudio.com",
              },
              to: [{ email }],
              subject: "Your FitFob OTP",
              htmlContent: `
                <h2>
                  Your OTP is <b>${otp}</b><br/>
                  Valid for 2 minutes
                </h2>
              `,
            },
            {
              headers: {
                "api-key": process.env.BREVO_API_KEY,
              },
            }
          );
        } else {
          await sendTwilioOtp(phone!, otp);
        }
      } catch (err) {
        return ctx.badRequest(
          "Unable to send OTP. Check email/phone."
        );
      }

      /* ---------- STORE SESSION ---------- */
      await strapi.db
        .query("api::pending-signup.pending-signup")
        .deleteMany({
          where: { identifier },
        });

      await strapi.entityService.create(
        "api::pending-signup.pending-signup",
        {
          data: {
            identifier,
            signupData: {
              email,
              phone,
              password,
              role: role || "Client",
            },
            expiresAt: Date.now() + 10 * 60 * 1000,
          },
        }
      );

      /* ---------- STORE OTP ---------- */
      await strapi.db
        .query("api::otp-request.otp-request")
        .deleteMany({
          where: { identifier, purpose: "register" },
        });

      await strapi.entityService.create(
        "api::otp-request.otp-request",
        {
          data: {
            identifier,
            otp_hash: otpHash,
            expires_at: new Date(Date.now() + 2 * 60 * 1000),
            attempts: 0,
            verified: false,
            purpose: "register",
            last_sent_at: new Date(),
          },
        }
      );

      ctx.send({ message: "OTP sent successfully" });

      setTimeout(() => {
        if (email) {
          strapi.log.info(`[EMAIL OTP SENT] ${identifier}`);
        } else {
          strapi.log.info(`[SMS OTP SENT] ${phone}`);
        }

        strapi.log.info(`[REGISTER] ${identifier}`);
        strapi.log.info(`[OTP STORED IN DB] ${identifier}`);
      }, 0);
    } catch (err) {
      strapi.log.error("REGISTER ERROR", err);
      ctx.internalServerError("Registration failed");
    }
  },
};