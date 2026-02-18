import Twilio from "twilio";

const client = Twilio(
  process.env.TWILIO_ACCOUNT_SID as string,
  process.env.TWILIO_AUTH_TOKEN as string
);

// detect email
const isEmail = (value: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

// detect indian phone
const isPhone = (value: string) =>
  /^[6-9]\d{9}$/.test(value);

// normalize for Twilio
const formatPhone = (phone: string) =>
  phone.startsWith("+") ? phone : `+91${phone}`;

// normalize phone to +91XXXXXXXXXX for DB matching
const normalizePhone = (phone: string | null) => {
  if (!phone) return null;

  let p = phone.trim().replace(/[\s-]/g, "");

  if (p.startsWith("+")) p = p.substring(1);
  if (p.startsWith("91") && p.length === 12) p = p.substring(2);

  return `+91${p}`;
};

// also return local format (9876543210) for old DB records
const localPhone = (phone: string | null) => {
  if (!phone) return null;
  return phone.replace("+91", "");
};


export default {

  async register(ctx: any) {
    try {
      const { identifier, password, confirmPassword, role } = ctx.request.body;

      if (!identifier || !password || !confirmPassword)
        return ctx.badRequest("identifier, password, confirmPassword required");

      if (password !== confirmPassword)
        return ctx.badRequest("Passwords do not match");

      let email: string | null = null;
      let phone: string | null = null;

      if (isEmail(identifier)) email = identifier.toLowerCase();
      else if (isPhone(identifier)) phone = normalizePhone(identifier);
      else return ctx.badRequest("Invalid email or phone format");

      strapi.log.info(`[REGISTER] Type detected: ${email ? "EMAIL" : "PHONE"}`);

      /* =====================================================
    CHECK BOTH TABLES: users + client_details
    Block if email or phone already registered anywhere
    ===================================================== */

      // check in users table
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


      // check in client_details table
     const existingClient = await strapi.db
  .query("api::client-detail.client-detail")
  .findOne({
    where: {
      $or: [
        email ? { email } : null,
        phone ? { phoneNumber: phone } : null,
        phone ? { phoneNumber: localPhone(phone) } : null,
      ].filter(Boolean),
    },
  });


      // if found anywhere → block signup
      if (existingUser || existingClient) {
        return ctx.badRequest(
          "Email or phone already registered. Please login instead."
        );
      }

      // ---------- DELETE OLD PENDING ----------
      await strapi.db
        .query("api::pending-signup.pending-signup")
        .deleteMany({ where: { identifier } });

      // ---------- STORE PENDING ----------
      await strapi.entityService.create("api::pending-signup.pending-signup", {
        data: {
          identifier,
          signupData: {
            email,
            phone,
            password, // IMPORTANT: keep plain
            role: role || null,
          },
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        },
      });

      // ---------- SEND OTP ----------
      let to = identifier;
      let channel = "email";

      if (phone) {
        to = formatPhone(phone); // Twilio requires +91
        channel = "sms";
      }

      strapi.log.info(`[OTP] Starting new verification session for ${to}`);

      await client.verify.v2
        .services(process.env.TWILIO_VERIFY_SERVICE_SID as string)
        .verifications.create({
          to,
          channel,
        });

      strapi.log.info(`[OTP] Fresh OTP sent to ${to}`);

      ctx.send({ message: "OTP sent successfully" });

    } catch (err) {
      strapi.log.error("REGISTER ERROR");
      strapi.log.error(err);
      ctx.internalServerError("Registration failed");
    }
  },
};
