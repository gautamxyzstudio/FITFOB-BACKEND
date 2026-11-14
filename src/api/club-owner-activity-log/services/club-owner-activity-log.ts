import { factories } from "@strapi/strapi";

export interface LogActivityParams {
  clubOwnerId: string | number | { id?: number; documentId?: string };
  category?: string;
  actionType: string;
  entityName?: string;
  entityId?: string | number;
  description: string;
}

export default factories.createCoreService(
  "api::club-owner-activity-log.club-owner-activity-log",
  ({ strapi }) => ({
    /**
     * Backward-compatible delegation to the unified activity log service
     */
    async logActivity(params: LogActivityParams) {
      try {
        const unifiedService: any = strapi.service("api::activity-log.activity-log");
        if (unifiedService?.createActivityLog) {
          return await unifiedService.createActivityLog({
            actorType: "club_owner",
            actorId: params.clubOwnerId,
            entityName: params.entityName || "Club Owner",
            entityId: params.entityId || "",
            actionType: params.actionType,
            description: params.description,
          });
        }
        return null;
      } catch (error) {
        strapi.log.error("[ClubOwnerActivityLog Service] Failed:", error);
        return null;
      }
    },
  }),
);
