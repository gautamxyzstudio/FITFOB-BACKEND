import speakeasy from "speakeasy";
import QRCode from "qrcode";

/* ================= PHONE + EMAIL HELPERS (SAFE) ================= */

import { cognitoLogin } from "../../../services/cognito-auth";
import { v4 as uuidv4 } from "uuid";

// email detector
const isEmail = (value: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

// phone formatter
const formatPhone = (value: string): string => {
  if (!value) return value;

  const digits = value.replace(/\D/g, "");

  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
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

      /* ========= NORMALIZE IDENTIFIER ========= */

      identifier = identifier.trim();

      if (isEmail(identifier)) identifier = identifier.toLowerCase();
      else identifier = formatPhone(identifier);

      /* ========= FIND USER ========= */

      let user: any;

      if (isEmail(identifier)) {
        const users = await strapi.entityService.findMany(
          "plugin::users-permissions.user",
          {
            filters: { email: identifier },
            populate: ["role"],
          }
        );

        user = users[0];

      } else {
        strapi.log.info(`[LOGIN] Searching phone: ${identifier}`);

        const users = await strapi.entityService.findMany(
          "plugin::users-permissions.user",
          {
            filters: { phoneNumber: identifier },
            populate: ["role"],
          }
        );

        user = users[0];
      }

      if (!user) return ctx.badRequest("User not found");
      if (user.blocked) return ctx.badRequest("User is blocked");

      /* ======================================================
         🔐 VERY IMPORTANT — VERIFY STRAPI PASSWORD FIRST
         This DOES NOT affect Cognito login.
         It only prevents MFA bypass.
      ====================================================== */

      const validPassword = await strapi
        .plugin("users-permissions")
        .service("user")
        .validatePassword(password, user.password);

      if (!validPassword) {
        return ctx.unauthorized("Invalid credentials");
      }

      /* ======================================================
         🔐 ADMIN MFA SYSTEM (QR SETUP + OTP LOGIN)
      ====================================================== */

      if (user.role?.name === "Admin") {

        // ---------- FIRST TIME LOGIN (NO MFA YET) ----------
        if (!user.mfa_secret) {

          // create secret for authenticator
          const secret = speakeasy.generateSecret({
            length: 20,
            name: `FitFob (${user.email})`,
            issuer: "FitFob"
          });

          // store temporary secret (NOT ACTIVE YET)
          await strapi.entityService.update(
            "plugin::users-permissions.user",
            user.id,
            {
              data: { mfa_temp_secret: secret.base32 }
            }
          );

          // generate QR code
          const qr = await QRCode.toDataURL(secret.otpauth_url);

          // tell frontend to scan
          return ctx.send({
            mfaSetup: true,
            qr
          });
        }

        // ---------- MFA ALREADY ENABLED (NORMAL ADMIN LOGIN) ----------
        const tempToken = uuidv4();

        await strapi.entityService.update(
          "plugin::users-permissions.user",
          user.id,
          {
            data: {
              mfa_temp_token: tempToken,
              mfa_identifier: identifier
            }
          }
        );

        return ctx.send({
          mfaRequired: true,
          tempToken
        });
      }


      /* ======================================================
         NORMAL USERS → CONTINUE OLD FLOW 
      ====================================================== */

      let tokens;
      try {
        tokens = await cognitoLogin(identifier, password);
      } catch (err) {
        strapi.log.error("COGNITO LOGIN FAILED");
        strapi.log.error(err);
        return ctx.unauthorized("Invalid credentials");
      }

      const jwtService = strapi.plugin("users-permissions").service("jwt");
      const strapiJwt = jwtService.issue({ id: user.id }) as string;

      ctx.body = {
        jwt: strapiJwt,
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
          verification_status: user.verification_status,
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
