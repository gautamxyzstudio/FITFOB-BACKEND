
/**
 * FitFob - Strapi Cron Jobs
 *
 * Timezone: Asia/Kolkata
 *
 * Jobs:
 * 1. Expire gym memberships - 11:55 PM
 * 2. Mark missed trials as no-show - 11:45 PM
 * 3. Auto checkout clients - Every 5 minutes
 *
 * All automated actions are recorded in activity_logs.
 */

const MEMBERSHIP_UID = "api::gym-membership.gym-membership";
const TRIAL_UID = "api::gym-trial.gym-trial";
const ACTIVITY_LOG_UID = "api::activity-log.activity-log";

const IST_TIMEZONE = "Asia/Kolkata";

/**
 * Get today's date in IST.
 * Returns YYYY-MM-DD.
 */
function getTodayISTString(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: IST_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const values: Record<string, string> = {};

  parts.forEach((part) => {
    values[part.type] = part.value;
  });

  return `${values.year}-${values.month}-${values.day}`;
}

/**
 * Create an activity log.
 *
 * Cron actions are performed by the system,
 * so no user relation is assigned.
 */
async function createActivityLog(
  strapi: any,
  data: {
    entityId: string | number;
    entityName: string;
    description: string;
  }
) {
  try {
    await strapi.db.query(ACTIVITY_LOG_UID).create({
      data: {
        entityId: String(data.entityId),
        entityName: data.entityName,
        description: data.description,
        actionType: "update",
      },
    });

    return true;
  } catch (error) {
    strapi.log.error(
      `[Cron:ActivityLog] Failed to create log for ${data.entityName} (${data.entityId}):`,
      error
    );

    return false;
  }
}

/**
 * Create logs for multiple records.
 * One failed activity log will not prevent other logs.
 */
async function createActivityLogs(
  strapi: any,
  records: any[],
  entityName: string,
  getDescription: (record: any) => string,
  getEntityId: (record: any) => string | number
) {
  if (!records.length) return;

  const results = await Promise.allSettled(
    records.map((record) =>
      createActivityLog(strapi, {
        entityId: getEntityId(record),
        entityName,
        description: getDescription(record),
      })
    )
  );

  const successful = results.filter(
    (result) => result.status === "fulfilled" && result.value === true
  ).length;

  const failed = records.length - successful;

  strapi.log.info(
    `[Cron:ActivityLog] ${entityName}: ${successful} log(s) created, ${failed} failed.`
  );
}

