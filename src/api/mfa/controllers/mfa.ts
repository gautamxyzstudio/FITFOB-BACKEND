import speakeasy from "speakeasy";
import { cognitoLogin } from "../../../services/cognito-auth";

const USER_MODEL = "plugin::users-permissions.user";


/* small helper (OTP autofill sometimes adds spaces) */
const cleanOtp = (otp: string) =>
String(otp).replace(/\s+/g, "").trim();

export default {

/* =====================================================
ACTIVATE MFA (AFTER QR SCAN)
===================================================== */
async activate(ctx) {

const { email, otp } = ctx.request.body;

if (!email || !otp)
  return ctx.badRequest("Email and OTP required");

const user = await strapi.db
  .query(USER_MODEL)
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

/* FIX 1: allow time drift + clean otp */
const verified = speakeasy.totp.verify({
  secret: user.mfa_temp_secret.trim(),
  encoding: "base32",
  token: cleanOtp(otp),
  window: 3,
  step: 30,
});

if (!verified)
  return ctx.badRequest("Invalid authenticator code");

await strapi.entityService.update(USER_MODEL, user.id, {
  data: {
    mfa_secret: user.mfa_temp_secret,
    mfa_temp_secret: null,
    mfa_failed_attempts: 0,
  },
});

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

const user = await strapi.db
  .query(USER_MODEL)
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

/* FIX 2: always trust identifier saved during login */
if (!user.mfa_identifier)
  return ctx.badRequest("Login session expired");

const identifier = user.mfa_identifier;

/* FIX 3: better otp verification */
const verified = speakeasy.totp.verify({
  secret: user.mfa_secret.trim(),
  encoding: "base32",
  token: cleanOtp(otp),
  window: 3,
  step: 30,
});

/* ===== OTP FAILURE HANDLER ===== */
if (!verified) {

  const attempts = (user.mfa_failed_attempts || 0) + 1;

  await strapi.entityService.update(USER_MODEL, user.id, {
    data: { mfa_failed_attempts: attempts }
  });

  /* After 5 failures → assume authenticator removed */
  if (attempts >= 5) {

    await strapi.entityService.update(USER_MODEL, user.id, {
      data: {
        mfa_temp_token: null,
        mfa_identifier: null,
        mfa_failed_attempts: 0
      }
    });

    return ctx.send({
      mfaResetRequired: true,
      message:
        "Authenticator seems removed. Please login again and scan QR."
    });
  }

  return ctx.badRequest("Invalid authenticator code");
}

/* OTP SUCCESS → reset counter */
await strapi.entityService.update(USER_MODEL, user.id, {
  data: { mfa_failed_attempts: 0 }
});

/* ===== REAL LOGIN ===== */

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

/* clear temporary session */
await strapi.entityService.update(USER_MODEL, user.id, {
  data: {
    mfa_temp_token: null,
    mfa_identifier: null
  }
});

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
