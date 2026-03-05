export default {
  /* ---------- APPROVE USER ---------- */
  async verificationApproved(ctx: any) {
    try {
      const { id } = ctx.params;

      if (!id) {
        return ctx.badRequest("User id is required");
      }

      const user = await strapi.db
        .query("plugin::users-permissions.user")
        .findOne({
          where: { id },
        });

      if (!user) {
        return ctx.notFound("User not found");
      }

      await strapi.db.query("plugin::users-permissions.user").update({
        where: { id },
        data: {
          verification_status: "approved",
        },
      });

      const updatedUser = await strapi.db
        .query("plugin::users-permissions.user")
        .findOne({
          where: { id },
          populate: ["role"],
        });

      ctx.body = {
        message: "User verification approved",
        user: updatedUser,
      };
    } catch (err: any) {
      strapi.log.error("APPROVE ERROR:", err);
      return ctx.internalServerError("Failed to approve user");
    }
  },

  /* ---------- REJECT USER ---------- */
  async verificationRejected(ctx: any) {
    try {
      const { id } = ctx.params;

      if (!id) {
        return ctx.badRequest("User id is required");
      }

      const user = await strapi.db
        .query("plugin::users-permissions.user")
        .findOne({
          where: { id },
        });

      if (!user) {
        return ctx.notFound("User not found");
      }

      await strapi.db.query("plugin::users-permissions.user").update({
        where: { id },
        data: {
          verification_status: "rejected",
        },
      });

      const updatedUser = await strapi.db
        .query("plugin::users-permissions.user")
        .findOne({
          where: { id },
          populate: ["role"],
        });

      ctx.body = {
        message: "User verification rejected",
        user: updatedUser,
      };
    } catch (err: any) {
      strapi.log.error("REJECT ERROR:", err);
      return ctx.internalServerError("Failed to reject user");
    }
  },
};