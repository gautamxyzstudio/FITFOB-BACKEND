import Twilio from "twilio";
import { normalizeIdentifier } from "../../../utils/normalize-identifier";
import { checkCognitoUser } from "../../../services/cognito-user-check";

const client = Twilio(
  process.env.TWILIO_ACCOUNT_SID as string,
  process.env.TWILIO_AUTH_TOKEN as string
);

// also return local format (9876543210) for old DB records
const localPhone = (phone: string | null) => {
  if (!phone) return null;
  return phone.replace("+91", "");
};

export default {
  async register(ctx: any) {
    try {
      let { identifier, password, confirmPassword, role } = ctx.request.body;

      identifier = normalizeIdentifier(identifier);

      if (!identifier || !password || !confirmPassword)
        return ctx.badRequest("identifier, password, confirmPassword required");

      if (password !== confirmPassword)
        return ctx.badRequest("Passwords do not match");

      let email: string | null = null;
      let phone: string | null = null;

      if (identifier.includes("@")) email = identifier;
      else phone = identifier;

      strapi.log.info(`[REGISTER] Type detected: ${email ? "EMAIL" : "PHONE"}`);

      /* =====================================================
         1️⃣ CHECK USERS TABLE (LOGIN ACCOUNT)
      ===================================================== */

      const existingUser = await strapi.db
        .query("plugin::users-permissions.user")
        .findOne({
          where: {
            $or: [
              email ? { email } : null,
              phone ? { phoneNumber: phone } : null,
              phone ? { phoneNumber: localPhone(phone) } : null,
            ].filter(Boolean),
          },
        });

      if (existingUser) {
        return ctx.badRequest(
          "User already registered (account exists). Please login."
        );
      }

      /* =====================================================
         2️⃣ CHECK CLIENT DETAIL (PROFILE / KYC)
         IMPORTANT: check ONLY the field used in signup
      ===================================================== */

      let existingClient = null;

      if (email) {
        existingClient = await strapi.db
          .query("api::client-detail.client-detail")
          .findOne({ where: { email } });
      } else if (phone) {
        existingClient = await strapi.db
          .query("api::client-detail.client-detail")
          .findOne({
            where: {
              $or: [
                { phoneNumber: phone },
                { phoneNumber: localPhone(phone) },
              ],
            },
          });
      }

      if (existingClient) {
        return ctx.badRequest(
          "client profile with this identifier already exists. Please login."
        );
      }

      /* =====================================================
         3️⃣ CHECK COGNITO (AUTH SERVER)
      ===================================================== */

      let cognitoIdentifier = identifier;

      if (!identifier.includes("@")) {
        cognitoIdentifier = identifier.startsWith("+91")
          ? identifier
          : `+91${identifier}`;
      }

      const existsInCognito = await checkCognitoUser(cognitoIdentifier);

      if (existsInCognito) {
        return ctx.badRequest(
          "User already registered in cognito server. Please login."
        );
      }

      /* =====================================================
         NEW USER → ALLOW OTP
      ===================================================== */

      // delete old pending
      await strapi.db
        .query("api::pending-signup.pending-signup")
        .deleteMany({ where: { identifier } });

      // store pending
      await strapi.entityService.create("api::pending-signup.pending-signup", {
        data: {
          identifier,
          signupData: {
            email,
            phone,
            password,
            role: role || null,
          },
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        },
      });

      /* =====================================================
         SEND OTP (Twilio only reaches here if USER IS NEW)
      ===================================================== */

      let to = identifier;
      let channel = "email";

      if (phone) {
        to = phone; // already +91XXXXXXXXXX
        channel = "sms";
      }

      strapi.log.info(`[OTP] Starting new verification session for ${to}`);

      try {
        const verification = await client.verify.v2
          .services(process.env.TWILIO_VERIFY_SERVICE_SID as string)
          .verifications.create({
            to,
            channel,
          });

        strapi.log.info(`[OTP] Fresh OTP sent to ${to} SID: ${verification.sid}`);

        ctx.send({ message: "OTP sent successfully" });

      } catch (twilioErr: any) {

        if (twilioErr?.status === 429) {
          return ctx.badRequest(
            "Too many OTP requests. Please wait 2 minutes and try again."
          );
        }

        if (twilioErr?.code === 60203) {
          return ctx.badRequest("Invalid phone number or email.");
        }

        strapi.log.error("TWILIO ERROR:", twilioErr);
        return ctx.internalServerError("OTP service temporarily unavailable.");
      }

    } catch (err) {
      strapi.log.error("REGISTER ERROR");
      strapi.log.error(err);
      ctx.internalServerError("Registration failed");
    }
  },
};