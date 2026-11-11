
type AdminActivityCategory =
  | "club_contract"
  | "club_owner"
  | "club_services"
  | "club_facilities"
  | "global_pricing";

type AdminActivityActionType =
  | "create"
  | "update"
  | "delete"
  | "approved"
  | "rejected";

interface LogAdminActivityParams {
  adminUserId?: number | string | null;
  category: AdminActivityCategory;
  actionType: AdminActivityActionType;
  entityName: string;
  entityId?: number | string | null;
  description: string;
}

const ADMIN_ACTIVITY_LOG_UID =
  "api::admin-activity-log.admin-activity-log";

export async function logAdminActivity(
  params: LogAdminActivityParams
): Promise<void> {
  try {
    const {
      adminUserId,
      category,
      actionType,
      entityName,
      entityId,
      description,
    } = params;

    if (!category || !actionType || !entityName || !description) {
      strapi.log.warn("[AdminActivityLog] Missing required fields.");
      return;
    }

    const data: Record<string, any> = {
      category,
      actionType,
      entityName: entityName.trim(),
      entityId:
        entityId !== null && entityId !== undefined
          ? String(entityId)
          : null,
      description: description.trim(),
    };

    if (adminUserId !== null && adminUserId !== undefined) {
      const userId = Number(adminUserId);

      if (!Number.isInteger(userId) || userId <= 0) {
        throw new Error("Invalid admin user ID.");
      }

      data.users_permissions_user = userId;
    }

    await strapi.db.query(ADMIN_ACTIVITY_LOG_UID).create({
      data,
    });
  } catch (error) {
    strapi.log.error("[AdminActivityLog] Failed:", error);
  }
}

export function getAdminActivityUserId(ctx: any): number | null {
  const id = ctx?.state?.user?.id;
  return id ? Number(id) : null;
}