export default {
  /**
   * 1. EXPIRE GYM MEMBERSHIPS
   *
   * Runs daily at 11:55 PM IST.
   *
   * Finds active memberships whose endDate
   * is today or earlier.
   */
  expireGymMemberships: {
    task: async ({ strapi }: { strapi: any }) => {
      const todayStr = getTodayISTString();

      try {
        strapi.log.info(
          `[Cron:expireGymMemberships] Started. Date: ${todayStr}`
        );

        const memberships = await strapi.db
          .query(MEMBERSHIP_UID)
          .findMany({
            where: {
              endDate: {
                $lte: todayStr,
                $notNull: true,
              },
              membershipStatus: "active",
            },
            select: [
              "id",
              "documentId",
              "membershipId",
              "endDate",
            ],
          });

        if (!memberships.length) {
          strapi.log.info(
            "[Cron:expireGymMemberships] No memberships to expire."
          );
          return;
        }

        const ids = memberships.map((item: any) => item.id);

        // Update only memberships still active.
        const updateResult = await strapi.db
          .query(MEMBERSHIP_UID)
          .updateMany({
            where: {
              id: { $in: ids },
              membershipStatus: "active",
            },
            data: {
              membershipStatus: "expired",
            },
          });

        const updatedCount = updateResult.count ?? 0;

        if (!updatedCount) {
          strapi.log.info(
            "[Cron:expireGymMemberships] No memberships were updated."
          );
          return;
        }

        // Create activity logs for successfully updated records.
        await createActivityLogs(
          strapi,
          memberships,
          "gym-membership",
          (membership) =>
            `Gym membership ${membership.membershipId || membership.documentId} automatically expired because its end date (${membership.endDate}) was reached.`,
          (membership) =>
            membership.documentId ||
            membership.membershipId ||
            membership.id
        );

        strapi.log.info(
          `[Cron:expireGymMemberships] Successfully expired ${updatedCount} membership(s).`
        );
      } catch (error) {
        strapi.log.error(
          "[Cron:expireGymMemberships] Failed:",
          error
        );
      }
    },

    options: {
      rule: "55 23 * * *",
      tz: IST_TIMEZONE,
    },
  },

  /**
   * 2. MARK MISSED TRIALS AS NO-SHOW
   *
   * Runs daily at 11:45 PM IST.
   *
   * Only booked trials scheduled today or earlier
   * will be marked as no-show.
   */
  markNoShowTrials: {
    task: async ({ strapi }: { strapi: any }) => {
      const todayStr = getTodayISTString();

      try {
        strapi.log.info(
          `[Cron:markNoShowTrials] Started. Date: ${todayStr}`
        );

        const trials = await strapi.db
          .query(TRIAL_UID)
          .findMany({
            where: {
              trialDate: {
                $lte: todayStr,
                $notNull: true,
              },
              trialstatus: "booked",
            },
            select: [
              "id",
              "documentId",
              "trialDate",
            ],
          });

        if (!trials.length) {
          strapi.log.info(
            "[Cron:markNoShowTrials] No booked trials to process."
          );
          return;
        }

        const ids = trials.map((item: any) => item.id);

        // Update only trials that are still booked.
        const updateResult = await strapi.db
          .query(TRIAL_UID)
          .updateMany({
            where: {
              id: { $in: ids },
              trialstatus: "booked",
            },
            data: {
              trialstatus: "no-show",
            },
          });

        const updatedCount = updateResult.count ?? 0;

        if (!updatedCount) {
          strapi.log.info(
            "[Cron:markNoShowTrials] No trials were updated."
          );
          return;
        }

        // Record activity logs.
        await createActivityLogs(
          strapi,
          trials,
          "gym-trial",
          (trial) =>
            `Gym trial automatically marked as no-show because the scheduled trial date (${trial.trialDate}) passed without completion.`,
          (trial) =>
            trial.documentId || trial.id
        );

        strapi.log.info(
          `[Cron:markNoShowTrials] Successfully marked ${updatedCount} trial(s) as no-show.`
        );
      } catch (error) {
        strapi.log.error(
          "[Cron:markNoShowTrials] Failed:",
          error
        );
      }
    },

    options: {
      rule: "45 23 * * *",
      tz: IST_TIMEZONE,
    },
  },

  /**
   * 3. AUTOMATIC CLIENT CHECKOUT
   *
   * Runs every 5 minutes.
   *
   * Automatically checks out clients exactly
   * 2 hours after their check-in time.
   *
   * Uses PostgreSQL for atomic updates.
   */
  autoCheckoutClients: {
    task: async ({ strapi }: { strapi: any }) => {
      try {
        const knex = strapi.db.connection;

        // Update and retrieve records in one atomic query.
        const result = await knex.raw(`
          UPDATE client_checkins
          SET
            checkout_time = COALESCE(checkin_time, created_at)
                            + INTERVAL '2 hours',
            updated_at = NOW()
          WHERE checkout_time IS NULL
            AND COALESCE(checkin_time, created_at) IS NOT NULL
            AND NOW() - COALESCE(checkin_time, created_at)
                >= INTERVAL '2 hours'
          RETURNING
            id,
            document_id,
            checkin_time,
            created_at,
            checkout_time;
        `);

        const checkedOutRecords = result.rows || [];

        if (!checkedOutRecords.length) {
          return;
        }

        strapi.log.info(
          `[Cron:autoCheckoutClients] Auto-checking out ${checkedOutRecords.length} client(s).`
        );

        // Record activity logs only for successfully updated records.
        await createActivityLogs(
          strapi,
          checkedOutRecords,
          "client-checkin",
          (record) => {
            const checkinTime =
              record.checkin_time || record.created_at;

            return (
              `Client automatically checked out after completing the maximum 2-hour check-in duration. ` +
              `Check-in: ${checkinTime}, checkout: ${record.checkout_time}.`
            );
          },
          (record) =>
            record.document_id || record.id
        );

        strapi.log.info(
          `[Cron:autoCheckoutClients] Successfully checked out ${checkedOutRecords.length} client(s).`
        );
      } catch (error) {
        strapi.log.error(
          "[Cron:autoCheckoutClients] Failed:",
          error
        );
      }
    },

    options: {
      rule: "*/5 * * * *",
      tz: IST_TIMEZONE,
    },
  },
};
