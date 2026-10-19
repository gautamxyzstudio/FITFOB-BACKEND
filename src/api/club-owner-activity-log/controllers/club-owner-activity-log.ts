import { factories } from "@strapi/strapi";
import { Context } from "koa";

const ACTIVITY_LOG_UID =
  "api::club-owner-activity-log.club-owner-activity-log" as any;
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

/* ---------- CLUB OWNER LOOKUP FOR AUTH USER ---------- */
async function getClubOwnerForUser(user: any) {
  if (!user) return null;
  const userObj = typeof user === "object" ? user : null;
  const userId = userObj ? userObj.id : user;

  if (userObj?._cachedClubOwner) {
    return userObj._cachedClubOwner;
  }

  // 1. Direct query to club-owner by user relation
  let owner: any = await strapi.db.query(CLUB_OWNER_UID).findOne({
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

  // 2. Fallback via user table
  if (!owner) {
    const userWithDetail: any = await strapi.db
      .query("plugin::users-permissions.user")
      .findOne({
        where: { id: userId },
        select: ["id"],
        populate: {
          club_owner: {
            select: [
              "id",
              "documentId",
              "clubId",
              "clubName",
              "ownerName",
              "phoneNumber",
              "email",
            ],
          },
        },
      });

    owner = userWithDetail?.club_owner || null;
  }

  if (userObj && owner) {
    userObj._cachedClubOwner = owner;
  }

  return owner || null;
}

/* ---------- FIND TARGET CLUB OWNER BY IDENTIFIER (DOCUMENTID / CLUBID / ID) ---------- */
async function findClubOwnerByIdentifier(identifier: string) {
  if (!identifier || !String(identifier).trim()) return null;
  const val = String(identifier).trim();
  const isNumeric = !isNaN(Number(val)) && /^\d+$/.test(val);

  // 1. Check numeric ID
  if (isNumeric) {
    const byId = await strapi.db.query(CLUB_OWNER_UID).findOne({
      where: { id: Number(val) },
      select: ["id", "documentId", "clubId", "clubName", "ownerName"],
    });
    if (byId) return byId;
  }

  // 2. Check documentId (Strapi 5 alphanumeric)
  const byDocId = await strapi.db.query(CLUB_OWNER_UID).findOne({
    where: { documentId: val },
    select: ["id", "documentId", "clubId", "clubName", "ownerName"],
  });
  if (byDocId) return byDocId;

  // 3. Check custom clubId (e.g. CLUB-101)
  const byClubId = await strapi.db.query(CLUB_OWNER_UID).findOne({
    where: { clubId: val },
    select: ["id", "documentId", "clubId", "clubName", "ownerName"],
  });
  if (byClubId) return byClubId;

  return null;
}

export default factories.createCoreController(
  "api::club-owner-activity-log.club-owner-activity-log",
  ({ strapi }) => ({
    /* =======================================================
       1. GET MY ACTIVITY LOGS (STRICTLY CLUB OWNER ONLY)
       Route: GET /api/club-owner-activity-logs/me
    ======================================================= */
    
    async getMyLogs(ctx: Context) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        const owner = await getClubOwnerForUser(user);

        if (!owner) {
          return ctx.notFound("Club owner profile not found for this user");
        }

        const {
          category,
          actionType,
          search,
          startDate,
          endDate,
          page = 1,
          pageSize = 20,
        } = ctx.query as any;

        // Strictly scoped to the logged-in owner
        const where: any = {
          club_owner: owner.id,
        };

        // Category filter (e.g. profile, plan, subscription, checkin)
        if (category) {
          where.category = String(category).trim();
        }

        // Action type filter (e.g. CREATE, UPDATE, DELETE, TOGGLE_STATUS)
        if (actionType) {
          where.actionType = String(actionType).trim().toUpperCase();
        }

        // Date range filter
        if (startDate || endDate) {
          where.createdAt = {};
          if (startDate) {
            where.createdAt.$gte = new Date(startDate);
          }
          if (endDate) {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            where.createdAt.$lte = end;
          }
        }

        // Search in description or entityName
        if (search && String(search).trim()) {
          const s = String(search).trim();
          where.$or = [
            { description: { $containsi: s } },
            { entityName: { $containsi: s } },
          ];
        }

        const pageNum = Math.max(1, parseInt(page as any, 10) || 1);
        const limitNum = Math.min(
          100,
          Math.max(1, parseInt(pageSize as any, 10) || 20),
        );
        const offset = (pageNum - 1) * limitNum;

        const [logs, total] = await Promise.all([
          strapi.db.query(ACTIVITY_LOG_UID).findMany({
            where,
            orderBy: { createdAt: "desc" },
            offset,
            limit: limitNum,
            populate: {
              club_owner: {
                select: ["id", "documentId", "clubId", "clubName", "ownerName"],
              },
            },
          }),
          strapi.db.query(ACTIVITY_LOG_UID).count({
            where,
          }),
        ]);

        return ctx.send({
          data: logs,
          meta: {
            pagination: {
              page: pageNum,
              pageSize: limitNum,
              pageCount: Math.ceil(total / limitNum) || 1,
              total,
            },
          },
        });
      } catch (error) {
        strapi.log.error("GET MY ACTIVITY LOGS ERROR:", error);
        return ctx.internalServerError("Failed to fetch activity logs");
      }
    },

    async find(ctx: Context) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);

        // Strictly for Admin & SuperAdmin
        if (roleName !== "admin" && roleName !== "superadmin") {
          return ctx.forbidden(
            "Access denied. Only Admin and SuperAdmin can access this endpoint.",
          );
        }

        const { documentId, ownerDocumentId } = (ctx.query as any) || {};
        const paramDocId = (ctx.params as any)?.documentId || (ctx.params as any)?.id;

        const targetDocumentId = documentId || ownerDocumentId || paramDocId;

        if (!targetDocumentId || !String(targetDocumentId).trim()) {
          return ctx.badRequest("Please provide owner documentId");
        }

        const docId = String(targetDocumentId).trim();

        // 1. Fetch club owner details directly via PostgreSQL
        const ownerRes = await strapi.db.connection.raw(
          `SELECT id, document_id, club_id, club_name, owner_name 
           FROM club_owners 
           WHERE document_id = ? 
           LIMIT 1`,
          [docId],
        );

        const owner = ownerRes?.rows?.[0];
        if (!owner) {
          return ctx.notFound(
            `Club owner with documentId '${docId}' not found`,
          );
        }

        // 2. Fetch all activity logs of that club owner in DESC order directly via PostgreSQL
        const logsRes = await strapi.db.connection.raw(
          `SELECT 
            al.created_at AS "createdAt",
            al.description,
            al.entity_name AS "entityName",
            al.action_type AS "actionType"
          FROM club_owner_activity_logs al
          JOIN club_owner_activity_logs_club_owner_lnk lnk ON lnk.club_owner_activity_log_id = al.id
          WHERE lnk.club_owner_id = ?
          ORDER BY al.created_at DESC`,
          [owner.id],
        );

        const rawLogs = logsRes?.rows || [];

        const data = rawLogs.map((row: any) => ({
          createdAt: row.createdAt,
          description: row.description,
          entityName: row.entityName,
          actionType: row.actionType,
          clubOwnerDocumentId: owner.document_id,
        }));

        return ctx.send(data);
      } catch (error) {
        strapi.log.error("FIND ACTIVITY LOGS ERROR:", error);
        return ctx.internalServerError("Failed to fetch activity logs");
      }
    },

  }),
);
