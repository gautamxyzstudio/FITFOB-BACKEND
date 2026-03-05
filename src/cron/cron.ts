export const runSubscriptionMaintenance = async () => {
  console.log("⏰ CRON TRIGGERED: Subscription maintenance");

  const now = new Date();
  console.log("🕒 Current time:", now);

  try {
    /* ==================================
       1️⃣ EXPIRE SUBSCRIPTIONS
       ================================== */

    const expiredSubs = await strapi.db
      .query("api::user-subscription.user-subscription")
      .findMany({
        where: {
          subscription_status: "active",
          end_date: { $lt: now },
        },
      });

    for (const sub of expiredSubs) {
      await strapi.entityService.update(
        "api::user-subscription.user-subscription",
        sub.id,
        {
          data: {
            subscription_status: "expired",
          },
        }
      );
    }

    /* ==================================
       2️⃣ COMPLETE WHEN VISITS = 0
       ================================== */

    const completedSubs = await strapi.db
      .query("api::user-subscription.user-subscription")
      .findMany({
        where: {
          subscription_status: "active",
          remaining_visits: { $lte: 0 },
        },
      });

    for (const sub of completedSubs) {
      await strapi.entityService.update(
        "api::user-subscription.user-subscription",
        sub.id,
        {
          data: {
            subscription_status: "completed",
          },
        }
      );
    }

    console.log("✅ CRON FINISHED\n");
  } catch (error) {
    console.error("❌ CRON ERROR:", error);
  }
};