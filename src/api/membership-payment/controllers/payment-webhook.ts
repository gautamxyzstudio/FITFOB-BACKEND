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

      /* ---------- 11. PROCESS PAYMENT WITH CONCURRENCY LOCK ---------- */

      const subscriptionType = payment.subscriptionType;

      if (!["local", "outdoor", "both"].includes(subscriptionType)) {
        ctx.status = 400;
        ctx.body = { message: "Unsupported subscription type" };
        return;
      }

      const result = await strapi.db.transaction(async ({ trx }) => {
        // Only one webhook can process this payment at a time.
        await trx.raw("SELECT pg_advisory_xact_lock(?, ?)", [
          123456,
          payment.id,
        ]);

        // IMPORTANT: Re-fetch after acquiring the lock.
        // The second webhook must read the first webhook's committed changes.
        const lockedPayment = await strapi.db.query(PAYMENT_UID).findOne({
          where: { id: payment.id },
          populate: {
            client_detail: true,
            local_subscription: true,
            outdoor_subscription: true,
          },
        });

        if (!lockedPayment) {
          throw new Error("Membership payment record not found after locking");
        }

        const lockedType = lockedPayment.subscriptionType;

        if (!["local", "outdoor", "both"].includes(lockedType)) {
          throw new Error("Unsupported subscription type");
        }

        const needsLocal = lockedType === "local" || lockedType === "both";

        const needsOutdoor = lockedType === "outdoor" || lockedType === "both";

        let localSubscription = lockedPayment.local_subscription;
        let outdoorSubscription = lockedPayment.outdoor_subscription;

        // A previous webhook may already have activated this purchase.
        const localAlreadyProcessed = !needsLocal || Boolean(localSubscription);

        const outdoorAlreadyProcessed =
          !needsOutdoor || Boolean(outdoorSubscription);

        if (localAlreadyProcessed && outdoorAlreadyProcessed) {
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

        if (!client?.documentId) {
          throw new Error("Client profile missing");
        }

        /* ---------- 13. CREATE LOCAL SUBSCRIPTION ---------- */

        if (needsLocal && !localSubscription) {
          if (!lockedPayment.localPlanDocumentId) {
            throw new Error("Local plan reference missing");
          }

          const localPlan = await (strapi as any)
            .documents(LOCAL_PLAN_UID)
            .findOne({
              documentId: lockedPayment.localPlanDocumentId,
              populate: { club_owner: true },
            });

          if (!localPlan?.documentId || !localPlan?.club_owner) {
            throw new Error("Local plan or club owner not found");
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

          if (!localSubscription?.id) {
            throw new Error("Local subscription creation failed");
          }

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

        /* ---------- 14. CREATE OUTDOOR SUBSCRIPTION ---------- */

        if (needsOutdoor && !outdoorSubscription) {
          if (!lockedPayment.outdoorPlanDocumentId) {
            throw new Error("Outdoor plan reference missing");
          }

          const outdoorPlan = await (strapi as any)
            .documents(OUTDOOR_PLAN_UID)
            .findOne({
              documentId: lockedPayment.outdoorPlanDocumentId,
            });

          if (!outdoorPlan?.documentId) {
            throw new Error("Outdoor membership plan not found");
          }

          const visits = Number(outdoorPlan.visitAllowed);

          if (!Number.isInteger(visits) || visits <= 0) {
            throw new Error("Outdoor plan has an invalid visit allowance");
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

          if (!outdoorSubscription?.id) {
            throw new Error("Outdoor subscription creation failed");
          }

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

        /* ---------- 15. MARK PAYMENT PAID ---------- */

        if (
          (needsLocal && !localSubscription) ||
          (needsOutdoor && !outdoorSubscription)
        ) {
          throw new Error(
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
          `✅ Membership purchase activated | Type: ${lockedType} | 💳 Payment ID: ${lockedPayment.id}`,
        );

        return {
          message:
            lockedType === "both"
              ? "✅ Local and outdoor memberships activated successfully"
              : `✅ ${lockedType} membership activated successfully`,
        };
      });

      // Send success only after the transaction has committed.
      ctx.status = 200;
      ctx.body = result;
    } catch (error) {
      strapi.log.error("Razorpay webhook processing failed", error);

      ctx.status = 500;
      ctx.body = { message: "Webhook processing failed" };
    }
  },
};
