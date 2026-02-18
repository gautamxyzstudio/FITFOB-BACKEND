/* ================= PHONE + EMAIL HELPERS (SAFE) ================= */

import { cognitoLogin } from "../../../services/cognito-auth";

// email detector
const isEmail = (value: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

// phone formatter (always produce +91XXXXXXXXXX)
const formatPhone = (value: string): string => {
  if (!value) return value;

  const digits = value.replace(/\D/g, "");

  // 8687422222
  if (digits.length === 10) return `+91${digits}`;

  // 918687422222
  if (digits.length === 12 && digits.startsWith("91"))
    return `+${digits}`;

  // already +91XXXXXXXXXX
  if (value.startsWith("+91")) return value;

  return value;
};

export default {
  async login(ctx: any) {
    try {
      let { identifier, password } = ctx.request.body;

      if (!identifier || !password) {
        return ctx.badRequest("Identifier and password required");
      }

      /* ======================================================
         1️⃣ NORMALIZE IDENTIFIER (MOST IMPORTANT FIX)
         Cognito usernames are CASE SENSITIVE
      ====================================================== */

      identifier = identifier.trim();

      if (isEmail(identifier)) {
        identifier = identifier.toLowerCase();
      } else {
        identifier = formatPhone(identifier);
      }

      /* ======================================================
         2️⃣ FIND USER FIRST (STRAPI DB)
         This preserves your old login behaviour
      ====================================================== */

      let user: any;

      if (isEmail(identifier)) {
        user = await strapi.db
          .query("plugin::users-permissions.user")
          .findOne({
            where: { email: identifier },
            populate: ["role"],
          });
      } else {
        strapi.log.info(`[LOGIN] Searching phone: ${identifier}`);

        user = await strapi.db
          .query("plugin::users-permissions.user")
          .findOne({
            where: { phoneNumber: identifier },
            populate: ["role"],
          });
      }

      if (!user) {
        return ctx.badRequest("User not found");
      }

      if (user.blocked) {
        return ctx.badRequest("User is blocked");
      }

      /* ======================================================
         3️⃣ AUTHENTICATE USING COGNITO
         (USE THE SAME IDENTIFIER USED DURING SIGNUP)
      ====================================================== */

      let tokens;
      let strapiJwt = "";
      try {
        // ⭐ CRITICAL: use normalized identifier
        tokens = await cognitoLogin(identifier, password);
      } catch (err) {
        strapi.log.error("COGNITO LOGIN FAILED");
        strapi.log.error(err);
        return ctx.unauthorized("Invalid credentials");
      }

      // 🔴 Create Strapi session (THIS is the missing login)
      const jwtService = strapi.plugin("users-permissions").service("jwt");
      strapiJwt = jwtService.issue({ id: user.id }) as string;

      /* ======================================================
         4️⃣ RETURN TOKENS + USER
      ====================================================== */

      ctx.body = {
        jwt: strapiJwt,              // ← STRAPI TOKEN

        cognito: {
          accessToken: tokens!.AccessToken,
          idToken: tokens!.IdToken,
          refreshToken: tokens!.RefreshToken,
          expiresIn: tokens!.ExpiresIn,
        },

        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          phoneNumber: user.phoneNumber,
          isVerified: user.isVerified,
          cognitoSub: user.cognitoSub,
          confirmed: user.confirmed,
          blocked: user.blocked,
          role: user.role,
        },
      };

    } catch (err) {
      strapi.log.error("CUSTOM LOGIN ERROR");
      strapi.log.error(err);
      ctx.internalServerError("Login failed");
    }
  },
};
