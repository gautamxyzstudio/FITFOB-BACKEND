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