
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
  localPlanDocumentId?: string;
  outdoorPlanDocumentId?: string;
  subscriptionType: "local" | "outdoor" | "both";
};

export async function createMembershipOrder(
  params: CreateMembershipOrderParams,
) {
  const {
    amountRupees,
    clientId,
    clientDocumentId,
    localPlanDocumentId,
    outdoorPlanDocumentId,
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

  if (subscriptionType === "local" && !localPlanDocumentId) {
    throw new Error("Local membership plan is required.");
  }

  if (subscriptionType === "outdoor" && !outdoorPlanDocumentId) {
    throw new Error("Outdoor membership plan is required.");
  }

  if (
    subscriptionType === "both" &&
    (!localPlanDocumentId || !outdoorPlanDocumentId)
  ) {
    throw new Error(
      "Both local and outdoor membership plans are required.",
    );
  }

  const amountPaise = Math.round(amountRupees * 100);

  const paymentLink = await (razorpay as any).paymentLink.create({
    amount: amountPaise,
    currency: "INR",
    reference_id: `${subscriptionType}_${Date.now()}`,
    description:
      subscriptionType === "both"
        ? "Local and outdoor membership payment"
        : `${subscriptionType} membership payment`,
    reminder_enable: false,
    expire_by: Math.floor(Date.now() / 1000) + 16 * 60,
    notes: {
      clientDocumentId: clientDocumentId || "",
      localPlanDocumentId: localPlanDocumentId || "",
      outdoorPlanDocumentId: outdoorPlanDocumentId || "",
      subscriptionType,
    },
  });

  const payment = await strapi.entityService.create(PAYMENT_UID, {
    data: {
      razorpayPaymentLinkId: paymentLink.id,
      amount: amountRupees,
      currency: "INR",
      paymentStatus: "pending",
      subscriptionType,
      client_detail: clientId,
      ...(localPlanDocumentId ? { localPlanDocumentId } : {}),
      ...(outdoorPlanDocumentId ? { outdoorPlanDocumentId } : {}),
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
