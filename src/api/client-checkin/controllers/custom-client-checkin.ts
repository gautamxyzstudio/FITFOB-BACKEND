import { Context } from "koa";

const CLIENT_UID = "api::client-detail.client-detail";
const SUB_UID = "api::user-subscription.user-subscription";
const CHECKIN_UID = "api::client-checkin.client-checkin";

export default {
  async scan(ctx: Context) {
    const { clientId } = ctx.request.body;

    if (!clientId) {
      console.log("❌ No clientId provided");
      return ctx.badRequest("clientId is required");
    }

    try {
      /* 1️⃣ Find Client */
      const client: any = await strapi.db.query(CLIENT_UID).findOne({
        where: { clientId },
      });

      if (!client) {
        throw new Error("Client not found");
      }

      /* 2️⃣ Find Latest Subscription */
      const subscription: any = await strapi.db.query(SUB_UID).findOne({
        where: {
          client_detail: client.id,
        },
        orderBy: { start_date: "desc" },
      });

      if (!subscription) {
        throw new Error("No membership found");
      }

      /* 3️⃣ Status Checks */

      if (subscription.subscription_status === "cancelled") {
        throw new Error("Your membership has been cancelled");
      }

      if (subscription.subscription_status === "expired") {
        throw new Error("Membership expired");
      }

      if (subscription.subscription_status === "completed") {
        throw new Error("All visits used");
      }

      /* 4️⃣ Expiry Check (auto update if needed) */

      const now = new Date();
      const endDate = new Date(subscription.end_date);
      endDate.setHours(23, 59, 59, 999);

      if (now > endDate) {

        await strapi.entityService.update(
          "api::user-subscription.user-subscription",
          subscription.id,
          {
            data: {
              subscription_status: "expired",
            },
          }
        );

        console.log("⛔ Membership auto-marked as expired");

        throw new Error("Membership expired");
      }

      /* 5️⃣ Visit Check */

      if (!subscription.remaining_visits || subscription.remaining_visits <= 0) {

        await strapi.db.query(SUB_UID).update({
          where: { id: subscription.id },
          data: { subscription_status: "completed" },
        });

        throw new Error("All visits used");
      }

      /* 6️⃣ Double Scan Protection */

      const lastCheckin: any = await strapi.db.query(CHECKIN_UID).findOne({
        where: { client_detail: client.id },
        orderBy: { in: "desc" },
      });

      if (lastCheckin) {
        const diff =
          new Date().getTime() - new Date(lastCheckin.in).getTime();

        if (diff < 60000) {
          throw new Error("Already checked in recently");
        }
      }

      /* 7️⃣ Create Checkin */

      const checkin = await strapi.entityService.create(
        "api::client-checkin.client-checkin",
        {
          data: {
            in: new Date(),
            client_detail: client.id,
            publishedAt: new Date(),
          },
        }
      );

      /* 8️⃣ Update Subscription */

      const updatedUsed = (subscription.used_visits || 0) + 1;
      const updatedRemaining = subscription.remaining_visits - 1;

      await strapi.db.query(SUB_UID).update({
        where: { id: subscription.id },
        data: {
          used_visits: updatedUsed,
          remaining_visits: updatedRemaining,
          subscription_status:
            updatedRemaining === 0 ? "completed" : "active",
        },
      });

      ctx.body = {
        success: true,
        message: "Check-in successful",
        remaining_visits: updatedRemaining,
      };

    } catch (error: any) {
      console.log("❌ ERROR:", error.message);
      return ctx.badRequest(error.message || "Something went wrong");
    }
  },
};