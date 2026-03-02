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
        const data: any[] = await strapi.entityService.findMany(
          "api::club-owner.club-owner",
          {
            populate: POPULATE,
            filters: {
              user: { isVerified: true },
            },
            sort: { createdAt: "desc" },
          }
        );

        const filtered = data.filter((item: any) => item.user);

        ctx.body = {
          data: filtered,
          meta: { total: filtered.length },
        };
      } catch (err) {
        console.error(err);
        ctx.throw(500, "Unable to fetch club owners");
      }
    },

    /* =======================================================
       UNVERIFIED CLUB OWNERS
    ======================================================= */
    async unverified(ctx: Context) {
      try {
        const data: any[] = await strapi.entityService.findMany(
          "api::club-owner.club-owner",
          {
            populate: POPULATE,
            filters: {
              user: { isVerified: false },
            },
            sort: { createdAt: "desc" },
          }
        );

        const filtered = data.filter((item: any) => item.user);

        ctx.body = {
          success: true,
          total: filtered.length,
          data: filtered,
        };
      } catch (err) {
        console.error(err);
        ctx.throw(500, "Failed to fetch unverified club owners");
      }
    },

    /* =======================================================
       GET SINGLE CLUB OWNER (NO MORE 404)
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

  })
);