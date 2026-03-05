import bcrypt from "bcryptjs";
import { createCognitoUser } from "../../../services/cognito-provision";
import { cognitoLogin } from "../../../services/cognito-auth";
import { normalizeIdentifier } from "../../../utils/normalize-identifier";
import { addUserToCognitoGroup } from "../../../services/cognito-groups";

/* ---------- Post-response logger ---------- */
const postVerifyLogs = (messages: string[]) => {
  setTimeout(() => {
    try {
      messages.forEach((m) => strapi.log.info(m));
    } catch (e) {
      console.error("Post verify log error:", e);
    }
  }, 0);
};

/* ---------- Type for pending signup JSON ---------- */
type PendingSignupData = {
  email?: string | null;
  phone?: string | null;
  password: string;
  role?: string | null;
};

const normalizePhone = (identifier: string) => {
  if (identifier.includes("@")) return identifier;
  let num = identifier.replace(/\D/g, "");
  if (num.length === 10) return `+91${num}`;
  if (num.length === 12 && num.startsWith("91")) return `+${num}`;
  return identifier;
};

export default {
  async verify(ctx: any) {
    try {
      let { identifier, otp, signupToken } = ctx.request.body;

      identifier = normalizeIdentifier(identifier);
      identifier = normalizePhone(identifier);

      if (!signupToken)
        return ctx.badRequest("Verification session expired. Please request OTP again.");

      const logs: string[] = [];
      logs.push(`[VERIFY] ${identifier}`);

      /* ---------- FETCH OTP ---------- */

      const records = await strapi.entityService.findMany(
        "api::otp-request.otp-request",
        {
          filters: {
            identifier,
            signupToken,
            purpose: "register",
          },
        }
      );
      const record = records[0];
      if (!record)
        return ctx.badRequest("Invalid or expired verification session. Please register again.");
      
      /* ---------- OTP EXPIRY (FIXED) ---------- */

      const otpExpiresAt = new Date(record.expires_at).getTime();

      if (Date.now() >= otpExpiresAt) {
        await strapi.entityService.delete("api::otp-request.otp-request", record.id);
        return ctx.badRequest("OTP expired. Please resend OTP.");
      }

      /* ---------- VALIDATE OTP ---------- */

      const valid = await bcrypt.compare(otp, record.otp_hash);
      if (!valid) {
        await strapi.entityService.update("api::otp-request.otp-request", record.id, {
          data: { attempts: record.attempts + 1 },
        });
        return ctx.badRequest("Invalid OTP");
      }

      // consume OTP
      await strapi.entityService.delete("api::otp-request.otp-request", record.id);

      /* ---------- FETCH PENDING SIGNUP ---------- */

      const pendingRecords = await strapi.entityService.findMany(
        "api::pending-signup.pending-signup",
        {
          filters: {
            identifier,
            signupToken,
          },
        }
      );

      const pending = pendingRecords[0];
      if (!pending) return ctx.badRequest("Signup expired.");

      const signupData = pending.signupData as PendingSignupData;

      const email = signupData.email ?? null;
      const phone = signupData.phone ?? null;
      const password = signupData.password;
      const role = signupData.role ?? "Client";

   const username = email
  ? email.toLowerCase()
  : phone;

      /* ---------- COGNITO FIRST ---------- */

      let cognitoSub: string;
      const cognitoIdentifier =
        phone !== null ? phone : (email as string).toLowerCase();
      try {
        const result = await createCognitoUser(
          cognitoIdentifier,
          password,
          username,
          !!phone
        );

        cognitoSub = result.sub;
        logs.push(...result.logs);

        const groupResult = await addUserToCognitoGroup(cognitoSub, role);
        logs.push(...groupResult.logs);

        logs.push("COGNITO USER CREATED ✔");

        const groupName =
          role === "Admin"
            ? "Admin_users"
            : role === "ClubOwner"
              ? "ClubOwner_users"
              : "Member_users";

        logs.push(`GROUP ASSIGNED ✔ → ${groupName}`);

      } catch (err: any) {
  console.error("COGNITO ERROR FULL:", JSON.stringify(err, null, 2));
  strapi.log.error("COGNITO ERROR:", err);

  if (pending?.id) {
    await strapi.entityService.delete(
      "api::pending-signup.pending-signup",
      pending.id
    );
  }

  return ctx.internalServerError(
    err?.name || err?.message || "Account creation failed."
  );
}
      /* ---------- STRAPI USER ---------- */

      // normalize role (safety)
      const roleType =
        role === "Admin"
          ? "admin"
          : role === "ClubOwner"
            ? "clubowner"
            : "client";

      // fetch role from Strapi
      const strapiRole = await strapi.db
        .query("plugin::users-permissions.role")
        .findOne({
          where: { type: roleType },
        });

      if (!strapiRole) {
        strapi.log.error("ROLE NOT FOUND IN STRAPI:", roleType);
        return ctx.internalServerError("Server role configuration error.");
      }

      const userService = strapi.plugin("users-permissions").service("user");

      const user = await userService.add({
        username,
        email: email || `${phone}@phone.user`,
        password,
        confirmed: true,
        provider: "local",
        role: strapiRole.id,
      });

      await strapi.db.query("plugin::users-permissions.user").update({
        where: { id: user.id },
        data: { phoneNumber: phone, cognitoSub, isVerified: false , verification_status: "pending"},
      });

      logs.push("STRAPI USER CREATED ✔");

      /* ---------- LOGIN ---------- */

      let tokens;
      try {
        tokens = await cognitoLogin(cognitoIdentifier, password);
      } catch (e) {

        // rollback strapi user if login fails
        await strapi.db.query("plugin::users-permissions.user").delete({
          where: { id: user.id },
        });

        await strapi.entityService.delete(
          "api::pending-signup.pending-signup",
          pending.id
        );

        return ctx.internalServerError(
          "Account created but login failed. Please register again."
        );
      }
      const jwtService = strapi.plugin("users-permissions").service("jwt");
      const jwt = jwtService.issue({ id: user.id });

      /* ---------- CLEANUP ---------- */

      await strapi.entityService.delete(
        "api::pending-signup.pending-signup",
        pending.id
      );

      const fullUser = await strapi.db.query("plugin::users-permissions.user").findOne({
        where: { id: user.id },
        populate: ["role"],
      });

      ctx.body = {
        jwt,
        cognito: {
          accessToken: tokens.AccessToken,
          idToken: tokens.IdToken,
          refreshToken: tokens.RefreshToken,
          expiresIn: tokens.ExpiresIn,
        },
        user: {
          id: fullUser.id,
          username: fullUser.username,
          email: fullUser.email,
          phoneNumber: fullUser.phoneNumber,
          isVerified: fullUser.isVerified,
          verification_status: fullUser.verification_status,
          cognitoSub: fullUser.cognitoSub,
          confirmed: fullUser.confirmed,
          blocked: fullUser.blocked,
          role: fullUser.role,
        },
      };

      logs.push(`[SUCCESS REGISTERED] ${identifier}`);

      /* ---------- print logs AFTER HTTP response ---------- */
      postVerifyLogs(logs);

    } catch (err: any) {
  strapi.log.error("VERIFY ERROR:", err);

  return ctx.internalServerError({
    message: err?.message || "OTP verification failed",
    stack: err?.stack,
  });
}
  },
};