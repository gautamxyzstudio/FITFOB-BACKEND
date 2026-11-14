type AdminActivityCategory =
  | "club_contract"
  | "club_owner"
  | "club_services"
  | "club_facilities"
  | "global_pricing"
  | string;

type AdminActivityActionType =
  | "create"
  | "update"
  | "delete"
  | "approve"
  | "rejected"
  | string;

export interface LogAdminActivityParams {
  adminUserId?: number | string | null;
  category?: AdminActivityCategory;
  actionType: AdminActivityActionType;
  entityName: string;
  entityId?: number | string | null;
  description: string;
}

export async function logAdminActivity(
  params: LogAdminActivityParams,
): Promise<void> {
  try {
    const {
      adminUserId,
      actionType,
      entityName,
      entityId,
      description,
    } = params;

    if (!actionType || !entityName || !description) {
      strapi.log.warn("[AdminActivityLog] Missing required fields.");
      return;
    }

    const unifiedService: any = strapi.service("api::activity-log.activity-log");
    if (unifiedService?.createActivityLog) {
      await unifiedService.createActivityLog({
        actorType: "admin",
        actorId: adminUserId || 1, // Fallback to 1 if no admin ID is in context
        entityName,
        entityId: entityId !== null && entityId !== undefined ? String(entityId) : "",
        actionType,
        description,
      });
    }
  } catch (error) {
    strapi.log.error("[AdminActivityLog] Failed:", error);
  }
}

export function getAdminActivityUserId(ctx: any): number | null {
  const id = ctx?.state?.user?.id;
  return id ? Number(id) : null;
}
