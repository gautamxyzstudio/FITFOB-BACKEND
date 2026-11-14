import { factories } from "@strapi/strapi";

const ACTIVITY_LOG_UID = "api::activity-log.activity-log" as any;
const CLUB_OWNER_UID = "api::club-owner.club-owner" as any;
const CLIENT_DETAIL_UID = "api::client-detail.client-detail" as any;
const USER_UID = "plugin::users-permissions.user" as any;

export type ActorType = "admin" | "club_owner" | "client";

export type ActionType =
  | "create"
  | "update"
  | "delete"
  | "approve"
  | "rejected"
  | "checkin"
  | "buyMembership";

export interface CreateActivityLogParams {
  actorType: ActorType;
  actorId: string | number | { id?: number; documentId?: string };
  entityName: string;
  entityId: string | number;
  actionType: ActionType | string;
  description: string;
}

export interface ActivityLogQueryParams {
  page?: number | string;
  pageSize?: number | string;
  actionType?: string;
  search?: string;
  startDate?: string;
  endDate?: string;
}

// In-memory debounce cache to prevent duplicate activity creations within 3 seconds
const recentLogsCache = new Map<string, number>();
const CACHE_TTL_MS = 3000;

function cleanupCache() {
  const now = Date.now();
  for (const [key, timestamp] of recentLogsCache.entries()) {
    if (now - timestamp > CACHE_TTL_MS) {
      recentLogsCache.delete(key);
    }
  }
}

// Action type normalizer
export function normalizeActionType(action: string): ActionType {
  if (!action) return "update";
  const a = String(action).trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (a === "create") return "create";
  if (a === "update") return "update";
  if (a === "delete") return "delete";
  if (a === "approve") return "approve";
  if (a === "rejected" || a === "reject") return "rejected";
  if (a === "checkin" || a === "check-in") return "checkin";
  if (a === "buymembership" || a === "buy-membership" || a === "buy_membership")
    return "buyMembership";

  // Fallback to update if unknown
  return "update";
}

// Helper: resolve user (Admin)
async function resolveAdminUser(identifier: any) {
  if (!identifier) return null;
  let numericId: number | null = null;
  let docId: string | null = null;

  if (typeof identifier === "object") {
    if (identifier.documentId) docId = String(identifier.documentId);
    if (identifier.id && !isNaN(Number(identifier.id)))
      numericId = Number(identifier.id);
  } else {
    const raw = String(identifier).trim();
    if (/^\d+$/.test(raw)) {
      numericId = Number(raw);
    } else {
      docId = raw;
    }
  }

  if (numericId && docId) return { id: numericId, documentId: docId };

  const whereClause: any = {};
  if (docId) whereClause.documentId = docId;
  else if (numericId) whereClause.id = numericId;

  const record: any = await strapi.db.query(USER_UID).findOne({
    where: whereClause,
    select: ["id", "documentId", "username", "email"],
  });

  if (record) {
    return {
      id: record.id,
      documentId: record.documentId,
      username: record.username,
      email: record.email,
    };
  }
  return null;
}

// Helper: resolve club owner
async function resolveClubOwner(identifier: any) {
  if (!identifier) return null;
  let numericId: number | null = null;
  let docId: string | null = null;
  let customClubId: string | null = null;

  if (typeof identifier === "object") {
    if (identifier.documentId) docId = String(identifier.documentId);
    if (identifier.id && !isNaN(Number(identifier.id)))
      numericId = Number(identifier.id);
    if (identifier.clubId) customClubId = String(identifier.clubId);
  } else {
    const raw = String(identifier).trim();
    if (/^\d+$/.test(raw)) {
      numericId = Number(raw);
    } else {
      docId = raw;
      customClubId = raw;
    }
  }

  // Look up in database
  let record: any = null;
  if (numericId) {
    record = await strapi.db.query(CLUB_OWNER_UID).findOne({
      where: { id: numericId },
      select: ["id", "documentId", "clubId", "clubName", "ownerName"],
    });
  }
  if (!record && docId) {
    record = await strapi.db.query(CLUB_OWNER_UID).findOne({
      where: { documentId: docId },
      select: ["id", "documentId", "clubId", "clubName", "ownerName"],
    });
  }
  if (!record && customClubId) {
    record = await strapi.db.query(CLUB_OWNER_UID).findOne({
      where: { clubId: customClubId },
      select: ["id", "documentId", "clubId", "clubName", "ownerName"],
    });
  }

  return record || null;
}

