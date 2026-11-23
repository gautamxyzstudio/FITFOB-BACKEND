import Twilio from "twilio";

const client = Twilio(
  process.env.TWILIO_ACCOUNT_SID as string,
  process.env.TWILIO_AUTH_TOKEN as string
);

export const sendTwilioOtp = async (phone: string, otp: string) => {
  try {
    await client.messages.create({
      body: `Your FitFob OTP is ${otp}. It is valid for 2 minutes.`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone, // MUST be +91XXXXXXXXXX
    });
  } catch (error) {
    strapi.log.error("TWILIO SMS ERROR");
    strapi.log.error(error);
    throw error;
  }
};

export interface TwilioInvitePayload {
  phone: string; // MUST be in international format (e.g. +91XXXXXXXXXX)
  memberName: string;
  gymName: string;
  planName: string;
  expiryDate?: string;
  inviteLink: string;
  channel?: "sms" | "whatsapp" | "both";
}

export const sendTwilioOfflineMemberInvite = async (payload: TwilioInvitePayload) => {
  const {
    phone,
    memberName,
    gymName,
    planName,
    expiryDate,
    inviteLink,
    channel = "both",
  } = payload;

  const validPhone = phone.startsWith("+") ? phone : `+91${phone.replace(/\D/g, "").slice(-10)}`;
  const cleanExpiry = expiryDate ? ` (Valid till: ${expiryDate})` : "";
  const messageBody = `Hi ${memberName}! Good news: ${gymName} has linked your ${planName} membership to Fitfob${cleanExpiry}. Claim your digital gym entry pass here: ${inviteLink}`;

  const results: { smsSent: boolean; whatsappSent: boolean; errors: string[] } = {
    smsSent: false,
    whatsappSent: false,
    errors: [],
  };

  // 1. Send SMS if requested
  if (channel === "sms" || channel === "both") {
    try {
      if (process.env.TWILIO_PHONE_NUMBER) {
        await client.messages.create({
          body: messageBody,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: validPhone,
        });
        results.smsSent = true;
        strapi.log.info(`[Twilio SMS] Invite sent successfully to ${validPhone}`);
      } else {
        results.errors.push("TWILIO_PHONE_NUMBER is not set");
      }
    } catch (smsError: any) {
      strapi.log.warn(`[Twilio SMS] Failed to send invite to ${validPhone}:`, smsError?.message || smsError);
      results.errors.push(`SMS: ${smsError?.message || "Failed to send SMS"}`);
    }
  }

  // 2. Send WhatsApp if requested
  if (channel === "whatsapp" || channel === "both") {
    try {
      const whatsappFrom =
        process.env.TWILIO_WHATSAPP_FROM ||
        (process.env.TWILIO_PHONE_NUMBER?.startsWith("whatsapp:")
          ? process.env.TWILIO_PHONE_NUMBER
          : `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`);

      if (whatsappFrom) {
        await client.messages.create({
          body: messageBody,
          from: whatsappFrom,
          to: `whatsapp:${validPhone}`,
        });
        results.whatsappSent = true;
        strapi.log.info(`[Twilio WhatsApp] Invite sent successfully to ${validPhone}`);
      } else {
        results.errors.push("Twilio WhatsApp sender is not set");
      }
    } catch (waError: any) {
      strapi.log.warn(`[Twilio WhatsApp] Failed to send invite to ${validPhone}:`, waError?.message || waError);
      results.errors.push(`WhatsApp: ${waError?.message || "Failed to send WhatsApp message"}`);
    }
  }

  return results;
};
