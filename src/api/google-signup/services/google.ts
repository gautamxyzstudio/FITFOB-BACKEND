import { OAuth2Client } from "google-auth-library";

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

export type GoogleUser = {
  email: string;
  firstName: string;
  lastName: string;
  fullName: string;
  picture: string | null;
};

export const verifyGoogleToken = async (
  idToken: string
): Promise<GoogleUser> => {
  const ticket = await client.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();

  if (!payload) {
    throw new Error("Invalid Google token");
  }

  if (!payload.email) {
    throw new Error("Google account does not have an email address.");
  }

  if (!payload.email_verified) {
    throw new Error("Google email is not verified.");
  }

  return {
    email: payload.email.toLowerCase(),
    firstName: payload.given_name || "",
    lastName: payload.family_name || "",
    fullName:
      payload.name ||
      `${payload.given_name || ""} ${payload.family_name || ""}`.trim(),
    picture: payload.picture || null,
  };
};