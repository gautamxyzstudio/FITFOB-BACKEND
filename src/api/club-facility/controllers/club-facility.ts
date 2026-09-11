/**
 * club-facility controller
 */

import { factories } from "@strapi/strapi";
import { Context } from "koa";

/* ---------- ROLE HELPER ---------- */
async function getUserRole(user: any): Promise<string> {
  if (!user) return "";
  if (user._cachedRole) return user._cachedRole;

  if (user.role?.name || user.role?.type) {
    const role =
      user.role.name?.toLowerCase().replace(/[\s_-]+/g, "") ||
      user.role.type?.toLowerCase().replace(/[\s_-]+/g, "") ||
      "";
    user._cachedRole = role;
    return role;
  }

  const fullUser: any = await strapi.db
    .query("plugin::users-permissions.user")
    .findOne({
      where: { id: user.id },
      select: ["id"],
      populate: {
        role: {
          select: ["id", "name", "type"],
        },
      },
    });

  const role =
    fullUser?.role?.name?.toLowerCase().replace(/[\s_-]+/g, "") ||
    fullUser?.role?.type?.toLowerCase().replace(/[\s_-]+/g, "") ||
    "";
  user._cachedRole = role;
  return role;
}

export default factories.createCoreController(
  "api::club-facility.club-facility",
  ({ strapi }) => ({
    async find(ctx: Context) {
      try {
        const user = ctx.state.user;
        const role = await getUserRole(user);
        const isClubOwner = role === "clubowner";

        const { isActive } = ctx.query as any;

        const filters: any = {};

        // For clubOwner: only active facilities are returned.
        // For others: if isActive is provided as true/false, filter by that; otherwise return all.
        if (isClubOwner) {
          filters.isActive = true;
        } else if (isActive === "true" || isActive === true) {
          filters.isActive = true;
        } else if (isActive === "false" || isActive === false) {
          filters.isActive = false;
        }

        let entries: any[] = [];
        if ((strapi as any).documents) {
          entries = await (strapi as any)
            .documents("api::club-facility.club-facility")
            .findMany({
              filters,
              populate: {
                logo: true,
                club_owners: true,
                pending_club_owners: true,
              },
              sort: { createdAt: "desc" },
            });
        } else {
          entries = await strapi.entityService.findMany(
            "api::club-facility.club-facility",
            {
              filters,
              populate: {
                logo: true,
                club_owners: true,
                pending_club_owners: true,
              },
              sort: { createdAt: "desc" },
            },
          );
        }

        // For clubOwner: return array of string names for active facilities
        if (isClubOwner) {
          const names: string[] = (entries || [])
            .filter((item: any) => item.isActive !== false && item.name)
            .map((item: any) => item.name);

          ctx.body = names;
          return;
        }

        const data = (entries || []).map((item: any) => {
          let logoUrl = null;
          if (item.logo?.url) {
            logoUrl = item.logo.url.startsWith("http")
              ? item.logo.url
              : `${strapi.config.server.url || ""}${item.logo.url}`;
          }

          return {
            documentId: item.documentId || null,
            name: item.name,
            logo: logoUrl,
            isActive: item.isActive,
            clubOwners: Array.isArray(item.club_owners)
              ? item.club_owners.length
              : 0,
            pendingClubOwners: Array.isArray(item.pending_club_owners)
              ? item.pending_club_owners.length
              : 0,
            createdAt: item.createdAt,
          };
        });

        ctx.body = data;
      } catch (error) {
        strapi.log.error("FETCH CLUB FACILITIES ERROR:", error);
        return ctx.internalServerError("Failed to fetch club facilities");
      }
    },

    async findOne(ctx: Context) {
      try {
        const { id } = ctx.params;

        if (!id) {
          return ctx.badRequest("Document ID is required");
        }

        const documentId = String(id).trim();

        let item: any = null;
        if ((strapi as any).documents) {
          item = await (strapi as any)
            .documents("api::club-facility.club-facility")
            .findOne({
              documentId,
              populate: {
                logo: true,
              },
            });
        }

        if (!item) {
          item = await strapi.db
            .query("api::club-facility.club-facility")
            .findOne({
              where: { documentId },
              populate: {
                logo: true,
              },
            });
        }

        if (!item) {
          return ctx.notFound("Club facility not found");
        }

        let logoUrl = null;
        if (item.logo?.url) {
          logoUrl = item.logo.url.startsWith("http")
            ? item.logo.url
            : `${strapi.config.server.url || ""}${item.logo.url}`;
        }

        const data = {
          documentId: item.documentId || null,
          name: item.name,
          logo: logoUrl,
          isActive: item.isActive,
          createdAt: item.createdAt,
        };

        ctx.body = data;
      } catch (error) {
        strapi.log.error("FETCH CLUB FACILITY ERROR:", error);
        return ctx.internalServerError("Failed to fetch club facility");
      }
    },

    async update(ctx: Context) {
      try {
        const { id } = ctx.params;

        if (!id) {
          return ctx.badRequest("Document ID is required");
        }

        const documentId = String(id).trim();

        const body = (ctx.request.body as any) ?? {};
        const payload = body.data !== undefined ? body.data : body;

        let item: any = null;

        if ((strapi as any).documents) {
          try {
            item = await (strapi as any)
              .documents("api::club-facility.club-facility")
              .update({
                documentId,
                data: payload,
                populate: {
                  logo: true,
                },
              });
          } catch (docErr) {
            strapi.log.warn(
              "documents.update error in club-facility update:",
              docErr,
            );
          }
        }

        if (!item) {
          const existing = await strapi.db
            .query("api::club-facility.club-facility")
            .findOne({
              where: { documentId },
            });

          if (!existing) {
            return ctx.notFound("Club facility not found");
          }

          await strapi.entityService.update(
            "api::club-facility.club-facility",
            existing.id,
            {
              data: payload,
            },
          );

          if ((strapi as any).documents) {
            item = await (strapi as any)
              .documents("api::club-facility.club-facility")
              .findOne({
                documentId,
                populate: {
                  logo: true,
                },
              });
          } else {
            item = await strapi.entityService.findOne(
              "api::club-facility.club-facility",
              existing.id,
              {
                populate: {
                  logo: true,
                },
              },
            );
          }
        }

        if (!item) {
          return ctx.notFound("Club facility not found");
        }

        let logoUrl = null;
        if (item.logo?.url) {
          logoUrl = item.logo.url.startsWith("http")
            ? item.logo.url
            : `${strapi.config.server.url || ""}${item.logo.url}`;
        }

        const data = {
          documentId: item.documentId || null,
          name: item.name,
          logo: logoUrl,
          isActive: item.isActive,
          createdAt: item.createdAt,
        };

        ctx.body = data;
      } catch (error) {
        strapi.log.error("UPDATE CLUB FACILITY ERROR:", error);
        return ctx.internalServerError("Failed to update club facility");
      }
    },

    async create(ctx: Context) {
      try {
        const body = (ctx.request.body as any) ?? {};
        const payload = body.data !== undefined ? body.data : body;

        let item: any = null;

        if ((strapi as any).documents) {
          try {
            item = await (strapi as any)
              .documents("api::club-facility.club-facility")
              .create({
                data: payload,
                populate: {
                  logo: true,
                },
              });
          } catch (docErr) {
            strapi.log.warn(
              "documents.create error in club-facility create:",
              docErr,
            );
          }
        }

        if (!item) {
          const created = await strapi.entityService.create(
            "api::club-facility.club-facility",
            {
              data: payload,
            },
          );

          if ((strapi as any).documents && (created as any)?.documentId) {
            item = await (strapi as any)
              .documents("api::club-facility.club-facility")
              .findOne({
                documentId: (created as any).documentId,
                populate: {
                  logo: true,
                },
              });
          } else {
            item = await strapi.entityService.findOne(
              "api::club-facility.club-facility",
              created.id,
              {
                populate: {
                  logo: true,
                },
              },
            );
          }
        }

        let logoUrl = null;
        if (item?.logo?.url) {
          logoUrl = item.logo.url.startsWith("http")
            ? item.logo.url
            : `${strapi.config.server.url || ""}${item.logo.url}`;
        }

        const data = {
          documentId: item?.documentId || null,
          name: item?.name,
          logo: logoUrl,
          isActive: item?.isActive,
          createdAt: item?.createdAt,
        };

        ctx.body = data;
      } catch (error) {
        strapi.log.error("CREATE CLUB FACILITY ERROR:", error);
        return ctx.internalServerError("Failed to create club facility");
      }
    },

    async delete(ctx: Context) {
      try {
        const { id } = ctx.params;

        if (!id) {
          return ctx.badRequest("Document ID is required");
        }

        const isNumeric = !isNaN(Number(id)) && /^\d+$/.test(String(id).trim());

        let item: any = null;
        if ((strapi as any).documents && !isNumeric) {
          try {
            item = await (strapi as any)
              .documents("api::club-facility.club-facility")
              .findOne({
                documentId: String(id).trim(),
                populate: {
                  logo: true,
                },
              });
          } catch (e) {
            // fallback below
          }
        }

        if (!item) {
          item = await strapi.db
            .query("api::club-facility.club-facility")
            .findOne({
              where: isNumeric
                ? { $or: [{ documentId: String(id).trim() }, { id: Number(id) }] }
                : { documentId: String(id).trim() },
              populate: {
                logo: true,
              },
            });
        }

        if (!item) {
          return ctx.notFound("Club facility not found");
        }

        let deleted = false;
        if ((strapi as any).documents && item.documentId) {
          try {
            await (strapi as any)
              .documents("api::club-facility.club-facility")
              .delete({
                documentId: item.documentId,
              });
            deleted = true;
          } catch (docErr) {
            strapi.log.warn(
              "documents.delete error in club-facility delete:",
              docErr,
            );
          }
        }

        if (!deleted && item.id) {
          await strapi.entityService.delete(
            "api::club-facility.club-facility",
            item.id,
          );
        }

        ctx.body = {
          success: true,
          message: "Club facility deleted successfully",
        };
      } catch (error) {
        strapi.log.error("DELETE CLUB FACILITY ERROR:", error);
        return ctx.internalServerError("Failed to delete club facility");
      }
    },
  }),
);

