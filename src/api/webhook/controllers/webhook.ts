import crypto from "node:crypto";
import {
  finalizeGymMembershipPayment,
} from "../../../utils/razorpay";

function getRawBody(ctx: any): Buffer | null {
  const requestBody = ctx.request.body as any;
  const rawBody =
    requestBody?.[Symbol.for("unparsedBody")] ??
    (ctx.request as any).rawBody;

  if (!rawBody) return null;
  return Buffer.isBuffer(rawBody)
    ? rawBody
    : Buffer.from(rawBody);
}

function verifyWebhookSignature(
  rawBody: Buffer,
  signature: string,
  secret: string
) {
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  const receivedBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");

  return (
    receivedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

export default {
  async handle(ctx: any) {
    try {
      const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
      if (!secret) {
        strapi.log.error("RAZORPAY_WEBHOOK_SECRET is missing.");
        ctx.status = 500;
        ctx.body = { received: false, message: "Webhook is not configured." };
        return;
      }

      const signature =
        ctx.request.headers["x-razorpay-signature"];

      if (typeof signature !== "string" || !signature) {
        ctx.status = 400;
        ctx.body = { received: false, message: "Missing webhook signature." };
        return;
      }

      const rawBody = getRawBody(ctx);
      if (!rawBody) {
        ctx.status = 400;
        ctx.body = { received: false, message: "Raw webhook body is missing." };
        return;
      }

      if (!verifyWebhookSignature(rawBody, signature, secret)) {
        ctx.status = 401;
        ctx.body = { received: false, message: "Invalid webhook signature." };
        return;
      }

      const payload = JSON.parse(rawBody.toString("utf8"));
      const event = payload.event;

      // A failed attempt does not mean the Razorpay order is terminal.
      if (event === "payment.failed") {
        ctx.status = 200;
        ctx.body = {
          received: true,
          message: "Failed payment attempt acknowledged.",
        };
        return;
      }

      if (event !== "payment.captured") {
        ctx.status = 200;
        ctx.body = { received: true, message: "Event ignored." };
        return;
      }

      const payment = payload.payload?.payment?.entity;
      const paymentId = payment?.id;
      const orderId = payment?.order_id;

      if (!paymentId || !orderId) {
        ctx.status = 400;
        ctx.body = {
          received: false,
          message: "Captured payment is missing payment or order ID.",
        };
        return;
      }

      const result = await finalizeGymMembershipPayment(
        orderId,
        paymentId
      );

      ctx.status = 200;
      ctx.body = {
        received: true,
        success: true,
        ...result,
      };
    } catch (error: any) {
      strapi.log.error("Razorpay webhook processing failed:", error);
      // Non-2xx response allows Razorpay to retry delivery.
      ctx.status = 500;
      ctx.body = {
        received: false,
        message: "Webhook processing failed.",
      };
    }
  },
};
