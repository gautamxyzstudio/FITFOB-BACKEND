const LOCAL_PLAN_UID =
  "api::local-membership-plan.local-membership-plan" as any;
const OUTDOOR_PLAN_UID =
  "api::outdoor-membership-plan.outdoor-membership-plan" as any;

/**
 * Parses validUpto string and returns true if current time has passed expiry.
 * Plans with "unlimited" (or null/empty) will NEVER be considered expired.
 */
export function isPlanExpired(validUpto: string | null | undefined): boolean {
  if (!validUpto) return false;

  const trimmed = String(validUpto).trim().toLowerCase();
  if (trimmed === "unlimited") {
    return false;
  }

  let expiryDate: Date;
  // If date-only format (e.g. YYYY-MM-DD), set to end of that day (23:59:59.999)
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    expiryDate = new Date(`${trimmed}T23:59:59.999`);
  } else {
    expiryDate = new Date(validUpto);
  }

  if (isNaN(expiryDate.getTime())) {
    return false;
  }

  return Date.now() > expiryDate.getTime();
}

/**
 * Deactivates expired local and outdoor membership plans.
 */
export async function checkAndDeactivateExpiredPlans(strapi: any) {
  try {
    let localDeactivated = 0;
    let outdoorDeactivated = 0;

    /* 1. Check Local Membership Plans */
    const activeLocalPlans: any[] = await strapi.db
      .query(LOCAL_PLAN_UID)
      .findMany({
        where: {
          isActive: true,
        },
        select: ["id", "documentId", "planName", "validUpto", "isActive"],
      });

    for (const plan of activeLocalPlans || []) {
      if (isPlanExpired(plan.validUpto)) {
        try {
          if ((strapi as any).documents && plan.documentId) {
            await (strapi as any).documents(LOCAL_PLAN_UID).update({
              documentId: plan.documentId,
              data: { isActive: false },
            });
          } else {
            await strapi.entityService.update(LOCAL_PLAN_UID, plan.id, {
              data: { isActive: false },
            });
          }
          localDeactivated++;
        } catch (err) {
          strapi.log.error(
            `Failed to deactivate expired local plan ${plan.documentId || plan.id}:`,
            err,
          );
        }
      }
    }

    /* 2. Check Outdoor Membership Plans */
    const activeOutdoorPlans: any[] = await strapi.db
      .query(OUTDOOR_PLAN_UID)
      .findMany({
        where: {
          isActive: true,
        },
        select: ["id", "documentId", "planName", "validUpto", "isActive"],
      });

    for (const plan of activeOutdoorPlans || []) {
      if (isPlanExpired(plan.validUpto)) {
        try {
          if ((strapi as any).documents && plan.documentId) {
            await (strapi as any).documents(OUTDOOR_PLAN_UID).update({
              documentId: plan.documentId,
              data: { isActive: false },
            });
          } else {
            await strapi.entityService.update(OUTDOOR_PLAN_UID, plan.id, {
              data: { isActive: false },
            });
          }
          outdoorDeactivated++;
        } catch (err) {
          strapi.log.error(
            `Failed to deactivate expired outdoor plan ${plan.documentId || plan.id}:`,
            err,
          );
        }
      }
    }

    if (localDeactivated > 0 || outdoorDeactivated > 0) {
      strapi.log.info(
        `[CRON 4:50 AM] Deactivated ${localDeactivated} local plan(s) and ${outdoorDeactivated} outdoor plan(s) due to expiry.`,
      );
    } else {
      strapi.log.info(
        "[CRON 4:50 AM] Membership plan validity check complete. No plans expired.",
      );
    }

    return { localDeactivated, outdoorDeactivated };
  } catch (error) {
    strapi.log.error("[CRON 4:50 AM] Error checking expired plans:", error);
    throw error;
  }
}

export default {
  /**
   * Cron job runs everyday at 4:50 AM to deactivate expired membership plans.
   */
  deactivateExpiredPlans: {
    task: async ({ strapi }: { strapi: any }) => {
      await checkAndDeactivateExpiredPlans(strapi);
    },
    options: {
      rule: "50 4 * * *",
    },
  },
};
