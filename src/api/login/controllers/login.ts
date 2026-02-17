/* ================= PHONE + EMAIL HELPERS (SAFE) ================= */

// email detector (same behaviour as your includes("@"))
const isEmail = (value: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

// ⭐ THIS is the missing function causing red line
const formatPhone = (value: string): string => {
  if (!value) return value;

  // remove spaces, dash, brackets etc
  const digits = value.replace(/\D/g, "");

  // 8687422222  -> +918687422222
  if (digits.length === 10) return `+91${digits}`;

  // 918687422222 -> +918687422222
  if (digits.length === 12 && digits.startsWith("91"))
    return `+${digits}`;

  // already +91XXXXXXXXXX
  if (value.startsWith("+91")) return value;

  return value;
};


export default {

  async login(ctx: any) {
    try {

      const { identifier, password } = ctx.request.body;

      if (!identifier || !password) {
        return ctx.badRequest("Identifier and password required");
      }

      const userQuery = strapi.db.query("plugin::users-permissions.user");

      let user: any;

      /* ---------- EMAIL LOGIN ---------- */
      if (isEmail(identifier)) {
        user = await userQuery.findOne({
          where: { email: identifier.toLowerCase() },
          populate: ["role"],
        });
      }
      /* ---------- PHONE LOGIN ---------- */
      else {

        // add +91 automatically
        const phoneWithPrefix = formatPhone(identifier);

        strapi.log.info(`[LOGIN] Input: ${identifier}`);
        strapi.log.info(`[LOGIN] Searching: ${phoneWithPrefix}`);

        user = await userQuery.findOne({
          where: { phoneNumber: phoneWithPrefix },
          populate: ["role"],
        });
      }

      if (!user) {
        return ctx.badRequest("User not found");
      }

      /* ---------- PASSWORD CHECK ---------- */
      const validPassword = await strapi
        .plugin("users-permissions")
        .service("user")
        .validatePassword(password, user.password);

      if (!validPassword) {
        return ctx.badRequest("Invalid password");
      }

      if (user.blocked) {
        return ctx.badRequest("User is blocked");
      }

      /* ---------- ISSUE JWT ---------- */
      const jwt = strapi
        .plugin("users-permissions")
        .service("jwt")
        .issue({ id: user.id });

      /* ---------- FETCH CLEAN USER (IMPORTANT) ---------- */
      const fullUser = await strapi.db
        .query("plugin::users-permissions.user")
        .findOne({
          where: { id: user.id },
          populate: ["role"],
        });

      /* ---------- SEND SAFE RESPONSE ---------- */
      ctx.send({
        jwt,
        user: {
          id: fullUser.id,
          username: fullUser.username,
          email: fullUser.email,
          phoneNumber: fullUser.phoneNumber,
          isVerified: fullUser.isVerified,   // ⭐ NOW INCLUDED
          cognitoSub: fullUser.cognitoSub,
          confirmed: fullUser.confirmed,
          blocked: fullUser.blocked,
          role: fullUser.role,
        },
      });

    } catch (err) {
      strapi.log.error("CUSTOM LOGIN ERROR");
      strapi.log.error(err);
      ctx.internalServerError("Login failed");
    }
  },
};
