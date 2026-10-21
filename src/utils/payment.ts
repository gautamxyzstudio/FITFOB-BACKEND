
import Razorpay from "razorpay";

const PAYMENT_UID = "api::membership-payment.membership-payment";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

type CreateMembershipOrderParams = {
  amountRupees: number;
  clientId: number;
  clientDocumentId?: string;
  planDocumentId?: string;
  subscriptionType: "local" | "outdoor";
};

export async function createMembershipOrder(
  params: CreateMembershipOrderParams,
) {
  const {
    amountRupees,
    clientId,
    clientDocumentId,
    planDocumentId,
    subscriptionType,
  } = params;

  if (!Number.isFinite(amountRupees) || amountRupees <= 0) {
    throw new Error("Invalid membership plan price.");
  }

  if (
    !process.env.RAZORPAY_KEY_ID ||
    !process.env.RAZORPAY_KEY_SECRET
  ) {
    throw new Error("Razorpay credentials are not configured.");
  }

  // Razorpay expects the amount in paise.
  const amountPaise = Math.round(amountRupees * 100);

  // Create a Razorpay Payment Link instead of an Order.
 const paymentLink = await (razorpay as any).paymentLink.create({
    amount: amountPaise,
    currency: "INR",
    reference_id: `${subscriptionType}_${Date.now()}`,
    description: `${subscriptionType} membership payment`,
    reminder_enable: false,
    notes: {
      clientDocumentId: clientDocumentId || "",
      planDocumentId: planDocumentId || "",
      subscriptionType,
    },
  });

  // Save the payment as pending until payment is verified.
  const payment = await strapi.entityService.create(PAYMENT_UID, {
    data: {
      razorpayPaymentLinkId: paymentLink.id,
      amount: amountRupees,
      currency: "INR",
      paymentStatus: "pending",
      subscriptionType,
      client_detail: clientId,
      ...(subscriptionType === "local"
        ? { localPlanDocumentId: planDocumentId }
        : { outdoorPlanDocumentId: planDocumentId }),
    },
  });

  return {
    paymentId: payment.id,
    razorpayPaymentLinkId: paymentLink.id,
    paymentUrl: paymentLink.short_url,
    amount: amountRupees,
    amountPaise,
    currency: "INR",
    subscriptionType,
  };
}