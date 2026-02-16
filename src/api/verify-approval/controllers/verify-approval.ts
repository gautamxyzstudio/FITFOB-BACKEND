import { Context } from "koa";

export default {

  async verifyApproval(ctx: Context) {
    try {
      const { id } = ctx.params;

      if (!id) {
        return ctx.badRequest("User id required");
      }
      // find user
      const user = await strapi.entityService.findOne(
        "plugin::users-permissions.user",
        id
      );

      if (!user) {
        return ctx.notFound("User not found");
      }

      if (user.isVerified === true) {
        return ctx.badRequest("User already verified");
      }

      // UPDATE USER
      const updatedUser = await strapi.entityService.update(
        "plugin::users-permissions.user",
        id,
        {
          data: {
            isVerified: true,
          },
        }
      );

      ctx.send({
        message: "User approved successfully",
        user: {
          id: updatedUser.id,
          username: updatedUser.username,
          email: updatedUser.email,
          isVerified: updatedUser.isVerified,
        },
      });
    } catch (err) {
      strapi.log.error(err);
      ctx.internalServerError("Approval failed");
    }
  },

  async revokeApproval(ctx: Context) {
    try {
      const { id } = ctx.params;

      const user = await strapi.entityService.findOne(
        "plugin::users-permissions.user",
        id
      );

      if (!user) {
        return ctx.notFound("User not found");
      }

      if (!user.isVerified) {
        return ctx.badRequest("User is already unverified");
      }

      const updatedUser = await strapi.entityService.update(
        "plugin::users-permissions.user",
        id,
        {
          data: {
            isVerified: false,
          },
        }
      );

      ctx.send({
        message: "User approval revoked successfully",
        user: {
          id: updatedUser.id,
          username: updatedUser.username,
          email: updatedUser.email,
          isVerified: updatedUser.isVerified,
        },
      });
    } catch (err) {
      strapi.log.error(err);
      ctx.internalServerError("Failed to revoke approval");
    }
  }
  // fix
};
