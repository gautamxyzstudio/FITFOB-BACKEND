/**
 * club-service controller
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
  "api::club-service.club-service",
  ({ strapi }) => ({
    async find(ctx: Context) {
      try {
        const user = ctx.state.user;
        const role = await getUserRole(user);
        const isClubOwner = role === "clubowner";

        const { isActive } = ctx.query as any;

        const filters: any = {};

        // For clubOwner: only active services are returned.
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
            .documents("api::club-service.club-service")
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
            "api::club-service.club-service",
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

        // For clubOwner: return array of string names for active services
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
            clubOwners: Array.isArray(item.club_owners)
              ? item.club_owners.length
              : 0,
            pendingClubOwners: Array.isArray(item.pending_club_owners)
              ? item.pending_club_owners.length
              : 0,
            isActive: item.isActive,
            createdAt: item.createdAt,
          };
        });

        ctx.body = data;
      } catch (error) {
        strapi.log.error("FETCH CLUB SERVICES ERROR:", error);
        return ctx.internalServerError("Failed to fetch club services");
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
            .documents("api::club-service.club-service")
            .findOne({
              documentId,
              populate: {
                logo: true,
              },
            });
        }

        if (!item) {
          item = await strapi.db
            .query("api::club-service.club-service")
            .findOne({
              where: { documentId },
              populate: {
                logo: true,
              },
            });
        }

        if (!item) {
          return ctx.notFound("Club service not found");
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
        strapi.log.error("FETCH CLUB SERVICE ERROR:", error);
        return ctx.internalServerError("Failed to fetch club service");
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
              .documents("api::club-service.club-service")
              .update({
                documentId,
                data: payload,
                populate: {
                  logo: true,
                },
              });
          } catch (docErr) {
            strapi.log.warn(
              "documents.update error in club-service update:",
              docErr,
            );
          }
        }

        if (!item) {
          const existing = await strapi.db
            .query("api::club-service.club-service")
            .findOne({
              where: { documentId },
            });

          if (!existing) {
            return ctx.notFound("Club service not found");
          }

          await strapi.entityService.update(
            "api::club-service.club-service",
            existing.id,
            {
              data: payload,
            },
          );

          if ((strapi as any).documents) {
            item = await (strapi as any)
              .documents("api::club-service.club-service")
              .findOne({
                documentId,
                populate: {
                  logo: true,
                },
              });
          } else {
            item = await strapi.entityService.findOne(
              "api::club-service.club-service",
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
          return ctx.notFound("Club service not found");
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
        strapi.log.error("UPDATE CLUB SERVICE ERROR:", error);
        return ctx.internalServerError("Failed to update club service");
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
              .documents("api::club-service.club-service")
              .create({
                data: payload,
                populate: {
                  logo: true,
                },
              });
          } catch (docErr) {
            strapi.log.warn(
              "documents.create error in club-service create:",
              docErr,
            );
          }
        }

        if (!item) {
          const created = await strapi.entityService.create(
            "api::club-service.club-service",
            {
              data: payload,
            },
          );

          if ((strapi as any).documents && (created as any)?.documentId) {
            item = await (strapi as any)
              .documents("api::club-service.club-service")
              .findOne({
                documentId: (created as any).documentId,
                populate: {
                  logo: true,
                },
              });
          } else {
            item = await strapi.entityService.findOne(
              "api::club-service.club-service",
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
        strapi.log.error("CREATE CLUB SERVICE ERROR:", error);
        return ctx.internalServerError("Failed to create club service");
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
              .documents("api::club-service.club-service")
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
            .query("api::club-service.club-service")
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
          return ctx.notFound("Club service not found");
        }

        let deleted = false;
        if ((strapi as any).documents && item.documentId) {
          try {
            await (strapi as any)
              .documents("api::club-service.club-service")
              .delete({
                documentId: item.documentId,
              });
            deleted = true;
          } catch (docErr) {
            strapi.log.warn(
              "documents.delete error in club-service delete:",
              docErr,
            );
          }
        }

        if (!deleted && item.id) {
          await strapi.entityService.delete(
            "api::club-service.club-service",
            item.id,
          );
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

        ctx.body = {
          success: true,
          message: "Club service deleted successfully",
          data,
        };
      } catch (error) {
        strapi.log.error("DELETE CLUB SERVICE ERROR:", error);
        return ctx.internalServerError("Failed to delete club service");
      }
    },
  }),
);

