import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import crypto from "crypto";

const client = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION!,
});

/* =====================================================
   GENERATE SECRET HASH (REQUIRED FOR CLIENT SECRET)
===================================================== */

const generateSecretHash = (username: string) => {
  if (!process.env.COGNITO_CLIENT_SECRET) {
    throw new Error("COGNITO_CLIENT_SECRET missing in .env");
  }

  return crypto
    .createHmac("sha256", process.env.COGNITO_CLIENT_SECRET)
    .update(username + process.env.COGNITO_CLIENT_ID)
    .digest("base64");
};

/* =====================================================
   LOGIN
===================================================== */

export const cognitoLogin = async (identifier: string, password: string) => {
  try {

    const secretHash = generateSecretHash(identifier);

    const command = new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: process.env.COGNITO_CLIENT_ID!,
      AuthParameters: {
        USERNAME: identifier,
        PASSWORD: password,
        SECRET_HASH: secretHash, // ⭐ THIS WAS MISSING
      },
    });

    const response = await client.send(command);

    if (!response.AuthenticationResult) {
      throw new Error("Authentication failed");
    }

    return response.AuthenticationResult;

  } catch (err: any) {
    console.error("COGNITO LOGIN FAILED", {
      identifier,
      clientId: process.env.COGNITO_CLIENT_ID,
      region: process.env.AWS_REGION,
      message: err?.message,
    });

    throw err;
  }
};
