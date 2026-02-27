import { factories } from "@strapi/strapi";
import { Context } from "koa";

export default factories.createCoreController(
    "api::club-owner.club-owner",
    ({ strapi }) => ({

        /* =======================================================
                  ONLY VERIFIED CLUB OWNERS
        ======================================================= */
        async find(ctx: Context) {
            try {
                const data = await strapi.entityService.findMany(
                    "api::club-owner.club-owner",
                    {
                        populate: {
                            user: true,
                            logo: true,
                            clubPhotos: true,
                            club_owner_documents: {
                                populate: ["File"],
                            },
                        },

                        filters: {
                            user: {
                                isVerified: true,
                            },
                        },

                        sort: { createdAt: "desc" },
                    }
                );

                const filtered = data.filter((item: any) => item.user);

                ctx.body = {
                    data: filtered,
                    meta: {
                        total: filtered.length,
                    },
                };
            } catch (err) {
                console.error("Verified club owner fetch error:", err);
                ctx.throw(500, "Unable to fetch club owners");
            }
        },

        /* =======================================================
               ONLY UNVERIFIED CLUB OWNERS
     ======================================================= */
        async unverified(ctx: Context) {
            try {
                const data = await strapi.entityService.findMany(
                    "api::club-owner.club-owner",
                    {
                        populate: {
                            user: true,
                            logo: true,
                            clubPhotos: true,
                            club_owner_documents: {
                                populate: ["File"],
                            },
                        },
                        filters: {
                            user: {
                                isVerified: false,
                            },
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

    })
);