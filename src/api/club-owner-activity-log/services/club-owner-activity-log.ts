import { factories } from "@strapi/strapi";

const ACTIVITY_LOG_UID =
  "api::club-owner-activity-log.club-owner-activity-log" as any;
const CLUB_OWNER_UID = "api::club-owner.club-owner" as any;

export interface LogActivityParams {
  clubOwnerId: string | number | { id?: number; documentId?: string };
  category: "profile" | "membership_plans" | "subscriptions";
  actionType: "CREATE" | "UPDATE" | "DELETE";
  entityName?: string;
  entityId?: string | number;
  description: string;
}

export default factories.createCoreService(
  "api::club-owner-activity-log.club-owner-activity-log",
  ({ strapi }) => ({
    /**
     * Create an activity log entry for a club owner.
     * Safe execution: logs any internal error without throwing, to protect the calling transaction.
     */
    async logActivity(params: LogActivityParams) {
      try {
        const {
          clubOwnerId,
          category,
          actionType,
          entityName,
          entityId,
          description,
        } = params;

        if (!clubOwnerId) {
          strapi.log.warn(
            "[ActivityLog] Missing clubOwnerId for activity log creation.",
          );
          return null;
        }

        let ownerNumericId: number | null = null;
        let ownerDocId: string | null = null;

        if (typeof clubOwnerId === "object" && clubOwnerId !== null) {
          if (clubOwnerId.documentId) ownerDocId = String(clubOwnerId.documentId);
          if (clubOwnerId.id && !isNaN(Number(clubOwnerId.id))) {
            ownerNumericId = Number(clubOwnerId.id);
          }
        } else {
          const rawId = String(clubOwnerId).trim();
          const isNumeric = !isNaN(Number(rawId)) && /^\d+$/.test(rawId);

          if (isNumeric) {
            ownerNumericId = Number(rawId);
          } else {
            ownerDocId = rawId;
          }
        }

        // If we only have one ID type, resolve the other from DB to support all Strapi 5 APIs
        if (!ownerDocId || !ownerNumericId) {
          const whereClause: any = {};
          if (ownerDocId) {
            whereClause.documentId = ownerDocId;
          } else if (ownerNumericId) {
            whereClause.id = ownerNumericId;
          }

          const ownerRecord: any = await strapi.db
            .query(CLUB_OWNER_UID)
            .findOne({
              where: whereClause,
              select: ["id", "documentId"],
            });

          if (ownerRecord) {
            ownerNumericId = ownerRecord.id;
            ownerDocId = ownerRecord.documentId;
          }
        }

        if (!ownerDocId && !ownerNumericId) {
          strapi.log.warn(
            `[ActivityLog] Could not resolve club owner for id: ${JSON.stringify(
              clubOwnerId,
            )}`,
          );
          return null;
        }

        const logData: any = {
          description: description?.trim(),
          category,
          actionType,
          entityName: entityName ? String(entityName).trim() : null,
          entityId: entityId ? String(entityId).trim() : null,
        };

        let created: any = null;

        // Try Strapi 5 Documents API
        if ((strapi as any).documents && ownerDocId) {
          try {
            created = await (strapi as any).documents(ACTIVITY_LOG_UID).create({
              data: {
                ...logData,
                club_owner: ownerDocId,
              },
            });
          } catch (docErr) {
            strapi.log.warn(
              "[ActivityLog] documents.create fallback in logActivity:",
              docErr,
            );
          }
        }

        // Fallback to strapi.db.query / strapi.entityService
        if (!created && ownerNumericId) {
          try {
            created = await strapi.db.query(ACTIVITY_LOG_UID).create({
              data: {
                ...logData,
                club_owner: ownerNumericId,
              },
            });
          } catch (dbErr) {
            strapi.log.error(
              "[ActivityLog] db.query fallback failed in logActivity:",
              dbErr,
            );
          }
        }

        return created;
      } catch (error) {
        strapi.log.error("[ActivityLog] Failed to create activity log:", error);
        return null;
      }
    },
  }),
);
