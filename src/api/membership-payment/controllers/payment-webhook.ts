import crypto from "crypto";

const PAYMENT_UID = "api::membership-payment.membership-payment";

const LOCAL_SUB_UID = "api::local-subscription.local-subscription";

const LOCAL_PLAN_UID = "api::local-membership-plan.local-membership-plan";

const OUTDOOR_SUB_UID = "api::outdoor-subscription.outdoor-subscription";

const OUTDOOR_PLAN_UID = "api::outdoor-membership-plan.outdoor-membership-plan";

class WebhookProcessingError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "WebhookProcessingError";
    this.status = status;
  }
}

/* ---------- HELPER: CALCULATE LOCAL SUBSCRIPTION END DATE ---------- */
function calculateEndDate(startDate: Date, monthDuration: number): string {
  const endDate = new Date(startDate.getTime());
  const originalDay = endDate.getDate();

  endDate.setDate(1);
  endDate.setMonth(endDate.getMonth() + monthDuration);

  const lastDayOfTargetMonth = new Date(
    endDate.getFullYear(),
    endDate.getMonth() + 1,
    0,
  ).getDate();

  endDate.setDate(Math.min(originalDay, lastDayOfTargetMonth));

  return endDate.toISOString().split("T")[0];
}

export default {
  async webhook(ctx) {
    try {
      /* ---------- 1. VERIFY WEBHOOK SIGNATURE ---------- */
      const signature = ctx.request.headers["x-razorpay-signature"];

      const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

      if (
        typeof signature !== "string" ||
        !secret ||
        !/^[a-f0-9]{64}$/i.test(signature)
      ) {
        ctx.status = 400;
        ctx.body = { message: "Missing or invalid webhook signature" };
        return;
      }

      /* ---------- 2. GET ORIGINAL RAW BODY ---------- */
      const requestBody = ctx.request.body as any;

      const rawBody =
        requestBody?.[Symbol.for("unparsedBody")] ??
        (ctx.request as any).rawBody;

      if (!rawBody) {
        strapi.log.error("Razorpay webhook: original request body unavailable");

        ctx.status = 500;
        ctx.body = { message: "Raw request body unavailable" };
        return;
      }

      const rawBodyBuffer = Buffer.isBuffer(rawBody)
        ? rawBody
        : Buffer.from(String(rawBody), "utf8");

      /* ---------- 3. VERIFY HMAC ---------- */
      const expectedSignature = crypto
        .createHmac("sha256", secret)
        .update(rawBodyBuffer)
        .digest();

      const receivedSignature = Buffer.from(signature, "hex");

      if (
        expectedSignature.length !== receivedSignature.length ||
        !crypto.timingSafeEqual(expectedSignature, receivedSignature)
      ) {
        ctx.status = 400;
        ctx.body = { message: "Invalid webhook signature" };
        return;
      }

      /* ---------- 4. PARSE VERIFIED BODY ---------- */
      let event: any;

      try {
        event = JSON.parse(rawBodyBuffer.toString("utf8"));
      } catch {
        ctx.status = 400;
        ctx.body = { message: "Invalid JSON payload" };
        return;
      }

      const eventType = event.event;

      /* ---------- 5. HANDLE FAILED PAYMENT ATTEMPT ---------- */
      if (eventType === "payment.failed") {
        // A failed attempt does not necessarily mean the Order is permanently failed.
        // Do not mark the complete membership purchase failed here.
        strapi.log.info(
          `Razorpay payment attempt failed: ${
            event.payload?.payment?.entity?.id ?? "unknown"
          }`,
        );

        ctx.status = 200;
        ctx.body = {
          message: "Failed payment attempt acknowledged",
        };
        return;
      }

      /* ---------- 6. HANDLE ORDER-BASED MOBILE PAYMENT ---------- */

      // Only process captured payments for the mobile Order flow.
      if (eventType !== "payment.captured") {
        ctx.status = 200;
        ctx.body = { message: "Event ignored" };
        return;
      }

      /* ---------- 7. GET CAPTURED PAYMENT DETAILS ---------- */

      const razorpayPayment = event.payload?.payment?.entity;

      if (!razorpayPayment?.id || !razorpayPayment?.order_id) {
        ctx.status = 400;
        ctx.body = { message: "Invalid captured payment payload" };
        return;
      }

      /* ---------- 8. FIND MEMBERSHIP PAYMENT BY ORDER ID ---------- */

      const payment = await strapi.db.query(PAYMENT_UID).findOne({
        where: {
          razorpayOrderId: razorpayPayment.order_id,
        },
        populate: {
          client_detail: true,
          local_subscription: true,
          outdoor_subscription: true,
        },
      });

      if (!payment) {
        strapi.log.error(
          `Membership payment not found for Razorpay order ${razorpayPayment.order_id}`,
        );

        // Return an error so Razorpay can retry delivery.
        ctx.status = 500;
        ctx.body = { message: "Membership payment record not found" };
        return;
      }

      /* ---------- 9. VERIFY ORDER, AMOUNT AND CURRENCY ---------- */

      const expectedAmountPaise = Math.round(Number(payment.amount) * 100);

      if (
        payment.razorpayOrderId !== razorpayPayment.order_id ||
        !Number.isFinite(expectedAmountPaise) ||
        expectedAmountPaise <= 0 ||
        Number(razorpayPayment.amount) !== expectedAmountPaise ||
        razorpayPayment.currency !== payment.currency
      ) {
        strapi.log.error(
          `Payment/order amount or currency mismatch for order ${razorpayPayment.order_id}`,
        );

        ctx.status = 400;
        ctx.body = { message: "Payment amount or currency mismatch" };
        return;
      }

      /* ---------- 10. VERIFY PAYMENT IS CAPTURED ---------- */

      if (razorpayPayment.status !== "captured") {
        ctx.status = 200;
        ctx.body = { message: "Payment is not captured yet" };
        return;
      }

      /* ---------- 11. HANDLE WEBHOOK RETRIES ---------- */

      const result = await strapi.db.transaction(async ({ trx }) => {
        // Acquire a transaction-level lock for this payment.
        await trx.raw("SELECT pg_advisory_xact_lock(?, ?)", [
          123456,
          payment.id,
        ]);

        // Re-fetch after acquiring the lock because the original
        // payment object may be stale.
        const lockedPayment = await strapi.db.query(PAYMENT_UID).findOne({
          where: { id: payment.id },
          populate: {
            client_detail: true,
            local_subscription: true,
            outdoor_subscription: true,
          },
        });

        if (!lockedPayment) {
          throw new WebhookProcessingError(500, "Membership payment not found");
        }

        const subscriptionType = lockedPayment.subscriptionType;

        if (!["local", "outdoor", "both"].includes(subscriptionType)) {
          throw new WebhookProcessingError(
            400,
            "Unsupported subscription type",
          );
        }

        const needsLocal =
          subscriptionType === "local" || subscriptionType === "both";

        const needsOutdoor =
          subscriptionType === "outdoor" || subscriptionType === "both";

        let localSubscription = lockedPayment.local_subscription;
        let outdoorSubscription = lockedPayment.outdoor_subscription;

        // If another webhook already completed activation, do not create
        // the subscriptions again.
        if (
          (!needsLocal || Boolean(localSubscription)) &&
          (!needsOutdoor || Boolean(outdoorSubscription))
        ) {
          await strapi.db.query(PAYMENT_UID).update({
            where: { id: lockedPayment.id },
            data: {
              paymentStatus: "paid",
              razorpayPaymentId: razorpayPayment.id,
            },
          });

          return {
            message: "Membership purchase already processed",
          };
        }

        /* ---------- 12. VERIFY CLIENT ---------- */

        const client = lockedPayment.client_detail;

        if (!client?.id || !client?.documentId) {
          throw new WebhookProcessingError(500, "Client profile missing");
        }

        /* ---------- 13. CREATE LOCAL SUBSCRIPTION IF REQUIRED ---------- */

        if (needsLocal && !localSubscription) {
          if (!lockedPayment.localPlanDocumentId) {
            throw new WebhookProcessingError(
              500,
              "Local plan reference missing",
            );
          }

          const localPlan = await (strapi as any)
            .documents(LOCAL_PLAN_UID)
            .findOne({
              documentId: lockedPayment.localPlanDocumentId,
              populate: { club_owner: true },
            });

          if (!localPlan?.documentId || !localPlan?.club_owner) {
            throw new WebhookProcessingError(
              500,
              "Local plan or club owner not found",
            );
          }

          const startDate = new Date();
          const monthDuration = Number(localPlan.monthDuration) || 1;
          const endDate = calculateEndDate(startDate, monthDuration);

          localSubscription = await (strapi as any)
            .documents(LOCAL_SUB_UID)
            .create({
              data: {
                client_detail: client.documentId,
                club_owner:
                  localPlan.club_owner.documentId ?? localPlan.club_owner.id,
                local_membership_plan: localPlan.documentId,
                membershipType: "app",
                startDate: startDate.toISOString(),
                endDate,
                subscriptionStatus: "active",
                membership_payment:
                  lockedPayment.documentId ?? lockedPayment.id,
              },
            });

          await strapi.db.query(PAYMENT_UID).update({
            where: { id: lockedPayment.id },
            data: {
              local_subscription: localSubscription.id,
              razorpayPaymentId: razorpayPayment.id,
            },
          });

          strapi.log.info(
            `Local subscription created for payment ${lockedPayment.id}`,
          );
        }

        /* ---------- 14. CREATE OUTDOOR SUBSCRIPTION IF REQUIRED ---------- */

        if (needsOutdoor && !outdoorSubscription) {
          if (!lockedPayment.outdoorPlanDocumentId) {
            throw new WebhookProcessingError(
              500,
              "Outdoor plan reference missing",
            );
          }

          const outdoorPlan = await (strapi as any)
            .documents(OUTDOOR_PLAN_UID)
            .findOne({
              documentId: lockedPayment.outdoorPlanDocumentId,
            });

          if (!outdoorPlan?.documentId) {
            throw new WebhookProcessingError(
              500,
              "Outdoor membership plan not found",
            );
          }

          const visits = Number(outdoorPlan.visitAllowed);

          if (!Number.isInteger(visits) || visits <= 0) {
            throw new WebhookProcessingError(
              500,
              "Outdoor plan has an invalid visit allowance",
            );
          }

          outdoorSubscription = await (strapi as any)
            .documents(OUTDOOR_SUB_UID)
            .create({
              data: {
                client_detail: client.documentId,
                outdoor_membership_plan: outdoorPlan.documentId,
                membershipType: "app",
                totalVisitsAllowed: visits,
                usedVisits: 0,
                remainingVisits: visits,
                subscriptionStatus: "active",
                membership_payment:
                  lockedPayment.documentId ?? lockedPayment.id,
              },
            });

          await strapi.db.query(PAYMENT_UID).update({
            where: { id: lockedPayment.id },
            data: {
              outdoor_subscription: outdoorSubscription.id,
              razorpayPaymentId: razorpayPayment.id,
            },
          });

          strapi.log.info(
            `Outdoor subscription created for payment ${lockedPayment.id}`,
          );
        }

        /* ---------- 15. MARK PAYMENT PAID AFTER ALL REQUIRED SUBSCRIPTIONS ---------- */

        if (
          (needsLocal && !localSubscription) ||
          (needsOutdoor && !outdoorSubscription)
        ) {
          throw new WebhookProcessingError(
            500,
            "Membership activation incomplete; webhook retry required",
          );
        }

        await strapi.db.query(PAYMENT_UID).update({
          where: { id: lockedPayment.id },
          data: {
            paymentStatus: "paid",
            razorpayPaymentId: razorpayPayment.id,
            ...(needsLocal ? { local_subscription: localSubscription.id } : {}),
            ...(needsOutdoor
              ? { outdoor_subscription: outdoorSubscription.id }
              : {}),
          },
        });

        strapi.log.info(
          `✅ Membership purchase activated | Type: ${subscriptionType} | 💳 Payment ID: ${payment.id}`,
        );

        return {
          message:
            subscriptionType === "both"
              ? "Local and outdoor memberships activated successfully"
              : `${subscriptionType} membership activated successfully`,
        };
      });

      ctx.status = 200;
      ctx.body = { message: result.message };
    } catch (error) {
      strapi.log.error("Razorpay webhook processing failed", error);

      if (error instanceof WebhookProcessingError) {
        ctx.status = error.status;
        ctx.body = { message: error.message };
        return;
      }

      ctx.status = 500;
      ctx.body = { message: "Webhook processing failed" };
    }
  },
};
