import speakeasy from "speakeasy";
import { cognitoLogin } from "../../../services/cognito-auth";

export default {

  /* =====================================================
     ACTIVATE MFA (AFTER QR SCAN)
     Called only once when Admin scans QR
  ===================================================== */

  async activate(ctx) {

    const { email, otp } = ctx.request.body;

    if (!email || !otp)
      return ctx.badRequest("Email and OTP required");

    // find admin
    const user = await strapi.db
      .query("plugin::users-permissions.user")
      .findOne({
        where: { email: email.toLowerCase() },
        populate: ["role"],
      });

    if (!user)
      return ctx.badRequest("User not found");

    if (user.role?.name !== "Admin")
      return ctx.unauthorized("Only Admin can enable MFA");

    if (!user.mfa_temp_secret)
      return ctx.badRequest("No MFA setup in progress");

    // verify authenticator code
    const verified = speakeasy.totp.verify({
      secret: user.mfa_temp_secret,
      encoding: "base32",
      token: otp,
      window: 1,
    });

    if (!verified)
      return ctx.badRequest("Invalid authenticator code");

    // permanently enable MFA
    await strapi.entityService.update(
      "plugin::users-permissions.user",
      user.id,
      {
        data: {
          mfa_secret: user.mfa_temp_secret,
          mfa_temp_secret: null
        }
      }
    );

    ctx.send({
      message: "MFA successfully enabled"
    });
  },

  /* =====================================================
     VERIFY OTP DURING LOGIN
  ===================================================== */

  async verify(ctx) {

    const { tempToken, otp, password } = ctx.request.body;

    if (!tempToken || !otp || !password)
      return ctx.badRequest("OTP and password required");

    // find user waiting for MFA
    const user = await strapi.db
      .query("plugin::users-permissions.user")
      .findOne({
        where: { mfa_temp_token: tempToken },
        populate: ["role"],
      });

    if (!user)
      return ctx.badRequest("Session expired");

    if (user.role?.name !== "Admin")
      return ctx.unauthorized("MFA allowed only for Admin");

    if (!user.mfa_secret)
      return ctx.badRequest("MFA not activated");

    // verify OTP
    const verified = speakeasy.totp.verify({
      secret: user.mfa_secret,
      encoding: "base32",
      token: otp,
      window: 1,
    });

    if (!verified)
      return ctx.badRequest("Invalid authenticator code");

    /* ===== REAL LOGIN ===== */

    const identifier = user.mfa_identifier || user.email || user.phoneNumber;

    let tokens;
    try {
      tokens = await cognitoLogin(identifier, password);
    } catch {
      return ctx.unauthorized("Invalid credentials");
    }

    const jwt = strapi
      .plugin("users-permissions")
      .service("jwt")
      .issue({ id: user.id });

    // clear temporary session
    await strapi.entityService.update(
      "plugin::users-permissions.user",
      user.id,
      {
        data: {
          mfa_temp_token: null,
          mfa_identifier: null
        }
      }
    );

    ctx.send({
      jwt,
      cognito: {
        accessToken: tokens.AccessToken,
        idToken: tokens.IdToken,
        refreshToken: tokens.RefreshToken,
        expiresIn: tokens.ExpiresIn,
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
    });
  },
};
