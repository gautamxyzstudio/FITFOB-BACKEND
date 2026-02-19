export default (plugin: any) => {

  const { sanitize } = require("@strapi/utils");

  plugin.controllers.auth.callback = async (ctx: any) => {

    const { identifier, password } = ctx.request.body;

    if (!identifier || !password) {
      return ctx.badRequest("Identifier and password required");
    }

    const userQuery = strapi.db.query("plugin::users-permissions.user");

    let user: any;

    // EMAIL LOGIN
    if (identifier.includes("@")) {
      user = await userQuery.findOne({
        where: { email: identifier.toLowerCase() },
        populate: { role: true },
      });
    }
    // PHONE LOGIN
    else {
      user = await userQuery.findOne({
        where: { phoneNumber: identifier },
        populate: { role: true },
      });
    }

    if (!user) return ctx.badRequest("Invalid credentials");

    const validPassword = await strapi
      .plugin("users-permissions")
      .service("user")
      .validatePassword(password, user.password);

    if (!validPassword) return ctx.badRequest("Invalid credentials");

    if (user.blocked) return ctx.badRequest("User is blocked");

    /* ================= MFA FOR ADMIN ROLE ================= */

    /* ===== BLOCK ADMIN FROM USING DEFAULT STRAPI LOGIN ===== */

    if (user.role?.name === "Admin") {
      return ctx.forbidden("Admins must login using secure login.");
    }

    // issue jwt
    const jwt = strapi
      .plugin("users-permissions")
      .service("jwt")
      .issue({ id: user.id });

    // ⭐ THIS is the missing part
    const sanitizedUser = await sanitize.contentAPI.output(
      user,
      strapi.getModel("plugin::users-permissions.user")
    );

    ctx.send({
      jwt,
      user: sanitizedUser,
    });
  };

  return plugin;
};