// Helper: resolve client detail
async function resolveClientDetail(identifier: any) {
  if (!identifier) return null;
  let numericId: number | null = null;
  let docId: string | null = null;
  let customClientId: string | null = null;

  if (typeof identifier === "object") {
    if (identifier.documentId) docId = String(identifier.documentId);
    if (identifier.id && !isNaN(Number(identifier.id)))
      numericId = Number(identifier.id);
    if (identifier.clientId) customClientId = String(identifier.clientId);
  } else {
    const raw = String(identifier).trim();
    if (/^\d+$/.test(raw)) {
      numericId = Number(raw);
    } else {
      docId = raw;
      customClientId = raw;
    }
  }

  let record: any = null;
  if (numericId) {
    record = await strapi.db.query(CLIENT_DETAIL_UID).findOne({
      where: { id: numericId },
      select: ["id", "documentId", "clientId", "name", "email"],
    });
  }
  if (!record && docId) {
    record = await strapi.db.query(CLIENT_DETAIL_UID).findOne({
      where: { documentId: docId },
      select: ["id", "documentId", "clientId", "name", "email"],
    });
  }
  if (!record && customClientId) {
    record = await strapi.db.query(CLIENT_DETAIL_UID).findOne({
      where: { clientId: customClientId },
      select: ["id", "documentId", "clientId", "name", "email"],
    });
  }

  return record || null;
}

