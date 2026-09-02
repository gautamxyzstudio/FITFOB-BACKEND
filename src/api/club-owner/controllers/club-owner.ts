import { factories } from "@strapi/strapi";
import { Context } from "koa";

const POPULATE: any = {
  user: true,
  logo: true,
  clubPhotos: true,
  club_owner_documents: {
    populate: ["File"],
  },
};

export default factories.createCoreController(
  "api::club-owner.club-owner",
  ({ strapi }) => ({
    /* =======================================================
       VERIFIED CLUB OWNERS
    ======================================================= */
    async find(ctx: Context) {
      try {
        const { search } = ctx.query as any;

        const filters: any = {
          user: { verification_status: "approved" },
        };

        const data: any[] = await strapi.entityService.findMany(
          "api::club-owner.club-owner",
          {
            populate: {
              user: true,
              logo: true,
            },
            filters,
            sort: { id: "desc" },
          },
        );

        const dataWithCurrentStep = data.map((item: any) => {
          return {
            id: item.id,
            documentId: item.documentId,
            ownerName: item.ownerName,
            clubName: item.clubName,
            clubId: item.clubId,
            phoneNumber: item.phoneNumber,
            logo: item.logo.formats.thumbnail.url,
            createdAt: item.createdAt,
            clubAddress: item.clubAddress,
            city: item.city,
            state: item.state,
            user: {
              email: item.user.email,
              verification_status: item.user.verification_status,
            },
            pincode: item.pincode,
          };
        });

        let finalData = dataWithCurrentStep;

        // 🔍 Global search (ownerName + clubName)
        if (search?.trim()) {
          const searchValue = search.replace(/\s+/g, "").toLowerCase();

          finalData = dataWithCurrentStep.filter((item: any) => {
            const owner = item.ownerName?.replace(/\s+/g, "").toLowerCase();
            const club = item.clubName?.replace(/\s+/g, "").toLowerCase();

            return owner?.includes(searchValue) || club?.includes(searchValue);
          });
        }

        // finalData = finalData.map((item) => {
        //   const obj = JSON.parse(JSON.stringify(item));

        //   return {
        //     ...obj,
        //     isRead: (obj.read_by_admins || []).length > 0,
        //   };
        // });

        ctx.body = finalData;
      } catch (err) {
        strapi.log.error("FETCH VERIFIED CLUB OWNERS ERROR:", err);
        return ctx.internalServerError("Failed to fetch verified club owners");
      }
    },

    /* =======================================================
       UNVERIFIED CLUB OWNERS
    ======================================================= */
    async unverified(ctx: Context) {
      try {
        const { search } = ctx.query as any;

        const filters: any = {
          user: { verification_status: "pending" },
        };

        const data: any[] = await strapi.entityService.findMany(
          "api::club-owner.club-owner",
          {
            populate: POPULATE,
            filters,
            sort: { id: "desc" },
          },
        );

        let finalData = data;

        // 🔍 Global search (ownerName + clubName)
        if (search?.trim()) {
          const searchValue = search.replace(/\s+/g, "").toLowerCase();

          finalData = data.filter((item: any) => {
            const owner = item.ownerName?.replace(/\s+/g, "").toLowerCase();
            const club = item.clubName?.replace(/\s+/g, "").toLowerCase();

            return owner?.includes(searchValue) || club?.includes(searchValue);
          });
        }

        finalData = finalData.map((item) => {
          const obj = JSON.parse(JSON.stringify(item));

          return {
            ...obj,
            isRead: (obj.read_by_admins || []).length > 0,
          };
        });

        ctx.body = finalData;
      } catch (err) {
        strapi.log.error("FETCH UNVERIFIED CLUB OWNERS ERROR:", err);
        return ctx.internalServerError(
          "Failed to fetch unverified club owners",
        );
      }
    },

    /* =======================================================
       GET SINGLE CLUB OWNER 
    ======================================================= */
    async findOne(ctx: Context) {
      try {
        const { id } = ctx.params;

        if (!id) {
          return ctx.badRequest("Club owner ID is required");
        }

        const entity: any = await strapi.entityService.findOne(
          "api::club-owner.club-owner",
          id,
          { populate: POPULATE },
        );

        if (!entity || !entity.user) {
          return ctx.notFound("Club owner not found");
        }

        ctx.body = entity;
      } catch (err) {
        strapi.log.error("GET CLUB OWNER ERROR:", err);
        return ctx.internalServerError("Failed to fetch club owner");
      }
    },

    /* =======================================================
       UPDATE CLUB OWNER
    ======================================================= */
    async update(ctx: Context) {
      try {
        const { id } = ctx.params;
        const body = (ctx.request.body as any) ?? {};
        const data = body.data ?? body;

        if (!id) {
          return ctx.badRequest("Club owner ID is required");
        }

        if (!data || Object.keys(data).length === 0) {
          return ctx.badRequest("Update data is required");
        }

        const existing = await strapi.entityService.findOne(
          "api::club-owner.club-owner",
          id,
        );

        if (!existing) {
          return ctx.notFound("Club owner not found");
        }

        await strapi.entityService.update("api::club-owner.club-owner", id, {
          data,
        });

        const entity: any = await strapi.entityService.findOne(
          "api::club-owner.club-owner",
          id,
          { populate: POPULATE },
        );

        ctx.body = entity;
      } catch (err) {
        strapi.log.error("UPDATE CLUB OWNER ERROR:", err);
        return ctx.internalServerError("Failed to update club owner");
      }
    },

    /* =======================================================
       DELETE CLUB OWNER
    ======================================================= */
    async delete(ctx: Context) {
      try {
        const { id } = ctx.params;

        if (!id) {
          return ctx.badRequest("Club owner ID is required");
        }

        const entity: any = await strapi.entityService.findOne(
          "api::club-owner.club-owner",
          id,
          { populate: POPULATE },
        );

        if (!entity) return ctx.notFound("Club owner not found");

        await strapi.entityService.delete("api::club-owner.club-owner", id);

        ctx.body = {
          success: true,
          deleted: entity,
        };
      } catch (err) {
        strapi.log.error("DELETE CLUB OWNER ERROR:", err);
        return ctx.internalServerError("Failed to delete club owner");
      }
    },

    /* =======================================================
       GET LOGGED-IN CLUB OWNER
    ======================================================= */
    async getMyClubOwner(ctx: Context) {
      try {
        /* GET USER FROM JWT TOKEN */
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        /* FIND CLUB OWNER OF THIS USER */
        const clubOwner = await strapi.db
          .query("api::club-owner.club-owner")
          .findOne({
            where: { user: user.id },
            populate: {
              user: true,
              logo: true,
              clubPhotos: true,
              club_owner_documents: true,
            },
          });

        if (!clubOwner) {
          return ctx.notFound("Club owner not found");
        }

        ctx.body = clubOwner;
      } catch (error) {
        strapi.log.error("GET MY CLUB OWNER ERROR:", error);
        return ctx.internalServerError("Something went wrong");
      }
    },

    /* =======================================================
       MARK CLUB OWNER REQUEST AS READ BY ADMIN
    ======================================================= */
    async markClubRead(ctx: Context) {
      try {
        const admin = ctx.state.user;
        const { id } = ctx.params;

        if (!admin) {
          return ctx.unauthorized("Admin authentication required");
        }

        if (!id) {
          return ctx.badRequest("Club ID is required");
        }

        const club = await strapi.db
          .query("api::club-owner.club-owner")
          .findOne({
            where: { id },
            select: ["id", "read_by_admins"],
          });

        if (!club) {
          return ctx.notFound("Club request not found");
        }

        let readers = Array.isArray(club.read_by_admins)
          ? [...club.read_by_admins]
          : [];

        if (!readers.includes(admin.id)) {
          readers.push(admin.id);

          await strapi.db.query("api::club-owner.club-owner").update({
            where: { id },
            data: {
              read_by_admins: readers,
            },
          });
        }

        return ctx.send({
          success: true,
          message: "Club request marked as read",
        });
      } catch (error) {
        strapi.log.error("CLUB READ ERROR:", error);
        return ctx.internalServerError("Something went wrong");
      }
    },
  }),
);
