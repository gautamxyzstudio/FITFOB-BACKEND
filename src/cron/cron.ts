const LOCAL_PLAN_UID =
  "api::local-membership-plan.local-membership-plan" as any;
const OUTDOOR_PLAN_UID =
  "api::outdoor-membership-plan.outdoor-membership-plan" as any;
const CHECKIN_UID = "api::client-checkin.client-checkin" as any;

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
            `Failed to deactivate expired local plan ${
              plan.documentId || plan.id
            }:`,
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
            `Failed to deactivate expired outdoor plan ${
              plan.documentId || plan.id
            }:`,
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

/**
 * Automatically checks out clients who have not checked out after 2 hours of check-in.
 * For example, if checkin time is 4:00 PM and user has still not checked out,
 * at 6:00 PM the checkoutTime will be set to 6:00 PM (checkinTime + 2 hours).
 */

export async function autoCheckoutOverdueCheckins(strapi: any) {
  try {
    const now = new Date();

    const twoHoursAgo = new Date(
      now.getTime() - 2 * 60 * 60 * 1000,
    );

    strapi.log.info(
      `[CRON AUTO-CHECKOUT] Checking check-ins before ${twoHoursAgo.toISOString()}`,
    );

    const overdueCheckins = await strapi.db.connection(
      "client_checkins",
    )
      .select(
        "id",
        "document_id",
        "checkin_time",
        "checkout_time",
      )
      .where("checkin_time", "<=", twoHoursAgo)
      .whereNull("checkout_time");

    if (!overdueCheckins.length) {
      return {
        checkedOutCount: 0,
      };
    }

    let checkedOutCount = 0;

    for (const checkin of overdueCheckins) {
      try {
        const autoCheckoutTime = new Date(
          new Date(checkin.checkin_time).getTime() +
            2 * 60 * 60 * 1000,
        );

        await strapi.db.connection("client_checkins")
          .where("id", checkin.id)
          .update({
            checkout_time: autoCheckoutTime,
          });

        checkedOutCount++;
      } catch (error) {
        strapi.log.error(
          `[CRON AUTO-CHECKOUT] Failed`,
          error,
        );
      }
    }

    strapi.log.info(
      `[CRON AUTO-CHECKOUT] Automatically checked out ${checkedOutCount} check-in(s).`,
    );

    return {
      checkedOutCount,
    };
  } catch (error) {
    strapi.log.error(
      "[CRON AUTO-CHECKOUT] Error:",
      error,
    );

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

  /**
   * Cron job runs every 2 minutes to automatically check out clients
   * who have not checked out after 2 hours of check-in.
   */
  autoCheckoutOverdueCheckins: {
    task: async ({ strapi }: { strapi: any }) => {
      await autoCheckoutOverdueCheckins(strapi);
    },
    options: {
      rule: "*/2 * * * *",
    },
  },
};
