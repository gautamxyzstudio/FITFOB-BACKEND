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
  p = p.replace(/[\s-]/g, "");

  if (p.startsWith("+")) p = p.substring(1);
  if (p.startsWith("91") && p.length === 12) p = p.substring(2);

  return `+91${p}`;
};

function generateUsername(email?: string | null, phone?: string | null) {
  if (email) return email.split("@")[0];
  return String(phone);
}

export default {
  async verify(ctx: any) {
    try {
      const { identifier, otp } = ctx.request.body;

      if (!identifier || !otp)
        return ctx.badRequest("Identifier and OTP required");

      /* ---------------- NORMALIZE IDENTIFIER ---------------- */
      let twilioIdentifier = identifier;
      if (isPhone(identifier)) {
        twilioIdentifier = formatPhone(identifier);
      }

      /* ---------------- VERIFY OTP ---------------- */
      const result = await client.verify.v2
        .services(process.env.TWILIO_VERIFY_SERVICE_SID as string)
        .verificationChecks.create({
          to: twilioIdentifier,
          code: otp,
        });

      if (result.status !== "approved")
        return ctx.badRequest("OTP expired. Please resend OTP");

      /* ---------------- FIND PENDING SIGNUP ---------------- */
      const record = await strapi.db
        .query("api::pending-signup.pending-signup")
        .findOne({
          where: {
            $or: [
              { identifier },
              { identifier: identifier.replace("+91", "") },
            ],
          },
        });

      if (!record)
        return ctx.badRequest("Signup expired. Please register again.");

      const data = record.signupData;

      const email: string | null = data.email ?? null;
      const phoneNumber: string | null = data.phone
        ? formatPhone(data.phone)
        : null;

      /* -------- STRAPI REQUIRES EMAIL -------- */
      const emailForSchema: string = email
        ? email
        : `${phoneNumber!}@phone.user`;

      /* ---------------- PREVENT DUPLICATE USER ---------------- */
      const existingUser = await strapi.db
        .query("plugin::users-permissions.user")
        .findOne({
          where: {
            $or: [
              email ? { email } : null,
              phoneNumber ? { phoneNumber } : null,
            ].filter(Boolean),
          },
        });

      if (existingUser)
        return ctx.badRequest("User already verified. Please login.");

      /* ---------------- USERNAME ---------------- */
      let username = generateUsername(email, phoneNumber);
      let counter = 1;

      while (
        await strapi.db
          .query("plugin::users-permissions.user")
          .findOne({ where: { username } })
      ) {
        username = `${username}${counter++}`;
      }

      /* ---------------- ROLE (DEFAULT CLIENT) ---------------- */
      let roleName = data.role?.trim();
      if (!roleName) roleName = "Client";

      let roleRecord = await strapi.db
        .query("plugin::users-permissions.role")
        .findOne({
          where: { name: roleName },
        });

      if (!roleRecord) {
        strapi.log.warn(`Role "${roleName}" not found. Using authenticated role.`);
        roleRecord = await strapi.db
          .query("plugin::users-permissions.role")
          .findOne({ where: { type: "authenticated" } });
      }

      /* ---------------- CREATE USER ---------------- */
      /* ---------------- CREATE USER (STRAPI SAFE) ---------------- */
      const userService = strapi.plugin("users-permissions").service("user");

      // create user using strapi register logic (it hashes password internally)
      const baseUser = await userService.add({
        username,
        email: emailForSchema,
        password: data.password,
        provider: "local",
        confirmed: true,
        blocked: false,
      });

      /* ---- FORCE ROLE + CUSTOM FIELDS ---- */
      await strapi.db.query("plugin::users-permissions.user").update({
        where: { id: baseUser.id },
        data: {
          role: roleRecord.id,
          phoneNumber: phoneNumber,
          isVerified: false,
        },
      });


      /* ---------------- COGNITO ---------------- */
      try {
        const cognitoIdentifier = phoneNumber
          ? phoneNumber
          : email!;

        const cognitoSub = await createCognitoUser(
          cognitoIdentifier,
          data.password,
          username,
          !!phoneNumber
        );

        await strapi.db
          .query("plugin::users-permissions.user")
          .update({
            where: { id: baseUser.id },
            data: { cognitoSub },
          });
      } catch (err: any) {
        strapi.log.error("Cognito provisioning failed");
        strapi.log.error(err);
      }

      /* ---------------- CLEANUP ---------------- */
      await strapi.entityService.delete(
        "api::pending-signup.pending-signup",
        record.id
      );

      /* ---------------- ISSUE JWT ---------------- */
      const jwt = strapi
        .plugin("users-permissions")
        .service("jwt")
        .issue({ id: baseUser.id });

      /* ---------------- FETCH USER ---------------- */
      const fullUser = await strapi.db
        .query("plugin::users-permissions.user")
        .findOne({
          where: { id: baseUser.id },
          populate: ["role"],
        });

      /* ---------------- RESPONSE ---------------- */
      ctx.send({
        jwt,
        user: {
          id: fullUser.id,
          username: fullUser.username,
          email: fullUser.email,
          phoneNumber: fullUser.phoneNumber,
          isVerified: fullUser.isVerified,
          cognitoSub: fullUser.cognitoSub,
          confirmed: fullUser.confirmed,
          blocked: fullUser.blocked,
          role: fullUser.role,
        },
      });
    } catch (err) {
      strapi.log.error("VERIFY OTP ERROR");
      strapi.log.error(err);
      ctx.internalServerError("OTP verification failed");
    }
  },
};
