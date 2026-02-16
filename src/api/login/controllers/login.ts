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
      if (identifier.includes("@")) {
        user = await userQuery.findOne({
          where: { email: identifier.toLowerCase() },
          populate: ["role"],
        });
      }
      /* ---------- PHONE LOGIN ---------- */
      else {
        user = await userQuery.findOne({
          where: { phoneNumber: identifier },
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
