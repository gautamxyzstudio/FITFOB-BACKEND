/**
 * Cron Jobs Configuration for Strapi
 * 
 * Scheduled tasks run automatically according to the configured rule.
 * Timezone: Asia/Kolkata (IST)
 */

function getTodayISTString(): string {
  const now = new Date();
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  const target = new Date(now.getTime() + IST_OFFSET);
  const year = target.getUTCFullYear();
  const month = String(target.getUTCMonth() + 1).padStart(2, "0");
  const day = String(target.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export default {
  /**
   * Auto-expire gym memberships according to end date.
   * Finds all active gym memberships with endDate <= today's date
   * and updates their status to 'expired'.
   */
  expireGymMemberships: {
    task: async ({ strapi }: { strapi: any }) => {
      try {
        const todayStr = getTodayISTString();
        strapi.log.info(
          `[Cron:expireGymMemberships] Running membership expiration check for date <= ${todayStr}...`
        );

        // 1. Find all active gym memberships where endDate is on or before today
        const expiringMemberships = await strapi.db
          .query("api::gym-membership.gym-membership")
          .findMany({
            where: {
              endDate: {
                $lte: todayStr,
                $notNull: true,
              },
              $or: [
                { membershipStatus: "active" },
                { membershipStatus: "true" },
              ],
            },
            select: [
              "id",
              "documentId",
              "membershipId",
              "endDate",
              "membershipStatus",
            ],
          });

        if (expiringMemberships && expiringMemberships.length > 0) {
          const ids = expiringMemberships.map((m: any) => m.id);

          // Update status to 'expired'
          await strapi.db
            .query("api::gym-membership.gym-membership")
            .updateMany({
              where: {
                id: { $in: ids },
              },
              data: {
                membershipStatus: "expired",
              },
            });

          strapi.log.info(
            `[Cron:expireGymMemberships] Successfully auto-expired ${ids.length} gym membership(s) on ${todayStr} (IDs: ${ids.join(", ")})`
          );
        } else {
          strapi.log.info(
            `[Cron:expireGymMemberships] No gym memberships to expire for date ${todayStr}.`
          );
        }
      } catch (error) {
        strapi.log.error(
          "[Cron:expireGymMemberships] Error during membership auto-expiration:",
          error
        );
      }
    },
    options: {
      rule: "55 23 * * *", 
      tz: "Asia/Kolkata",
    },
  },

  /**
   * Auto-update booked trials to 'no-show' if not completed by the end of the day.
   * Runs every night at 11:55 PM (23:55) IST.
   *
   * Finds all gym trials with trialDate <= today's date and trialstatus === 'booked'
   * and updates their status to 'no-show'.
   */
  markNoShowTrials: {
    task: async ({ strapi }: { strapi: any }) => {
      try {
        const todayStr = getTodayISTString();
        strapi.log.info(
          `[Cron:markNoShowTrials] Running no-show check for booked trials on or before ${todayStr}...`
        );

        // 1. Find all booked trials on or before today
        const bookedTrials = await strapi.db
          .query("api::gym-trial.gym-trial")
          .findMany({
            where: {
              trialDate: {
                $lte: todayStr,
                $notNull: true,
              },
              trialstatus: "booked",
            },
            select: ["id", "documentId", "trialDate", "trialstatus"],
          });

        if (bookedTrials && bookedTrials.length > 0) {
          const ids = bookedTrials.map((t: any) => t.id);

          // Update status to 'no-show'
          await strapi.db
            .query("api::gym-trial.gym-trial")
            .updateMany({
              where: {
                id: { $in: ids },
              },
              data: {
                trialstatus: "no-show",
              },
            });

          strapi.log.info(
            `[Cron:markNoShowTrials] Successfully updated ${ids.length} booked trial(s) to 'no-show' on ${todayStr} (IDs: ${ids.join(", ")})`
          );
        } else {
          strapi.log.info(
            `[Cron:markNoShowTrials] No booked trials to mark as no-show for date ${todayStr}.`
          );
        }
      } catch (error) {
        strapi.log.error(
          "[Cron:markNoShowTrials] Error updating booked trials to no-show:",
          error
        );
      }
    },
    options: {
      rule: "45 23 * * *", 
      tz: "Asia/Kolkata",
    },
  },

  /**
   * Auto-checkout clients after 2 hours of check-in.
   * Runs every 2 minutes.
   *
   * Finds all client-checkin records where checkoutTime is null
   * and checkinTime (or createdAt) is older than 2 hours (120 minutes),
   * then updates checkoutTime to (checkinTime + 2 hours).
   */
  autoCheckoutClients: {
    task: async ({ strapi }: { strapi: any }) => {
      try {
        const now = new Date();
        const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
        const twoHoursAgo = new Date(now.getTime() - TWO_HOURS_MS);

        // Find active checkins where checkinTime is older than 2 hours
        const expiredCheckins = await strapi.db
          .query("api::client-checkin.client-checkin")
          .findMany({
            where: {
              checkoutTime: {
                $null: true,
              },
              $or: [
                {
                  checkinTime: {
                    $lte: twoHoursAgo,
                    $notNull: true,
                  },
                },
                {
                  checkinTime: {
                    $null: true,
                  },
                  createdAt: {
                    $lte: twoHoursAgo,
                    $notNull: true,
                  },
                },
              ],
            },
            select: ["id", "documentId", "checkinTime", "createdAt"],
          });

        if (expiredCheckins && expiredCheckins.length > 0) {
          strapi.log.info(
            `[Cron:autoCheckoutClients] Auto-checking out ${expiredCheckins.length} client check-in(s)...`
          );

          for (const item of expiredCheckins) {
            const baseTime = item.checkinTime
              ? new Date(item.checkinTime).getTime()
              : new Date(item.createdAt).getTime();

            const checkoutDate = isNaN(baseTime)
              ? now
              : new Date(Math.min(baseTime + TWO_HOURS_MS, now.getTime()));

            await strapi.db
              .query("api::client-checkin.client-checkin")
              .update({
                where: { id: item.id },
                data: {
                  checkoutTime: checkoutDate,
                },
              });
          }

          strapi.log.info(
            `[Cron:autoCheckoutClients] Successfully auto-checked out ${expiredCheckins.length} client check-in(s) (IDs: ${expiredCheckins.map((c: any) => c.id).join(", ")})`
          );
        }
      } catch (error) {
        strapi.log.error(
          "[Cron:autoCheckoutClients] Error during client auto-checkout:",
          error
        );
      }
    },
    options: {
      rule: "*/5 * * * *",
      tz: "Asia/Kolkata",
    },
  },
};
