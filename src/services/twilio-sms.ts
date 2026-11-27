import Twilio from "twilio";

const client = Twilio(
  process.env.TWILIO_ACCOUNT_SID as string,
  process.env.TWILIO_AUTH_TOKEN as string,
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

export const sendTwilioOfflineMemberInvite = async (
  payload: TwilioInvitePayload,
) => {
  const {
    phone,
    memberName,
    gymName,
    planName,
    expiryDate,
    inviteLink,
    channel = "both",
  } = payload;

  const validPhone = phone.startsWith("+")
    ? phone
    : `+91${phone.replace(/\D/g, "").slice(-10)}`;
  const cleanExpiry = expiryDate ? ` (Valid till: ${expiryDate})` : "";
  const messageBody = `Hi ${memberName}! Good news: ${gymName} has linked your ${planName} membership to Fitfob${cleanExpiry}. Claim your digital gym entry pass here: ${inviteLink}`;

  const results: { smsSent: boolean; whatsappSent: boolean; errors: string[] } =
    {
      smsSent: false,
      whatsappSent: false,
      errors: [],
    };

  const rawWhatsapp =
    process.env.TWILIO_WHATSAPP_NUMBER ||
    process.env.TWILIO_WHATSAPP_FROM ||
    process.env.TWILIO_PHONE_NUMBER;

  const whatsappFrom = rawWhatsapp
    ? rawWhatsapp.startsWith("whatsapp:")
      ? rawWhatsapp
      : `whatsapp:${rawWhatsapp}`
    : null;

  const smsFrom = process.env.TWILIO_PHONE_NUMBER || null;

  // 1. If channel is "both": both SMS and WhatsApp are required.
  // We execute WhatsApp first because WhatsApp has stricter delivery constraints (Twilio sandbox opt-in '+14155238886' or business template).
  // If WhatsApp fails, we DO NOT send SMS so no orphan invite link is delivered to the customer when the subscription will not be created.
  if (channel === "both") {
    // Upfront check for environment configurations
    if (!smsFrom) {
      results.errors.push("TWILIO_PHONE_NUMBER is not set");
    }
    if (!whatsappFrom) {
      results.errors.push("TWILIO_WHATSAPP_NUMBER is not set");
    }
    if (results.errors.length > 0) {
      return results;
    }

    // Attempt WhatsApp first
    try {
      await client.messages.create({
        body: messageBody,
        from: whatsappFrom,
        to: `whatsapp:${validPhone}`,
      });
      results.whatsappSent = true;
      strapi.log.info(
        `[Twilio WhatsApp] Invite sent successfully to ${validPhone}`,
      );
    } catch (waError: any) {
      const errMsg = waError?.message || "Failed to send WhatsApp message";
      strapi.log.warn(
        `[Twilio WhatsApp] Failed to send invite to ${validPhone}:`,
        errMsg,
      );
      results.errors.push(`WhatsApp: ${errMsg}`);
      if (rawWhatsapp && rawWhatsapp.includes("+14155238886")) {
        results.errors.push(
          "Notice: Twilio Sandbox (+14155238886) requires recipient to join first, or send via channel 'sms'.",
        );
      }
      // CRITICAL: Abort SMS delivery so that no partial invite link is delivered to the customer
      results.errors.push(
        "SMS invite was cancelled because WhatsApp delivery failed (preventing orphan invite link delivery).",
      );
      return results;
    }

    // WhatsApp succeeded, now attempt SMS
    try {
      await client.messages.create({
        body: messageBody,
        from: smsFrom,
        to: validPhone,
      });
      results.smsSent = true;
      strapi.log.info(
        `[Twilio SMS] Invite sent successfully to ${validPhone}`,
      );
    } catch (smsError: any) {
      strapi.log.warn(
        `[Twilio SMS] Failed to send invite to ${validPhone}:`,
        smsError?.message || smsError,
      );
      results.errors.push(`SMS: ${smsError?.message || "Failed to send SMS"}`);
    }

    return results;
  }

  // 2. If channel is "sms" only
  if (channel === "sms") {
    if (!smsFrom) {
      results.errors.push("TWILIO_PHONE_NUMBER is not set");
      return results;
    }
    try {
      await client.messages.create({
        body: messageBody,
        from: smsFrom,
        to: validPhone,
      });
      results.smsSent = true;
      strapi.log.info(
        `[Twilio SMS] Invite sent successfully to ${validPhone}`,
      );
    } catch (smsError: any) {
      strapi.log.warn(
        `[Twilio SMS] Failed to send invite to ${validPhone}:`,
        smsError?.message || smsError,
      );
      results.errors.push(`SMS: ${smsError?.message || "Failed to send SMS"}`);
    }
    return results;
  }

  // 3. If channel is "whatsapp" only
  if (channel === "whatsapp") {
    if (!whatsappFrom) {
      results.errors.push("TWILIO_WHATSAPP_NUMBER is not set");
      return results;
    }
    try {
      await client.messages.create({
        body: messageBody,
        from: whatsappFrom,
        to: `whatsapp:${validPhone}`,
      });
      results.whatsappSent = true;
      strapi.log.info(
        `[Twilio WhatsApp] Invite sent successfully to ${validPhone}`,
      );
    } catch (waError: any) {
      const errMsg = waError?.message || "Failed to send WhatsApp message";
      strapi.log.warn(
        `[Twilio WhatsApp] Failed to send invite to ${validPhone}:`,
        errMsg,
      );
      results.errors.push(`WhatsApp: ${errMsg}`);
      if (rawWhatsapp && rawWhatsapp.includes("+14155238886")) {
        results.errors.push(
          "Notice: Twilio Sandbox (+14155238886) requires recipient to join first, or send via channel 'sms'.",
        );
      }
    }
    return results;
  }

  return results;
};
