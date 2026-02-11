import Twilio from "twilio";
import { createCognitoUser } from "../../../services/cognito-provision";

const client = Twilio(
  process.env.TWILIO_ACCOUNT_SID as string,
  process.env.TWILIO_AUTH_TOKEN as string
);

// supports 10 digit OR +91 format
const isPhone = (value: string) => /^(\+91)?[6-9]\d{9}$/.test(value);

// always convert to +91XXXXXXXXXX
const formatPhone = (phone: string) => {
  let p = phone.trim();

  // remove spaces/dashes
  p = p.replace(/[\s-]/g, "");

  // remove +
  if (p.startsWith("+")) p = p.substring(1);

  // remove 91 prefix
  if (p.startsWith("91") && p.length === 12) p = p.substring(2);

  return `+91${p}`;
};

function generateUsername(email?: string, phone?: string) {
  if (email) return email.split("@")[0];
  return String(phone);
}

export default {
  async verify(ctx: any) {
    try {
      const { identifier, otp } = ctx.request.body;

      if (!identifier || !otp)
        return ctx.badRequest("Identifier and OTP required");

      // ---------- NORMALIZE IDENTIFIER ----------
      let twilioIdentifier = identifier;

      if (isPhone(identifier)) {
        twilioIdentifier = formatPhone(identifier);
      }

      strapi.log.info(`[OTP] Verifying OTP for ${twilioIdentifier}`);
      strapi.log.info(`[OTP] Normalized identifier = ${twilioIdentifier}`);

      // ---------- VERIFY OTP ----------
      const result = await client.verify.v2
        .services(process.env.TWILIO_VERIFY_SERVICE_SID as string)
        .verificationChecks.create({
          to: twilioIdentifier,
          code: otp,
        });

      if (result.status !== "approved")
        return ctx.badRequest("OTP expired. Please resend OTP");

      strapi.log.info("[OTP] Verification successful");

      // ---------- FIND PENDING SIGNUP ----------
      const record = await strapi.db
        .query("api::pending-signup.pending-signup")
        .findOne({
          where: {
            $or: [
              { identifier },
              { identifier: identifier.replace("+91", "") }
            ]
          }
        });

      if (!record)
        return ctx.badRequest("Signup expired. Please register again.");

      const data = record.signupData;
      const email = data.email || null;
      const phoneNumber = data.phone || null;

      // ---------- PREVENT DUPLICATE USER ----------
      const existingUser = await strapi.db
        .query("plugin::users-permissions.user")
        .findOne({
          where: email ? { email } : { phoneNumber },
        });

      if (existingUser)
        return ctx.badRequest("User already verified. Please login.");

      const emailForSchema = email || `${phoneNumber}@phone.user`;

      // ---------- USERNAME ----------
      let username = generateUsername(email, phoneNumber);
      let counter = 1;

      while (
        await strapi.db
          .query("plugin::users-permissions.user")
          .findOne({ where: { username } })
      ) {
        username = `${username}${counter++}`;
      }

      // ---------- ROLE ----------
      const roleRecord = data.role
        ? await strapi.db
            .query("plugin::users-permissions.role")
            .findOne({ where: { name: data.role } })
        : await strapi.db
            .query("plugin::users-permissions.role")
            .findOne({ where: { type: "authenticated" } });

      // ---------- CREATE STRAPI USER ----------
      strapi.log.info("[STRAPI] Creating user in database...");

      const userService = strapi.plugin("users-permissions").service("user");

      const user = await userService.add({
        username,
        email: emailForSchema,
        phoneNumber,
        password: data.password,
        role: roleRecord.id,
        provider: "local",
        confirmed: true,
      });

      strapi.log.info(`[STRAPI] User created successfully (ID=${user.id})`);

      // ---------- CREATE COGNITO USER ----------
      try {
        strapi.log.info("[COGNITO] Creating AWS Cognito user...");

        const cognitoIdentifier = phoneNumber
          ? formatPhone(phoneNumber)
          : email;

        const cognitoSub = await createCognitoUser(
          cognitoIdentifier!,
          data.password,
          username,
          !!phoneNumber
        );

        await strapi.db
          .query("plugin::users-permissions.user")
          .update({
            where: { id: user.id },
            data: { cognitoSub },
          });

        strapi.log.info("[COGNITO] Cognito user linked with Strapi");

      } catch (err: any) {
        strapi.log.error("Cognito provisioning failed");
        strapi.log.error(err);
      }

      // ---------- CLEANUP ----------
      await strapi.entityService.delete(
        "api::pending-signup.pending-signup",
        record.id
      );

      strapi.log.info("[CLEANUP] Pending signup removed");

      // ---------- LOGIN ----------
      const jwt = strapi
        .plugin("users-permissions")
        .service("jwt")
        .issue({ id: user.id });

      strapi.log.info("[LOGIN] JWT issued");

      ctx.send({ jwt, user });

    } catch (err) {
      strapi.log.error("VERIFY OTP ERROR");
      strapi.log.error(err);
      ctx.internalServerError("OTP verification failed");
    }
  },
};
