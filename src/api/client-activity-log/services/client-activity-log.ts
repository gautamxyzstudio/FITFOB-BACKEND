import { factories } from "@strapi/strapi";

const CLIENT_ACTIVITY_LOG_UID =
  "api::client-activity-log.client-activity-log" as any;

export interface LogClientActivityParams {
  clientId: string | number | { id?: number; documentId?: string };
  actionType: "buy-membership" | "checkin" | string;
  entityName?: string;
  entityId?: string | number;
  description: string;
}

export default factories.createCoreService(
  "api::client-activity-log.client-activity-log",
  ({ strapi }) => ({
    async logActivity(params: LogClientActivityParams) {
      try {
        const { clientId, actionType, entityName, entityId, description } =
          params;

        if (!clientId) {
          strapi.log.warn(
            "[ClientActivityLog] Missing clientId for activity log.",
          );
          return null;
        }

        let targetClientId: any = clientId;
        if (typeof clientId === "object" && clientId !== null) {
          targetClientId = (clientId as any).id || (clientId as any).documentId;
        }

        return await strapi.entityService.create(CLIENT_ACTIVITY_LOG_UID, {
          data: {
            client_detail: targetClientId,
            actionType,
            entityName: entityName || "Client Activity",
            entityId: entityId ? String(entityId) : null,
            description,
          },
        });
      } catch (err) {
        strapi.log.error(
          "[ClientActivityLog] Failed to log client activity:",
          err,
        );
        return null;
      }
    },
  }),
);
