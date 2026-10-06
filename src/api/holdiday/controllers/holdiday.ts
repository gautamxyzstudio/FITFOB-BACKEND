/**
 * holdiday controller
 */

import { factories } from "@strapi/strapi";
import { Context } from "koa";

const HOLDIDAY_UID = "api::holdiday.holdiday" as any;
const CLUB_OWNER_UID = "api::club-owner.club-owner" as any;

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
      populate: ["role"],
    });

  const role =
    fullUser?.role?.name?.toLowerCase().replace(/[\s_-]+/g, "") ||
    fullUser?.role?.type?.toLowerCase().replace(/[\s_-]+/g, "") ||
    "";
  user._cachedRole = role;
  return role;
}

/* ---------- CLUB OWNER LOOKUP FOR AUTH USER ---------- */
async function getClubOwnerForUser(user: any) {
  if (!user) return null;
  const userObj = typeof user === "object" ? user : null;
  const userId = userObj ? userObj.id : user;

  if (userObj?._cachedClubOwner) {
    return userObj._cachedClubOwner;
  }

  // 1. Direct query to club-owner by user relation
  let owner: any = null;
  if (userId) {
    owner = await strapi.db.query(CLUB_OWNER_UID).findOne({
      where: { user: userId },
      select: [
        "id",
        "documentId",
        "clubId",
        "clubName",
        "ownerName",
        "phoneNumber",
        "email",
      ],
    });
  }

  // 2. Fallback via user table populate
  if (!owner && userId) {
    const userWithDetail: any = await strapi.db
      .query("plugin::users-permissions.user")
      .findOne({
        where: { id: userId },
        select: ["id"],
        populate: ["club_owner"],
      });

    owner = userWithDetail?.club_owner || null;
  }

  if (userObj && owner) {
    userObj._cachedClubOwner = owner;
  }

  return owner || null;
}

/* ---------- FIND CLUB OWNER BY IDENTIFIER ---------- */
async function findClubOwnerByIdentifier(identifier: string | number) {
  if (!identifier) return null;
  const val = String(identifier).trim();
  const isNumeric = !isNaN(Number(val)) && /^\d+$/.test(val);

  return await strapi.db.query(CLUB_OWNER_UID).findOne({
    where: isNumeric
      ? {
          $or: [{ id: Number(val) }, { documentId: val }, { clubId: val }],
        }
      : {
          $or: [{ documentId: val }, { clubId: val }],
        },
    select: [
      "id",
      "documentId",
      "clubId",
      "clubName",
      "ownerName",
      "phoneNumber",
      "email",
    ],
  });
}

const POPULATE_CONFIG: any = ["club_owner"];

