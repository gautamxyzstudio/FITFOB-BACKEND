import axios from "axios";
import bcrypt from "bcryptjs";
import zxcvbn from "zxcvbn";
import crypto from "crypto";
import { normalizeIdentifier } from "../../../utils/normalize-identifier";
import { checkCognitoUser } from "../../../services/cognito-user-check";
import { sendTwilioOtp } from "../../../services/twilio-sms";

/* OTP */
const generateOtp = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

/* normalize phone */
const normalizePhone = (identifier: string) => {
  if (identifier.includes("@")) return identifier.trim().toLowerCase();

  let num = identifier.replace(/\D/g, "");

  if (num.length === 10) return `+91${num}`;
  if (num.length === 12 && num.startsWith("91")) return `+${num}`;

  return identifier;
};

/* =======================================================
   PASSWORD SECURITY VALIDATION
======================================================= */
const validatePasswordSecurity = (
  identifier: string,
  password: string
) => {
  const lowerPassword = password.toLowerCase();

  // Extract base identifier
  let base = identifier;

  if (identifier.includes("@")) {
    base = identifier.split("@")[0];
  } else {
    base = identifier.replace(/\D/g, "").slice(-6); // last 6 digits for phone
  }

  const lowerBase = base.toLowerCase();

  /* Rule 1: Full match */
  if (lowerPassword.includes(lowerBase)) {
    return "Password should not contain your email/phone name.";
  }

  /* Rule 2: 4+ character similarity */
  for (let i = 0; i <= lowerBase.length - 4; i++) {
    const sub = lowerBase.substring(i, i + 4);
    if (lowerPassword.includes(sub)) {
      return "Password too similar to your identifier.";
    }
  }

  /* Rule 3: Strong password policy */
  const strongRegex =
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&]).{8,}$/;

  if (!strongRegex.test(password)) {
    return "Password must contain uppercase, lowercase, number and special character.";
  }

  /* Rule 4: Entropy check (Enterprise Level) */
  const result = zxcvbn(password);
  if (result.score < 3) {
    return "Weak password. Please choose a stronger one.";
  }

  return null;
};

export default {
  async register(ctx: any) {
    try {
      let { identifier, password, confirmPassword, role } =
        ctx.request.body;

      identifier = normalizeIdentifier(identifier);
      identifier = normalizePhone(identifier);

      if (!identifier || !password || !confirmPassword)
        return ctx.badRequest(
          "identifier, password, confirmPassword required"
        );

      if (password !== confirmPassword)
        return ctx.badRequest("Passwords do not match");

      /* 🔐 PASSWORD SECURITY CHECK */
      const passwordError = validatePasswordSecurity(
        identifier,
        password
      );
      if (passwordError)
        return ctx.badRequest(passwordError);

      const email = identifier.includes("@")
        ? identifier
        : null;
      const phone = email ? null : identifier;

      /* EXISTING USER CHECK */
      const existingUser = await strapi.db
        .query("plugin::users-permissions.user")
        .findOne({
          where: email ? { email } : { phoneNumber: phone },
        });

      if (existingUser)
        return ctx.badRequest(
          "User already exists. Please login."
        );

      const existsInCognito =
        await checkCognitoUser(identifier);

      if (existsInCognito)
        return ctx.badRequest(
          "User already exists. Please login."
        );

      /* ---------- OTP GENERATE ---------- */
      const otp = generateOtp();
      const otpHash = await bcrypt.hash(otp, 10);
      const signupToken = crypto.randomUUID();

      // cleanup expired signup attempts
      await strapi.db.query("api::pending-signup.pending-signup").deleteMany({
        where: {
          expiresAt: { $lt: Date.now() },
        },
      });

      // cleanup expired OTPs
      await strapi.db.query("api::otp-request.otp-request").deleteMany({
        where: {
          expires_at: { $lt: new Date() },
        },
      });

      /* ---------- SEND OTP FIRST -------

      /* ---------- SEND OTP ---------- */
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
              htmlContent: `<h2>Your OTP is <b>${otp}</b><br/>Valid for 2 minutes</h2>`,
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
        .deleteMany({ where: { identifier } });

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

     await strapi.entityService.create("api::otp-request.otp-request", {
        data: {
          identifier,
          signupToken,
          otp_hash: otpHash,
          expires_at: new Date(Date.now() + 2 * 60 * 1000),
          attempts: 0,
          verified: false,
          purpose: "register",
          last_sent_at: new Date(),
        },
      });

      ctx.send({
        message: "OTP sent successfully",
        signupToken,
      });

      setTimeout(() => {
        if (email)
          strapi.log.info(`[EMAIL OTP SENT] ${identifier}`);
        else
          strapi.log.info(`[SMS OTP SENT] ${phone}`);

            strapi.log.info(`[REGISTER] ${identifier}`);
        strapi.log.info(`[OTP STORED IN DB] ${identifier}`);
      }, 0);

      ctx.send({ message: "OTP sent successfully" });

    } catch (err) {
      strapi.log.error("REGISTER ERROR", err);
      ctx.internalServerError("Registration failed");
    }
  },
};