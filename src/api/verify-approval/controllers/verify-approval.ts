import { createClubOwnerFromPending } from "../../pending-club-owner/controllers/pending-club-owner";

export default {

  /* ---------- APPROVE USER ---------- */
  async verificationApproved(ctx: any) {
    try {
      const { id } = ctx.params;
      const adminUser = ctx.state.user;

      if (!adminUser) {
        return ctx.unauthorized("Authentication required");
      }

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
          rejection_reason: null,
          approved_by: adminUser.id,
          rejected_by: null,
        },
      });

      /* ---------- CREATE CLUB OWNER DETAILS FROM PENDING DRAFT ---------- */
      await createClubOwnerFromPending(user.id);

      const updatedUser = await strapi.db
        .query("plugin::users-permissions.user")
        .findOne({
          where: { id },
          populate: {
            role: true,
            approved_by: {
              populate: ["role"],
            },
            rejected_by: {
              populate: ["role"],
            },
          },
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
      const adminUser = ctx.state.user;

      if (!adminUser) {
        return ctx.unauthorized("Authentication required");
      }

      if (!id) {
        return ctx.badRequest("User id is required");
      }

      const body = ctx.request.body || {};
      const reason = body.rejection_reason?.trim();

      if (!reason) {
        return ctx.badRequest("Rejection reason is required");
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
          rejection_reason: reason,
          rejected_by: adminUser.id,
          approved_by: null,
        },
      });

      const updatedUser = await strapi.db
        .query("plugin::users-permissions.user")
        .findOne({
          where: { id },
          populate: {
            role: true,
            approved_by: {
              populate: ["role"],
            },
            rejected_by: {
              populate: ["role"],
            },
          },
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