export default factories.createCoreController(
  "api::holdiday.holdiday" as any,
  ({ strapi }) => ({
    /* =======================================================
       1. FIND ALL HOLIDAYS
       - Admin / SuperAdmin can access all holidays across all gyms
       - Club Owner can ONLY see their own gym's holidays
    ======================================================= */
    async find(ctx: Context) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        const isAdmin = roleName === "admin" || roleName === "superadmin";

        const {
          clubOwnerId,
          clubId,
          club_owner,
          date,
          startDate,
          endDate,
          closureType,
          search,
          sort,
        } = ctx.query as any;

        const andClauses: any[] = [];

        // ============================================================
        // SCOPING LOGIC: ADMIN vs CLUB OWNER
        // ============================================================
        if (!isAdmin) {
          // Club Owner: Strictly scoped to their own gym only
          const owner = await getClubOwnerForUser(user);

          if (!owner) {
            return ctx.forbidden(
              "Access denied. Club owner profile not found for this user.",
            );
          }

          andClauses.push({ club_owner: owner.id });
        } else {
          // Admin / SuperAdmin: Can view all, or optionally filter by club
          const targetClubIdentifier = clubOwnerId || clubId || club_owner;

          if (targetClubIdentifier) {
            const targetOwner = await findClubOwnerByIdentifier(
              targetClubIdentifier,
            );

            if (targetOwner) {
              andClauses.push({ club_owner: targetOwner.id });
            } else {
              return ctx.send({
                data: [],
                meta: {
                  total: 0,
                },
              });
            }
          }
        }

        // ============================================================
        // DATE FILTERS
        // ============================================================
        if (date) {
          const targetDate = String(date).trim();
          andClauses.push({
            startDate: { $lte: targetDate },
            $or: [
              { endDate: { $gte: targetDate } },
              { endDate: { $null: true } },
            ],
          });
        } else if (startDate || endDate) {
          if (startDate) {
            andClauses.push({ startDate: { $gte: String(startDate).trim() } });
          }
          if (endDate) {
            andClauses.push({ endDate: { $lte: String(endDate).trim() } });
          }
        }

        // ============================================================
        // CLOSURE TYPE FILTER (full_day / partial_day)
        // ============================================================
        if (closureType) {
          const ct = String(closureType).toLowerCase().trim();
          if (ct === "full_day" || ct === "partial_day") {
            andClauses.push({ closureType: ct });
          }
        }

        // ============================================================
        // KEYWORD SEARCH
        // ============================================================
        if (search && String(search).trim()) {
          const s = String(search).trim();
          andClauses.push({ title: { $containsi: s } });
        }

        const where: any =
          andClauses.length > 1
            ? { $and: andClauses }
            : andClauses.length === 1
            ? andClauses[0]
            : {};

        // ============================================================
        // SORTING
        // ============================================================
        let orderBy: any = { startDate: "desc", id: "desc" };
        if (sort) {
          const parts = String(sort).split(":");
          if (parts.length === 2) {
            orderBy = { [parts[0]]: parts[1].toLowerCase() };
          } else if (parts.length === 1) {
            orderBy = { [parts[0]]: "desc" };
          }
        }

        // Fetch records using db.query
        let holidays: any[] = [];
        try {
          holidays = await strapi.db.query(HOLDIDAY_UID).findMany({
            where,
            populate: POPULATE_CONFIG,
            orderBy,
          });
        } catch (dbErr) {
          strapi.log.warn("db.query findMany fallback in holiday find:", dbErr);
          if ((strapi as any).documents) {
            holidays = await (strapi as any).documents(HOLDIDAY_UID).findMany({
              filters: where,
              populate: POPULATE_CONFIG,
            });
          }
        }

        return ctx.send({
          data: holidays || [],
          meta: {
            total: (holidays || []).length,
          },
        });
      } catch (error) {
        strapi.log.error("FIND HOLIDAYS ERROR:", error);
        return ctx.internalServerError("Failed to fetch holidays");
      }
    },

    /* =======================================================
       2. FIND ONE HOLIDAY BY ID
       - Admin / SuperAdmin can view any holiday
       - Club Owner can ONLY view their own gym's holiday
    ======================================================= */
    async findOne(ctx: Context) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const { id } = ctx.params;
        const identifier = String(id || "").trim();

        if (!identifier) {
          return ctx.badRequest("Holiday ID is required");
        }

        const isNumeric =
          !isNaN(Number(identifier)) && /^\d+$/.test(identifier);

        let holiday: any = null;

        if (isNumeric) {
          holiday = await strapi.db.query(HOLDIDAY_UID).findOne({
            where: { id: Number(identifier) },
            populate: POPULATE_CONFIG,
          });
        }

        if (!holiday) {
          holiday = await strapi.db.query(HOLDIDAY_UID).findOne({
            where: { documentId: identifier },
            populate: POPULATE_CONFIG,
          });
        }

        if (!holiday && (strapi as any).documents) {
          try {
            holiday = await (strapi as any).documents(HOLDIDAY_UID).findOne({
              documentId: identifier,
              populate: POPULATE_CONFIG,
            });
          } catch (docErr) {}
        }

        if (!holiday) {
          return ctx.notFound(`Holiday '${identifier}' not found`);
        }

        const roleName = await getUserRole(user);
        const isAdmin = roleName === "admin" || roleName === "superadmin";

        // If not Admin/SuperAdmin, verify ownership
        if (!isAdmin) {
          const owner = await getClubOwnerForUser(user);

          if (!owner) {
            return ctx.forbidden(
              "Access denied. Club owner profile not found for this user.",
            );
          }

          const holidayClubOwnerId =
            holiday.club_owner?.id ||
            holiday.club_owner?.documentId ||
            holiday.club_owner;

          const isOwnerMatch =
            holidayClubOwnerId &&
            (String(holidayClubOwnerId) === String(owner.id) ||
              (owner.documentId &&
                String(holidayClubOwnerId) === String(owner.documentId)));

          if (!isOwnerMatch) {
            return ctx.forbidden(
              "Access denied. You can only view holidays for your own gym.",
            );
          }
        }

        return ctx.send({
          data: holiday,
        });
      } catch (error) {
        strapi.log.error("FIND ONE HOLIDAY ERROR:", error);
        return ctx.internalServerError("Failed to fetch holiday");
      }
    },

    /* =======================================================
       3. CREATE HOLIDAY
    ======================================================= */
    async create(ctx: Context) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized(
            "Authentication required. Please provide a valid Bearer token.",
          );
        }

        const roleName = await getUserRole(user);
        const isAdmin = roleName === "admin" || roleName === "superadmin";

        if (isAdmin) {
          return ctx.forbidden(
            "Admins cannot create holidays. Only club owners can create holidays for their gym.",
          );
        }

        // Club Owner: Extract club owner from the Bearer token's user
        const targetOwner = await getClubOwnerForUser(user);

        if (!targetOwner) {
          return ctx.forbidden(
            "Access denied. Club owner profile not found for this account. Only registered club owners can create holidays.",
          );
        }

        const body = (ctx.request.body as any) ?? {};
        const data = body.data ?? body;

        if (!data || typeof data !== "object") {
          return ctx.badRequest("Holiday data is required in request body");
        }

        // Validate start date
        const startDate = data.startDate || data.date;
        if (!startDate) {
          return ctx.badRequest("startDate is required (e.g. '2026-10-15')");
        }
        const endDate = data.endDate || startDate;

        // Determine closureType (full_day / partial_day)
        const closureType =
          data.closureType ||
          (data.startTime || data.endtime || data.fromTime || data.toTime
            ? "partial_day"
            : "full_day");

        // Format times if partial day
        const startTime = data.startTime || data.fromTime || null;
        const endtime = data.endtime || data.toTime || null;

        const payload: any = {
          title:
            data.title ||
            (closureType === "full_day"
              ? `Holiday (${startDate})`
              : `Closure (${startDate} ${startTime || ""}-${endtime || ""})`),
          closureType,
          startDate,
          endDate,
          startTime,
          endtime,
          club_owner: targetOwner.documentId || targetOwner.id,
          publishedAt: new Date(),
        };

        let created: any = null;
        if ((strapi as any).documents) {
          try {
            created = await (strapi as any).documents(HOLDIDAY_UID).create({
              data: payload,
              populate: POPULATE_CONFIG,
            });
          } catch (docErr) {
            strapi.log.warn(
              "documents.create fallback in holiday create:",
              docErr,
            );
          }
        }

        if (!created) {
          created = await strapi.entityService.create(HOLDIDAY_UID, {
            data: payload,
            populate: POPULATE_CONFIG,
          });
        }

        return ctx.send({
          data: created,
        });
      } catch (error: any) {
        strapi.log.error("CREATE HOLIDAY ERROR:", error);
        return ctx.internalServerError(
          error.message || "Failed to create holiday",
        );
      }
    },

    /* =======================================================
       4. UPDATE HOLIDAY
       - Club Owner: can only update holidays for their own gym
       - Admin: can update any holiday
    ======================================================= */
    async update(ctx: Context) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const { id } = ctx.params;
        const identifier = String(id || "").trim();

        if (!identifier) {
          return ctx.badRequest("Holiday ID is required");
        }

        const isNumeric =
          !isNaN(Number(identifier)) && /^\d+$/.test(identifier);
        const existing = await strapi.db.query(HOLDIDAY_UID).findOne({
          where: isNumeric
            ? { $or: [{ id: Number(identifier) }, { documentId: identifier }] }
            : { documentId: identifier },
          populate: POPULATE_CONFIG,
        });

        if (!existing) {
          return ctx.notFound(`Holiday '${identifier}' not found`);
        }

        const roleName = await getUserRole(user);
        const isAdmin = roleName === "admin" || roleName === "superadmin";

        if (!isAdmin) {
          const owner = await getClubOwnerForUser(user);

          if (!owner) {
            return ctx.forbidden(
              "Access denied. Club owner profile not found for this user.",
            );
          }

          const existingClubOwnerId =
            existing.club_owner?.id || existing.club_owner;

          if (
            !existingClubOwnerId ||
            Number(existingClubOwnerId) !== Number(owner.id)
          ) {
            return ctx.forbidden(
              "Access denied. You can only update holidays for your own gym.",
            );
          }
        }

        const body = (ctx.request.body as any) ?? {};
        const data = body.data ?? body;

        const updateData: any = { ...data };
        delete updateData.club_owner; // Prevent changing ownership unless admin explicitly handles it

        let updated: any = null;
        if ((strapi as any).documents && existing.documentId) {
          try {
            updated = await (strapi as any).documents(HOLDIDAY_UID).update({
              documentId: existing.documentId,
              data: updateData,
              populate: POPULATE_CONFIG,
            });
          } catch (docErr) {
            strapi.log.warn(
              "documents.update fallback in holiday update:",
              docErr,
            );
          }
        }

        if (!updated) {
          updated = await strapi.entityService.update(
            HOLDIDAY_UID,
            existing.id,
            {
              data: updateData,
              populate: POPULATE_CONFIG,
            },
          );
        }

        return ctx.send({
          success: true,
          message: "Holiday updated successfully",
          data: updated,
        });
      } catch (error: any) {
        strapi.log.error("UPDATE HOLIDAY ERROR:", error);
        return ctx.internalServerError(
          error.message || "Failed to update holiday",
        );
      }
    },

    /* =======================================================
       5. DELETE HOLIDAY
       - Club Owner: can only delete holidays for their own gym
       - Admin: can delete any holiday
    ======================================================= */
    async delete(ctx: Context) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const { id } = ctx.params;
        const identifier = String(id || "").trim();

        if (!identifier) {
          return ctx.badRequest("Holiday ID is required");
        }

        const isNumeric =
          !isNaN(Number(identifier)) && /^\d+$/.test(identifier);
        const existing = await strapi.db.query(HOLDIDAY_UID).findOne({
          where: isNumeric
            ? { $or: [{ id: Number(identifier) }, { documentId: identifier }] }
            : { documentId: identifier },
          populate: POPULATE_CONFIG,
        });

        if (!existing) {
          return ctx.notFound(`Holiday '${identifier}' not found`);
        }

        const roleName = await getUserRole(user);
        const isAdmin = roleName === "admin" || roleName === "superadmin";

        if (!isAdmin) {
          const owner = await getClubOwnerForUser(user);

          if (!owner) {
            return ctx.forbidden(
              "Access denied. Club owner profile not found for this user.",
            );
          }

          const existingClubOwnerId =
            existing.club_owner?.id || existing.club_owner;

          if (
            !existingClubOwnerId ||
            Number(existingClubOwnerId) !== Number(owner.id)
          ) {
            return ctx.forbidden(
              "Access denied. You can only delete holidays for your own gym.",
            );
          }
        }

        if ((strapi as any).documents && existing.documentId) {
          try {
            await (strapi as any).documents(HOLDIDAY_UID).delete({
              documentId: existing.documentId,
            });
          } catch (docErr) {
            await strapi.entityService.delete(HOLDIDAY_UID, existing.id);
          }
        } else {
          await strapi.entityService.delete(HOLDIDAY_UID, existing.id);
        }

        return ctx.send({
          message: "Holiday deleted successfully",
        });
      } catch (error: any) {
        strapi.log.error("DELETE HOLIDAY ERROR:", error);
        return ctx.internalServerError("Failed to delete holiday");
      }
    },
  }),
);
