
import crypto from "node:crypto";
import Razorpay from "razorpay";

const PAYMENT_UID = "api::membership-payment.membership-payment";

export default {
  async verifyPayment(ctx) {
    try {
      const user = ctx.state.user;

      if (!user) {
        return ctx.unauthorized("Authentication required.");
      }

      const keyId = process.env.RAZORPAY_KEY_ID;
      const keySecret = process.env.RAZORPAY_KEY_SECRET;

      if (!keyId || !keySecret) {
        strapi.log.error("Razorpay credentials are missing.");
        return ctx.internalServerError(
          "Payment verification is not configured."
        );
      }

      const {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
      } = ctx.request.body ?? {};

      if (
        typeof razorpay_order_id !== "string" ||
        typeof razorpay_payment_id !== "string" ||
        typeof razorpay_signature !== "string" ||
        !/^[a-f0-9]{64}$/i.test(razorpay_signature)
      ) {
        return ctx.badRequest("Invalid Razorpay payment details.");
      }

      const payment = await strapi.db.query(PAYMENT_UID).findOne({
        where: { razorpayOrderId: razorpay_order_id },
        populate: { client_detail: true },
      });

      if (!payment) {
        return ctx.notFound("Membership payment not found.");
      }

      // TODO: Verify that this payment belongs to the authenticated client.
      // Add this ownership check using your actual client-detail/user relation
      // before allowing production use.

      if (payment.paymentStatus === "paid") {
        if (payment.razorpayPaymentId === razorpay_payment_id) {
          return ctx.send({
            message: "Payment has already been verified.",
          });
        }

        return ctx.badRequest("This order has already been paid.");
      }

      if (payment.paymentStatus !== "pending") {
        return ctx.badRequest("This payment is not pending.");
      }

      const expectedSignature = crypto
        .createHmac("sha256", keySecret)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest("hex");

      const received = Buffer.from(razorpay_signature, "hex");
      const expected = Buffer.from(expectedSignature, "hex");

      if (
        received.length !== expected.length ||
        !crypto.timingSafeEqual(received, expected)
      ) {
        return ctx.badRequest("Invalid payment signature.");
      }

      const razorpay = new Razorpay({
        key_id: keyId,
        key_secret: keySecret,
      });

      const rpPayment = await razorpay.payments.fetch(
        razorpay_payment_id
      );

      if (
        rpPayment.order_id !== razorpay_order_id ||
        rpPayment.status !== "captured" ||
        rpPayment.amount !== Math.round(Number(payment.amount) * 100) ||
        rpPayment.currency !== payment.currency
      ) {
        return ctx.badRequest(
          "Payment is not captured or does not match the order."
        );
      }

      await strapi.db.query(PAYMENT_UID).update({
        where: { id: payment.id },
        data: {
          razorpayPaymentId: razorpay_payment_id,
          paymentStatus: "paid",
        },
      });

      return ctx.send({
        message: "Payment verified successfully.",
        subscriptionActivated: false,
      });
    } catch (error) {
      strapi.log.error(
        "Membership payment verification failed:",
        error
      );

      return ctx.internalServerError(
        "Unable to verify membership payment."
      );
    }
  },
};
