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
          user: { verification_status: 'approved' },
        };

        const data: any[] = await strapi.entityService.findMany(
          "api::club-owner.club-owner",
          {
            populate: POPULATE,
            filters,
            sort: { id: "desc" }, // ✅ sort by id ascending
          }
        );

        let finalData = data;

        // 🔍 Global search (ownerName + clubName)
        if (search?.trim()) {
          const searchValue = search.replace(/\s+/g, "").toLowerCase();

          finalData = data.filter((item: any) => {
            const owner = item.ownerName
              ?.replace(/\s+/g, "")
              .toLowerCase();

            const club = item.clubName
              ?.replace(/\s+/g, "")
              .toLowerCase();

            return (
              owner?.includes(searchValue) ||
              club?.includes(searchValue)
            );
          });
        }

        ctx.body = {
          success: true,
          total: finalData.length,
          data: finalData,
        };
      } catch (err) {
        console.error(err);
        ctx.throw(500, "Failed to fetch unverified club owners");
      }
    },

    /* =======================================================
       UNVERIFIED CLUB OWNERS
    ======================================================= */
    async unverified(ctx: Context) {
      try {
        const { search } = ctx.query as any;

        const filters: any = {
          user: { verification_status: 'pending' },
        };

        const data: any[] = await strapi.entityService.findMany(
          "api::club-owner.club-owner",
          {
            populate: POPULATE,
            filters,
            sort: { id: "desc" }, // ✅ sort by id ascending
          }
        );

        let finalData = data;

        // 🔍 Global search (ownerName + clubName)
        if (search?.trim()) {
          const searchValue = search.replace(/\s+/g, "").toLowerCase();

          finalData = data.filter((item: any) => {
            const owner = item.ownerName
              ?.replace(/\s+/g, "")
              .toLowerCase();

            const club = item.clubName
              ?.replace(/\s+/g, "")
              .toLowerCase();

            return (
              owner?.includes(searchValue) ||
              club?.includes(searchValue)
            );
          });
        }

        ctx.body = {
          success: true,
          total: finalData.length,
          data: finalData,
        };
      } catch (err) {
        console.error(err);
        ctx.throw(500, "Failed to fetch unverified club owners");
      }
    },
    /* =======================================================
       GET SINGLE CLUB OWNER 
    ======================================================= */
    async findOne(ctx: Context) {
      const { id } = ctx.params;

      const entity: any = await strapi.entityService.findOne(
        "api::club-owner.club-owner",
        id,
        { populate: POPULATE }
      );

      if (!entity || !entity.user) {
        return ctx.notFound("Club owner not found");
      }

      ctx.body = {
        data: entity,
      };
    },

    /* =======================================================
       UPDATE CLUB OWNER
    ======================================================= */
    async update(ctx: Context) {
      const { id } = ctx.params;
      const { data } = ctx.request.body as any;

      await strapi.entityService.update(
        "api::club-owner.club-owner",
        id,
        { data }
      );

      const entity: any = await strapi.entityService.findOne(
        "api::club-owner.club-owner",
        id,
        { populate: POPULATE }
      );

      ctx.body = {
        data: entity,
      };
    },

    /* =======================================================
       DELETE CLUB OWNER
    ======================================================= */
    async delete(ctx: Context) {
      const { id } = ctx.params;

      const entity: any = await strapi.entityService.findOne(
        "api::club-owner.club-owner",
        id,
        { populate: POPULATE }
      );

      if (!entity) return ctx.notFound("Club owner not found");

      await strapi.entityService.delete(
        "api::club-owner.club-owner",
        id
      );

      ctx.body = {
        success: true,
        deleted: entity,
      };
    },


    async getMyClubOwner(ctx) {

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
              club_owner_documents: true
            }
          });

        if (!clubOwner) {
          return ctx.notFound("Club owner not found");
        }

        ctx.body = clubOwner;

      } catch (error) {
        strapi.log.error(error);
        return ctx.internalServerError("Something went wrong");
      }

    }

  })
);