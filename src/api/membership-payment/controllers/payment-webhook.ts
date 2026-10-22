import crypto from "crypto";

const PAYMENT_UID = "api::membership-payment.membership-payment";

const LOCAL_SUB_UID = "api::local-subscription.local-subscription";

const LOCAL_PLAN_UID = "api::local-membership-plan.local-membership-plan";

const OUTDOOR_SUB_UID = "api::outdoor-subscription.outdoor-subscription";

const OUTDOOR_PLAN_UID = "api::outdoor-membership-plan.outdoor-membership-plan";

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
        // A customer may retry the same Payment Link.
        // Do not mark the complete membership purchase failed here.
        strapi.log.info(
          `Razorpay payment attempt failed: ${
            event.payload?.payment?.entity?.id ?? "unknown"
          }`,
        );

        ctx.status = 200;
        ctx.body = {
          message: "Failed attempt acknowledged; retry may be possible",
        };
        return;
      }

      /* ---------- 6. HANDLE EXPIRED / CANCELLED LINKS ---------- */
      if (
        eventType === "payment_link.expired" ||
        eventType === "payment_link.cancelled"
      ) {
        const paymentLink = event.payload?.payment_link?.entity;

        if (!paymentLink?.id) {
          ctx.status = 400;
          ctx.body = { message: "Payment Link details missing" };
          return;
        }

        const payment = await strapi.db.query(PAYMENT_UID).findOne({
          where: {
            razorpayPaymentLinkId: paymentLink.id,
          },
          populate: {
            local_subscription: true,
            outdoor_subscription: true,
          },
        });

        if (!payment) {
          ctx.status = 500;
          ctx.body = { message: "Membership payment record not found" };
          return;
        }

        // Never overwrite a confirmed successful payment.
        if (
          payment.paymentStatus !== "paid" &&
          !payment.local_subscription &&
          !payment.outdoor_subscription
        ) {
          await strapi.db.query(PAYMENT_UID).update({
            where: { id: payment.id },
            data: { paymentStatus: "failed" },
          });
        }

        ctx.status = 200;
        ctx.body = {
          message: "Payment Link expiry/cancellation handled",
        };
        return;
      }

      /* ---------- 7. IGNORE OTHER EVENTS ---------- */
      if (eventType !== "payment_link.paid") {
        ctx.status = 200;
        ctx.body = { message: "Event ignored" };
        return;
      }

      /* ---------- 8. GET SUCCESSFUL PAYMENT DETAILS ---------- */
      const paymentLink = event.payload?.payment_link?.entity;

      const razorpayPayment = event.payload?.payment?.entity;

      if (!paymentLink?.id || !razorpayPayment?.id) {
        ctx.status = 400;
        ctx.body = { message: "Invalid payment payload" };
        return;
      }

      const payment = await strapi.db.query(PAYMENT_UID).findOne({
        where: {
          razorpayPaymentLinkId: paymentLink.id,
        },
        populate: {
          client_detail: true,
          local_subscription: true,
          outdoor_subscription: true,
        },
      });

      if (!payment) {
        strapi.log.error(`Payment record not found for link ${paymentLink.id}`);

        ctx.status = 500;
        ctx.body = { message: "Membership payment record not found" };
        return;
      }

      /* ---------- 9. VERIFY AMOUNT AND CURRENCY ---------- */
      const expectedAmountPaise = Math.round(Number(payment.amount) * 100);

      if (
        !Number.isFinite(expectedAmountPaise) ||
        expectedAmountPaise <= 0 ||
        Number(paymentLink.amount) !== expectedAmountPaise ||
        Number(razorpayPayment.amount) !== expectedAmountPaise ||
        paymentLink.currency !== payment.currency ||
        razorpayPayment.currency !== payment.currency
      ) {
        strapi.log.error(
          `Payment amount/currency mismatch for ${paymentLink.id}`,
        );

        ctx.status = 400;
        ctx.body = { message: "Payment amount or currency mismatch" };
        return;
      }

      /* ---------- 10. VERIFY PAYMENT IS COMPLETED ---------- */
      if (
        paymentLink.status !== "paid" ||
        razorpayPayment.status !== "captured"
      ) {
        ctx.status = 400;
        ctx.body = {
          message: "Payment has not been confirmed as captured",
        };
        return;
      }

      /* ---------- 11. HANDLE WEBHOOK RETRIES ---------- */

      const subscriptionType = payment.subscriptionType;

      if (!["local", "outdoor", "both"].includes(subscriptionType)) {
        ctx.status = 400;
        ctx.body = { message: "Unsupported subscription type" };
        return;
      }

      const needsLocal =
        subscriptionType === "local" || subscriptionType === "both";

      const needsOutdoor =
        subscriptionType === "outdoor" || subscriptionType === "both";

      // If already linked, reuse the existing subscription.
      // This prevents normal webhook retries from creating duplicates.
      let localSubscription = payment.local_subscription;
      let outdoorSubscription = payment.outdoor_subscription;

      const localAlreadyProcessed = !needsLocal || Boolean(localSubscription);

      const outdoorAlreadyProcessed =
        !needsOutdoor || Boolean(outdoorSubscription);

      if (localAlreadyProcessed && outdoorAlreadyProcessed) {
        await strapi.db.query(PAYMENT_UID).update({
          where: { id: payment.id },
          data: {
            paymentStatus: "paid",
            razorpayPaymentId: razorpayPayment.id,
          },
        });

        ctx.status = 200;
        ctx.body = { message: "Membership purchase already processed" };
        return;
      }

      /* ---------- 12. VERIFY CLIENT ---------- */

      const client = payment.client_detail;

      if (!client?.id || !client?.documentId) {
        ctx.status = 500;
        ctx.body = { message: "Client profile missing" };
        return;
      }

      /* ---------- 13. CREATE LOCAL SUBSCRIPTION IF REQUIRED ---------- */

      if (needsLocal && !localSubscription) {
        if (!payment.localPlanDocumentId) {
          ctx.status = 500;
          ctx.body = { message: "Local plan reference missing" };
          return;
        }

        const localPlan = await (strapi as any)
          .documents(LOCAL_PLAN_UID)
          .findOne({
            documentId: payment.localPlanDocumentId,
            populate: { club_owner: true },
          });

        if (!localPlan?.documentId || !localPlan?.club_owner) {
          ctx.status = 500;
          ctx.body = {
            message: "Local plan or club owner not found",
          };
          return;
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
              membership_payment: payment.documentId ?? payment.id,
            },
          });

        // Persist this relation immediately. If the next operation fails,
        // a retry can see that the local subscription was already created.
        await strapi.db.query(PAYMENT_UID).update({
          where: { id: payment.id },
          data: {
            local_subscription: localSubscription.id,
            razorpayPaymentId: razorpayPayment.id,
          },
        });

        strapi.log.info(`Local subscription created for payment ${payment.id}`);
      }

      /* ---------- 14. CREATE OUTDOOR SUBSCRIPTION IF REQUIRED ---------- */

      if (needsOutdoor && !outdoorSubscription) {
        if (!payment.outdoorPlanDocumentId) {
          ctx.status = 500;
          ctx.body = { message: "Outdoor plan reference missing" };
          return;
        }

        const outdoorPlan = await (strapi as any)
          .documents(OUTDOOR_PLAN_UID)
          .findOne({
            documentId: payment.outdoorPlanDocumentId,
          });

        if (!outdoorPlan?.documentId) {
          ctx.status = 500;
          ctx.body = { message: "Outdoor membership plan not found" };
          return;
        }

        const visits = Number(outdoorPlan.visitAllowed);

        if (!Number.isInteger(visits) || visits <= 0) {
          ctx.status = 500;
          ctx.body = {
            message: "Outdoor plan has an invalid visit allowance",
          };
          return;
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
              membership_payment: payment.documentId ?? payment.id,
            },
          });

        // Persist the outdoor relation before marking the payment as paid.
        await strapi.db.query(PAYMENT_UID).update({
          where: { id: payment.id },
          data: {
            outdoor_subscription: outdoorSubscription.id,
            razorpayPaymentId: razorpayPayment.id,
          },
        });

        strapi.log.info(
          `Outdoor subscription created for payment ${payment.id}`,
        );
      }

      /* ---------- 15. MARK PAYMENT PAID AFTER ALL REQUIRED SUBSCRIPTIONS ---------- */

      if (
        (needsLocal && !localSubscription) ||
        (needsOutdoor && !outdoorSubscription)
      ) {
        strapi.log.error(
          `Payment ${payment.id}: one or more required subscriptions are missing`,
        );

        ctx.status = 500;
        ctx.body = {
          message: "Membership activation incomplete; webhook retry required",
        };
        return;
      }

      await strapi.db.query(PAYMENT_UID).update({
        where: { id: payment.id },
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

      ctx.status = 200;
      ctx.body = {
        message:
          subscriptionType === "both"
            ? "✅ Local and outdoor memberships activated successfully"
            : `✅ ${subscriptionType} membership activated successfully`,
      };
    } catch (error) {
      strapi.log.error("Razorpay webhook processing failed", error);

      ctx.status = 500;
      ctx.body = { message: "Webhook processing failed" };
    }
  },
};
