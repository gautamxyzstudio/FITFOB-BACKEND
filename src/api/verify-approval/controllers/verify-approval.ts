import {
  createClubOwnerFromPending,
  deletePendingClubOwnersForUser,
} from "../../pending-club-owner/controllers/pending-club-owner";

const PENDING_CLUB_OWNER_UID = "api::pending-club-owner.pending-club-owner";

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
      await deletePendingClubOwnersForUser(user.id);

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
            club_owner: true,
            pending_club_owner: true,
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
          populate: ["pending_club_owner"],
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

      /* ---------- RESET PENDING CLUB OWNER CURRENT STEP TO 5 ---------- */
      // 1. Check direct relation from user
      if (user.pending_club_owner?.id) {
        await strapi.db.query(PENDING_CLUB_OWNER_UID).update({
          where: { id: user.pending_club_owner.id },
          data: {
            currentStep: 5,
            status: "draft",
          },
        });
      }

      // 2. Query pending club owners by user relation
      const pendingOwners = await strapi.db
        .query(PENDING_CLUB_OWNER_UID)
        .findMany({
          where: { user: user.id },
        });

      for (const pending of pendingOwners || []) {
        await strapi.db.query(PENDING_CLUB_OWNER_UID).update({
          where: { id: pending.id },
          data: {
            currentStep: 5,
            status: "draft",
          },
        });
      }

      // 3. Fallback check using entityService
      if ((!pendingOwners || pendingOwners.length === 0) && !user.pending_club_owner?.id) {
        const drafts: any[] = await strapi.entityService.findMany(
          PENDING_CLUB_OWNER_UID,
          {
            filters: { user: { id: user.id } },
          },
        );
        for (const draft of drafts || []) {
          await strapi.entityService.update(PENDING_CLUB_OWNER_UID, draft.id, {
            data: {
              currentStep: 5,
              status: "draft",
            },
          });
        }
      }

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
            pending_club_owner: true,
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

  /* ---------- GET VERIFICATION STATUS (LOGGED-IN USER VIA JWT) ---------- */
  async getVerificationStatus(ctx: any) {
    try {
      const user = ctx.state.user;

      if (!user) {
        return ctx.unauthorized("Authentication required");
      }

      const fullUser = await strapi.db
        .query("plugin::users-permissions.user")
        .findOne({
          where: { id: user.id },
          populate: {
            approved_by: {
              select: ["id", "username", "email"],
            },
            rejected_by: {
              select: ["id", "username", "email"],
            },
          },
        });

      if (!fullUser) {
        return ctx.notFound("User not found");
      }

      ctx.body = {
        userId: fullUser.id,
        email: fullUser.email,
        username: fullUser.username,
        verification_status: fullUser.verification_status || "pending",
        rejection_reason: fullUser.rejection_reason || null,
        approved_by: fullUser.approved_by || null,
        rejected_by: fullUser.rejected_by || null,
      };
    } catch (err: any) {
      strapi.log.error("GET VERIFICATION STATUS ERROR:", err);
      return ctx.internalServerError("Failed to fetch verification status");
    }
  },
};