export default factories.createCoreService(
  "api::activity-log.activity-log",
  ({ strapi }) => ({
    /**
     * Create an activity log entry.
     * Guaranteed safe execution: never throws or crashes primary business operations.
     */
    async createActivityLog(params: CreateActivityLogParams) {
      try {
        const {
          actorType,
          actorId,
          entityName,
          entityId,
          actionType,
          description,
        } = params;

        if (!actorType || !actorId) {
          strapi.log.warn(
            "[UnifiedActivityLog] Missing actorType or actorId for activity log.",
          );
          return null;
        }

        const normalizedAction = normalizeActionType(actionType);
        const normEntityName = String(entityName || "General").trim();
        const normEntityId =
          entityId !== null && entityId !== undefined
            ? String(entityId).trim()
            : "";
        const normDescription = String(description || "").trim();

        // Check deduplication
        cleanupCache();
        const actorKey =
          typeof actorId === "object"
            ? (actorId as any).documentId || (actorId as any).id
            : String(actorId);
        const dedupeKey = `${actorType}:${actorKey}:${normEntityName}:${normEntityId}:${normalizedAction}:${normDescription}`;

        const lastLogged = recentLogsCache.get(dedupeKey);
        if (lastLogged && Date.now() - lastLogged < CACHE_TTL_MS) {
          strapi.log.debug(
            `[UnifiedActivityLog] Debounced duplicate activity log: ${dedupeKey}`,
          );
          return null;
        }

        let userNumericId: number | null = null;
        let userDocId: string | null = null;
        let clubOwnerNumericId: number | null = null;
        let clubOwnerDocId: string | null = null;
        let clientNumericId: number | null = null;
        let clientDocId: string | null = null;

        if (actorType === "admin") {
          const resolved = await resolveAdminUser(actorId);
          if (resolved) {
            userNumericId = resolved.id;
            userDocId = resolved.documentId;
          }
        } else if (actorType === "club_owner") {
          const resolved = await resolveClubOwner(actorId);
          if (resolved) {
            clubOwnerNumericId = resolved.id;
            clubOwnerDocId = resolved.documentId;
          }
        } else if (actorType === "client") {
          const resolved = await resolveClientDetail(actorId);
          if (resolved) {
            clientNumericId = resolved.id;
            clientDocId = resolved.documentId;
          }
        }

        let created: any = null;

        // Try Strapi 5 Documents API
        if ((strapi as any).documents) {
          try {
            const dataToCreate: any = {
              entityName: normEntityName,
              entityId: normEntityId,
              actionType: normalizedAction,
              description: normDescription,
            };

            if (actorType === "admin" && userDocId) {
              dataToCreate.users_permissions_user = userDocId;
            } else if (actorType === "club_owner" && clubOwnerDocId) {
              dataToCreate.club_owner = clubOwnerDocId;
            } else if (actorType === "client" && clientDocId) {
              dataToCreate.client_detail = clientDocId;
            }

            created = await (strapi as any)
              .documents(ACTIVITY_LOG_UID)
              .create({
                data: dataToCreate,
              });
          } catch (docErr) {
            strapi.log.warn(
              "[UnifiedActivityLog] documents.create failed, falling back to db.query:",
              docErr,
            );
          }
        }

        // Fallback to strapi.db.query if documents.create was not available or failed
        if (!created) {
          const fallbackData: any = {
            entityName: normEntityName,
            entityId: normEntityId,
            actionType: normalizedAction,
            description: normDescription,
          };

          if (actorType === "admin" && userNumericId) {
            fallbackData.users_permissions_user = userNumericId;
          } else if (actorType === "club_owner" && clubOwnerNumericId) {
            fallbackData.club_owner = clubOwnerNumericId;
          } else if (actorType === "client" && clientNumericId) {
            fallbackData.client_detail = clientNumericId;
          }

          created = await strapi.db.query(ACTIVITY_LOG_UID).create({
            data: fallbackData,
          });
        }

        recentLogsCache.set(dedupeKey, Date.now());
        return created;
      } catch (error) {
        strapi.log.error(
          "[UnifiedActivityLog] Failed to create activity log:",
          error,
        );
        return null;
      }
    },

    /**
     * Get Club Owner Activity Timeline (both actions by club owner AND actions affecting club owner)
     */
    async getClubOwnerTimeline(
      identifier: string | number,
      queryParams: ActivityLogQueryParams = {},
    ) {
      const owner = await resolveClubOwner(identifier);
      if (!owner) {
        return null;
      }

      const {
        page = 1,
        pageSize = 20,
        actionType,
        search,
        startDate,
        endDate,
      } = queryParams;

      const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
      const limitNum = Math.min(100, Math.max(1, parseInt(String(pageSize), 10) || 20));
      const offset = (pageNum - 1) * limitNum;

      // Also gather gym contract IDs for this club owner
      const contractRecords: any[] = await strapi.db.connection("gym_contracts as gc")
        .join("gym_contracts_club_owner_lnk as lnk", "lnk.gym_contract_id", "gc.id")
        .where("lnk.club_owner_id", owner.id)
        .select("gc.document_id", "gc.id");

      const contractDocIds = contractRecords.map((r) => r.document_id).filter(Boolean);
      const contractNumIds = contractRecords.map((r) => String(r.id)).filter(Boolean);

      // Gather linked user ID if any
      const userLinkRecord: any = await strapi.db.connection("up_users_club_owner_lnk")
        .where("club_owner_id", owner.id)
        .select("user_id")
        .first();
      const linkedUserId = userLinkRecord?.user_id ? String(userLinkRecord.user_id) : null;

      const targetEntityIds = [
        owner.documentId,
        String(owner.id),
        owner.clubId,
        linkedUserId,
        ...contractDocIds,
        ...contractNumIds,
      ].filter(Boolean);

      // Knex query builder on activity_logs
      const baseQuery = strapi.db.connection("activity_logs as al")
        .leftJoin(
          "activity_logs_club_owner_lnk as co_lnk",
          "co_lnk.activity_log_id",
          "al.id",
        )
        .leftJoin(
          "activity_logs_users_permissions_user_lnk as u_lnk",
          "u_lnk.activity_log_id",
          "al.id",
        )
        .leftJoin("up_users as u", "u.id", "u_lnk.user_id")
        .leftJoin(
          "activity_logs_client_detail_lnk as cd_lnk",
          "cd_lnk.activity_log_id",
          "al.id",
        )
        .leftJoin("client_details as cd", "cd.id", "cd_lnk.client_detail_id")
        .leftJoin("club_owners as co", "co.id", "co_lnk.club_owner_id")
        .where((builder: any) => {
          // Condition 1: Performed by club owner
          builder.where("co_lnk.club_owner_id", owner.id);

          // Condition 2: Performed on club owner (e.g. by admin)
          builder.orWhere((subBuilder: any) => {
            subBuilder.whereIn("al.entity_id", targetEntityIds);
            subBuilder.whereIn(
              strapi.db.connection.raw("LOWER(al.entity_name)"),
              [
                "club-owner",
                "club_owner",
                "club owner",
                "club profile",
                "gym contract",
                "gym-contract",
                "gym_contract",
                "club owner verification",
              ],
            );
          });
        });

      // Filters
      if (actionType && String(actionType).trim() && String(actionType).toUpperCase() !== "ALL") {
        const normAction = normalizeActionType(String(actionType).trim());
        baseQuery.andWhere("al.action_type", normAction);
      }

      if (search && String(search).trim()) {
        const s = `%${String(search).trim()}%`;
        baseQuery.andWhere((builder: any) => {
          builder
            .whereILike("al.description", s)
            .orWhereILike("al.entity_name", s);
        });
      }

      if (startDate) {
        baseQuery.andWhere("al.created_at", ">=", new Date(startDate));
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        baseQuery.andWhere("al.created_at", "<=", end);
      }

      // Count query
      const countRes = await baseQuery
        .clone()
        .clearSelect()
        .countDistinct("al.id as total")
        .first();
      const total = parseInt(String(countRes?.total || 0), 10);

      // Data query
      const rows = await baseQuery
        .clone()
        .distinct(
          "al.id",
          "al.document_id as documentId",
          "al.entity_name as entityName",
          "al.entity_id as entityId",
          "al.action_type as actionType",
          "al.description as description",
          "al.created_at as createdAt",
          "co_lnk.club_owner_id",
          "u_lnk.user_id as admin_user_id",
          "cd_lnk.client_detail_id",
          "u.username as admin_username",
          "co.club_name as owner_club_name",
          "co.owner_name as owner_name",
          "cd.name as client_name",
        )
        .orderBy("al.created_at", "desc")
        .offset(offset)
        .limit(limitNum);

      const data = rows.map((row: any) => {
        let actorType: ActorType = "club_owner";
        let actorRole = "Club Owner";
        let actorName = row.owner_club_name || row.owner_name || "Club Owner";

        if (row.admin_user_id) {
          actorType = "admin";
          actorRole = "Admin";
          actorName = row.admin_username || "Admin";
        } else if (row.client_detail_id) {
          actorType = "client";
          actorRole = "Client";
          actorName = row.client_name || "Client";
        }

        return {
          id: row.id,
          documentId: row.documentId,
          actorType,
          actorName,
          actorRole,
          entityName: row.entityName,
          entityId: row.entityId,
          actionType: row.actionType,
          description: row.description,
          createdAt: row.createdAt,
          clubOwnerDocumentId: owner.documentId,
        };
      });

      return {
        data,
        meta: {
          pagination: {
            page: pageNum,
            pageSize: limitNum,
            pageCount: Math.ceil(total / limitNum) || 1,
            total,
          },
        },
      };
    },

    /**
     * Get Client Activity Timeline (both actions by client AND actions affecting client)
     */
    async getClientTimeline(
      identifier: string | number,
      queryParams: ActivityLogQueryParams = {},
    ) {
      const client = await resolveClientDetail(identifier);
      if (!client) {
        return null;
      }

      const {
        page = 1,
        pageSize = 20,
        actionType,
        search,
        startDate,
        endDate,
      } = queryParams;

      const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
      const limitNum = Math.min(100, Math.max(1, parseInt(String(pageSize), 10) || 20));
      const offset = (pageNum - 1) * limitNum;

      // Gather gym membership IDs for this client
      const membershipRecords: any[] = await strapi.db.connection("gym_memberships as gm")
        .join(
          "gym_memberships_client_detail_lnk as lnk",
          "lnk.gym_membership_id",
          "gm.id",
        )
        .where("lnk.client_detail_id", client.id)
        .select("gm.document_id", "gm.id");

      const membershipDocIds = membershipRecords.map((r) => r.document_id).filter(Boolean);
      const membershipNumIds = membershipRecords.map((r) => String(r.id)).filter(Boolean);

      // Gather linked user ID if any
      const userLinkRecord: any = await strapi.db.connection("up_users_client_detail_lnk")
        .where("client_detail_id", client.id)
        .select("user_id")
        .first();
      const linkedUserId = userLinkRecord?.user_id ? String(userLinkRecord.user_id) : null;

      const targetEntityIds = [
        client.documentId,
        String(client.id),
        client.clientId,
        linkedUserId,
        ...membershipDocIds,
        ...membershipNumIds,
      ].filter(Boolean);

      const baseQuery = strapi.db.connection("activity_logs as al")
        .leftJoin(
          "activity_logs_client_detail_lnk as cd_lnk",
          "cd_lnk.activity_log_id",
          "al.id",
        )
        .leftJoin(
          "activity_logs_users_permissions_user_lnk as u_lnk",
          "u_lnk.activity_log_id",
          "al.id",
        )
        .leftJoin("up_users as u", "u.id", "u_lnk.user_id")
        .leftJoin(
          "activity_logs_club_owner_lnk as co_lnk",
          "co_lnk.activity_log_id",
          "al.id",
        )
        .leftJoin("club_owners as co", "co.id", "co_lnk.club_owner_id")
        .leftJoin("client_details as cd", "cd.id", "cd_lnk.client_detail_id")
        .where((builder: any) => {
          // Condition 1: Performed by client
          builder.where("cd_lnk.client_detail_id", client.id);

          // Condition 2: Performed on client (e.g. by admin or club owner)
          builder.orWhere((subBuilder: any) => {
            subBuilder.whereIn("al.entity_id", targetEntityIds);
            subBuilder.whereIn(
              strapi.db.connection.raw("LOWER(al.entity_name)"),
              [
                "client-detail",
                "client_detail",
                "client detail",
                "client",
                "client checkin",
                "client-checkin",
                "gym-membership",
                "gym membership",
                "local subscription",
                "local-subscription",
              ],
            );
          });
        });

      if (actionType && String(actionType).trim() && String(actionType).toUpperCase() !== "ALL") {
        const normAction = normalizeActionType(String(actionType).trim());
        baseQuery.andWhere("al.action_type", normAction);
      }

      if (search && String(search).trim()) {
        const s = `%${String(search).trim()}%`;
        baseQuery.andWhere((builder: any) => {
          builder
            .whereILike("al.description", s)
            .orWhereILike("al.entity_name", s);
        });
      }

      if (startDate) {
        baseQuery.andWhere("al.created_at", ">=", new Date(startDate));
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        baseQuery.andWhere("al.created_at", "<=", end);
      }

      const countRes = await baseQuery
        .clone()
        .clearSelect()
        .countDistinct("al.id as total")
        .first();
      const total = parseInt(String(countRes?.total || 0), 10);

      const rows = await baseQuery
        .clone()
        .distinct(
          "al.id",
          "al.document_id as documentId",
          "al.entity_name as entityName",
          "al.entity_id as entityId",
          "al.action_type as actionType",
          "al.description as description",
          "al.created_at as createdAt",
          "cd_lnk.client_detail_id",
          "u_lnk.user_id as admin_user_id",
          "co_lnk.club_owner_id",
          "u.username as admin_username",
          "cd.name as client_name",
          "co.club_name as owner_club_name",
          "co.owner_name as owner_name",
        )
        .orderBy("al.created_at", "desc")
        .offset(offset)
        .limit(limitNum);

      const data = rows.map((row: any) => {
        let actorType: ActorType = "client";
        let actorRole = "Client";
        let actorName = row.client_name || "Client";

        if (row.admin_user_id) {
          actorType = "admin";
          actorRole = "Admin";
          actorName = row.admin_username || "Admin";
        } else if (row.club_owner_id) {
          actorType = "club_owner";
          actorRole = "Club Owner";
          actorName = row.owner_club_name || row.owner_name || "Club Owner";
        }

        return {
          id: row.id,
          documentId: row.documentId,
          actorType,
          actorName,
          actorRole,
          entityName: row.entityName,
          entityId: row.entityId,
          actionType: row.actionType,
          description: row.description,
          createdAt: row.createdAt,
          clientDocumentId: client.documentId,
        };
      });

      return {
        data,
        meta: {
          pagination: {
            page: pageNum,
            pageSize: limitNum,
            pageCount: Math.ceil(total / limitNum) || 1,
            total,
          },
        },
      };
    },

    /**
     * Get Admin Activity Timeline
     */
    async getAdminTimeline(queryParams: ActivityLogQueryParams & { adminUserId?: number | string; all?: boolean } = {}) {
      const {
        page = 1,
        pageSize = 20,
        actionType,
        search,
        startDate,
        endDate,
        adminUserId,
        all = false,
      } = queryParams;

      const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
      const limitNum = Math.min(100, Math.max(1, parseInt(String(pageSize), 10) || 20));
      const offset = (pageNum - 1) * limitNum;

      const baseQuery = strapi.db.connection("activity_logs as al")
        .leftJoin(
          "activity_logs_users_permissions_user_lnk as u_lnk",
          "u_lnk.activity_log_id",
          "al.id",
        )
        .leftJoin("up_users as u", "u.id", "u_lnk.user_id")
        .leftJoin(
          "activity_logs_club_owner_lnk as co_lnk",
          "co_lnk.activity_log_id",
          "al.id",
        )
        .leftJoin("club_owners as co", "co.id", "co_lnk.club_owner_id")
        .leftJoin(
          "activity_logs_client_detail_lnk as cd_lnk",
          "cd_lnk.activity_log_id",
          "al.id",
        )
        .leftJoin("client_details as cd", "cd.id", "cd_lnk.client_detail_id");

      if (adminUserId) {
        const resolved = await resolveAdminUser(adminUserId);
        if (resolved) {
          baseQuery.where("u_lnk.user_id", resolved.id);
        }
      } else if (!all) {
        // By default, admin timeline shows actions performed by admin users
        baseQuery.whereNotNull("u_lnk.user_id");
      }

      if (actionType && String(actionType).trim() && String(actionType).toUpperCase() !== "ALL") {
        const normAction = normalizeActionType(String(actionType).trim());
        baseQuery.andWhere("al.action_type", normAction);
      }

      if (search && String(search).trim()) {
        const s = `%${String(search).trim()}%`;
        baseQuery.andWhere((builder: any) => {
          builder
            .whereILike("al.description", s)
            .orWhereILike("al.entity_name", s);
        });
      }

      if (startDate) {
        baseQuery.andWhere("al.created_at", ">=", new Date(startDate));
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        baseQuery.andWhere("al.created_at", "<=", end);
      }

      const countRes = await baseQuery
        .clone()
        .clearSelect()
        .countDistinct("al.id as total")
        .first();
      const total = parseInt(String(countRes?.total || 0), 10);

      const rows = await baseQuery
        .clone()
        .distinct(
          "al.id",
          "al.document_id as documentId",
          "al.entity_name as entityName",
          "al.entity_id as entityId",
          "al.action_type as actionType",
          "al.description as description",
          "al.created_at as createdAt",
          "u_lnk.user_id as admin_user_id",
          "co_lnk.club_owner_id",
          "cd_lnk.client_detail_id",
          "u.username as admin_username",
          "co.club_name as owner_club_name",
          "co.owner_name as owner_name",
          "cd.name as client_name",
        )
        .orderBy("al.created_at", "desc")
        .offset(offset)
        .limit(limitNum);

      const data = rows.map((row: any) => {
        let actorType: ActorType = "admin";
        let actorRole = "Admin";
        let actorName = row.admin_username || "Admin";

        if (row.admin_user_id) {
          actorType = "admin";
          actorRole = "Admin";
          actorName = row.admin_username || "Admin";
        } else if (row.club_owner_id) {
          actorType = "club_owner";
          actorRole = "Club Owner";
          actorName = row.owner_club_name || row.owner_name || "Club Owner";
        } else if (row.client_detail_id) {
          actorType = "client";
          actorRole = "Client";
          actorName = row.client_name || "Client";
        }

        return {
          id: row.id,
          documentId: row.documentId,
          actorType,
          actorName,
          actorRole,
          entityName: row.entityName,
          entityId: row.entityId,
          actionType: row.actionType,
          description: row.description,
          createdAt: row.createdAt,
        };
      });

      return {
        data,
        meta: {
          pagination: {
            page: pageNum,
            pageSize: limitNum,
            pageCount: Math.ceil(total / limitNum) || 1,
            total,
          },
        },
      };
    },

    /**
     * Get Entity Activity Timeline (activities for a specific entityName and entityId)
     */
    async getEntityTimeline(
      entityName: string,
      entityId: string,
      queryParams: ActivityLogQueryParams = {},
    ) {
      const { page = 1, pageSize = 20, actionType } = queryParams;

      const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
      const limitNum = Math.min(100, Math.max(1, parseInt(String(pageSize), 10) || 20));
      const offset = (pageNum - 1) * limitNum;

      const baseQuery = strapi.db.connection("activity_logs as al")
        .leftJoin(
          "activity_logs_users_permissions_user_lnk as u_lnk",
          "u_lnk.activity_log_id",
          "al.id",
        )
        .leftJoin("up_users as u", "u.id", "u_lnk.user_id")
        .leftJoin(
          "activity_logs_club_owner_lnk as co_lnk",
          "co_lnk.activity_log_id",
          "al.id",
        )
        .leftJoin("club_owners as co", "co.id", "co_lnk.club_owner_id")
        .leftJoin(
          "activity_logs_client_detail_lnk as cd_lnk",
          "cd_lnk.activity_log_id",
          "al.id",
        )
        .leftJoin("client_details as cd", "cd.id", "cd_lnk.client_detail_id")
        .whereILike("al.entity_name", entityName.trim())
        .andWhere("al.entity_id", String(entityId).trim());

      if (actionType && String(actionType).trim() && String(actionType).toUpperCase() !== "ALL") {
        const normAction = normalizeActionType(String(actionType).trim());
        baseQuery.andWhere("al.action_type", normAction);
      }

      const countRes = await baseQuery
        .clone()
        .clearSelect()
        .countDistinct("al.id as total")
        .first();
      const total = parseInt(String(countRes?.total || 0), 10);

      const rows = await baseQuery
        .clone()
        .distinct(
          "al.id",
          "al.document_id as documentId",
          "al.entity_name as entityName",
          "al.entity_id as entityId",
          "al.action_type as actionType",
          "al.description as description",
          "al.created_at as createdAt",
          "u_lnk.user_id as admin_user_id",
          "co_lnk.club_owner_id",
          "cd_lnk.client_detail_id",
          "u.username as admin_username",
          "co.club_name as owner_club_name",
          "co.owner_name as owner_name",
          "cd.name as client_name",
        )
        .orderBy("al.created_at", "desc")
        .offset(offset)
        .limit(limitNum);

      const data = rows.map((row: any) => {
        let actorType: ActorType = "admin";
        let actorRole = "Admin";
        let actorName = row.admin_username || "Admin";

        if (row.admin_user_id) {
          actorType = "admin";
          actorRole = "Admin";
          actorName = row.admin_username || "Admin";
        } else if (row.club_owner_id) {
          actorType = "club_owner";
          actorRole = "Club Owner";
          actorName = row.owner_club_name || row.owner_name || "Club Owner";
        } else if (row.client_detail_id) {
          actorType = "client";
          actorRole = "Client";
          actorName = row.client_name || "Client";
        }

        return {
          id: row.id,
          documentId: row.documentId,
          actorType,
          actorName,
          actorRole,
          entityName: row.entityName,
          entityId: row.entityId,
          actionType: row.actionType,
          description: row.description,
          createdAt: row.createdAt,
        };
      });

      return {
        data,
        meta: {
          pagination: {
            page: pageNum,
            pageSize: limitNum,
            pageCount: Math.ceil(total / limitNum) || 1,
            total,
          },
        },
      };
    },
  }),
);
