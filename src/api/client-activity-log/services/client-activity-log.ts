import { factories } from "@strapi/strapi";

export interface LogClientActivityParams {
  clientId: string | number | { id?: number; documentId?: string };
  actionType: string;
  entityName?: string;
  entityId?: string | number;
  description: string;
}

export default factories.createCoreService(
  "api::client-activity-log.client-activity-log",
  ({ strapi }) => ({
    /**
     * Backward-compatible delegation to the unified activity log service
     */
    async logActivity(params: LogClientActivityParams) {
      try {
        const unifiedService: any = strapi.service("api::activity-log.activity-log");
        if (unifiedService?.createActivityLog) {
          return await unifiedService.createActivityLog({
            actorType: "client",
            actorId: params.clientId,
            entityName: params.entityName || "Client Activity",
            entityId: params.entityId || "",
            actionType: params.actionType,
            description: params.description,
          });
        }
        return null;
      } catch (err) {
        strapi.log.error("[ClientActivityLog Service] Failed:", err);
        return null;
      }
    },
  }),
);
