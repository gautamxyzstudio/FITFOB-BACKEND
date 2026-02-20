import Twilio from "twilio";
import { createCognitoUser } from "../../../services/cognito-provision";
import { cognitoLogin } from "../../../services/cognito-auth";
import { normalizeIdentifier } from "../../../utils/normalize-identifier";
import { addUserToCognitoGroup } from "../../../services/cognito-groups";

const client = Twilio(
  process.env.TWILIO_ACCOUNT_SID as string,
  process.env.TWILIO_AUTH_TOKEN as string
);

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

      /* ---------------- CLEANUP EXPIRED PENDING ---------------- */
      await strapi.db.query("api::pending-signup.pending-signup").deleteMany({
        where: { expiresAt: { $lt: new Date() } },
      });

      let { identifier, otp } = ctx.request.body;

      if (!identifier || !otp)
        return ctx.badRequest("Identifier and OTP required");

      // MUST match register normalization
      identifier = normalizeIdentifier(identifier);

      /* =====================================================
         1️⃣ VERIFY OTP FIRST (CRITICAL FIX)
         Twilio must receive EXACT SAME phone/email as register
      ===================================================== */

      let twilioIdentifier = identifier;

      // if phone → always +91 format
      if (!identifier.includes("@")) {
        twilioIdentifier = formatPhone(identifier);
      }

      const result = await client.verify.v2
        .services(process.env.TWILIO_VERIFY_SERVICE_SID as string)
        .verificationChecks.create({
          to: twilioIdentifier,
          code: otp,
        });

      if (result.status !== "approved")
        return ctx.badRequest("Invalid or expired OTP");

      /* =====================================================
         2️⃣ FIND PENDING SIGNUP
      ===================================================== */

      const localIdentifier = identifier.startsWith("+91")
        ? identifier.substring(3)
        : identifier;

      const record = await strapi.db
        .query("api::pending-signup.pending-signup")
        .findOne({
          where: {
            $or: [
              { identifier },
              { identifier: localIdentifier },
            ],
          },
        });

      if (!record)
        return ctx.badRequest("Signup expired. Please register again.");

      // expiry check
      if (record.expiresAt && new Date(record.expiresAt) < new Date()) {
        await strapi.entityService.delete(
          "api::pending-signup.pending-signup",
          record.id
        );
        return ctx.badRequest("OTP expired. Please request a new OTP.");
      }

      const data = record.signupData;

      const email: string | null = data.email ?? null;
      const phoneNumber: string | null = data.phone
        ? formatPhone(data.phone)
        : null;

      /* -------- STRAPI REQUIRES EMAIL -------- */
      const emailForSchema: string = email
        ? email.toLowerCase()
        : `${phoneNumber!}@phone.user`;

      /* =====================================================
         FINAL DUPLICATE SAFETY
      ===================================================== */

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

      /* ---------------- ROLE ---------------- */

      let roleName = data.role?.trim();
      if (!roleName) roleName = "Client";

      let roleRecord = await strapi.db
        .query("plugin::users-permissions.role")
        .findOne({ where: { name: roleName } });

      if (!roleRecord) {
        roleRecord = await strapi.db
          .query("plugin::users-permissions.role")
          .findOne({ where: { type: "authenticated" } });
      }

      /* =====================================================
         CREATE STRAPI USER
      ===================================================== */

      const userService = strapi.plugin("users-permissions").service("user");

      const baseUser = await userService.add({
        username,
        email: emailForSchema,
        password: data.password,
        provider: "local",
        confirmed: true,
        blocked: false,
      });

      await strapi.db.query("plugin::users-permissions.user").update({
        where: { id: baseUser.id },
        data: {
          role: roleRecord.id,
          phoneNumber: phoneNumber,
          isVerified: false,
        },
      });

      /* =====================================================
         COGNITO USER CREATION
      ===================================================== */

      let cognitoSub: string | null = null;

      try {
        const cognitoIdentifier = phoneNumber
          ? formatPhone(phoneNumber)
          : email!.toLowerCase();

        cognitoSub = await createCognitoUser(
          cognitoIdentifier,
          data.password,
          username,
          !!phoneNumber
        );
        // 🔥 NEW (group mapping)
        await addUserToCognitoGroup(cognitoSub!, roleName);

        await new Promise(resolve => setTimeout(resolve, 4000));

      } catch (err: any) {

        // rollback Strapi user if Cognito fails
        await strapi.db.query("plugin::users-permissions.user").delete({
          where: { id: baseUser.id },
        });

        if (err.name === "UsernameExistsException")
          return ctx.badRequest("Account already exists. Please login instead.");

        return ctx.internalServerError(
          "Account creation failed. Please try again."
        );
      }

      /* SAVE SUB */
      await strapi.db.query("plugin::users-permissions.user").update({
        where: { id: baseUser.id },
        data: { cognitoSub },
      });

      /* =====================================================
         AUTO LOGIN
      ===================================================== */

      const loginIdentifier = phoneNumber
        ? formatPhone(phoneNumber)
        : email!.toLowerCase();

      const tokens = await cognitoLogin(loginIdentifier, data.password);

      /* DELETE PENDING (YOUR OLD LOGIC PRESERVED) */
      await strapi.entityService.delete(
        "api::pending-signup.pending-signup",
        record.id
      );

      /* FETCH USER */
      const fullUser = await strapi.db
        .query("plugin::users-permissions.user")
        .findOne({
          where: { id: baseUser.id },
          populate: ["role"],
        });

      const jwtService = strapi.plugin("users-permissions").service("jwt");
      const strapiJwt = jwtService.issue({ id: fullUser.id }) as string;

      /* RESPONSE (UNCHANGED) */
      ctx.body = {
        jwt: strapiJwt,
        cognito: {
          accessToken: tokens?.AccessToken,
          idToken: tokens?.IdToken,
          refreshToken: tokens?.RefreshToken,
          expiresIn: tokens?.ExpiresIn,
        },
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
      };

    } catch (err) {
      strapi.log.error("VERIFY OTP ERROR");
      strapi.log.error(err);
      ctx.internalServerError("OTP verification failed");
    }
  },
};