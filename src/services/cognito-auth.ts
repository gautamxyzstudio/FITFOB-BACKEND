import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";

import crypto from "crypto";

/* =====================================================
   CLIENT
===================================================== */

const client = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION!,
});

/* =====================================================
   GENERATE SECRET HASH (ONLY IF CLIENT SECRET EXISTS)
===================================================== */

const generateSecretHash = (username: string) => {
  if (!process.env.COGNITO_CLIENT_SECRET) {
    throw new Error("COGNITO_CLIENT_SECRET missing in .env");
  }

  return crypto
    .createHmac("sha256", process.env.COGNITO_CLIENT_SECRET)
    .update(username + process.env.COGNITO_CLIENT_ID!) // 🔥 added !
    .digest("base64");
};

/* =====================================================
   LOGIN
===================================================== */

export const cognitoLogin = async (
  identifier: string,
  password: string
) => {
  try {
    const authParams: any = {
      USERNAME: identifier,
      PASSWORD: password,
    };

    // Only attach secret hash if client secret exists
    if (process.env.COGNITO_CLIENT_SECRET) {
      authParams.SECRET_HASH = generateSecretHash(identifier);
    }

    const command = new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: process.env.COGNITO_CLIENT_ID!,
      AuthParameters: authParams,
    });

    const response = await client.send(command);

    if (!response.AuthenticationResult) {
      throw new Error("Authentication failed");
    }

    return response.AuthenticationResult;

  } catch (err: any) {
    console.error("COGNITO LOGIN FAILED");
    console.error("Identifier:", identifier);
    console.error("ClientId:", process.env.COGNITO_CLIENT_ID);
    console.error("Region:", process.env.AWS_REGION);
    console.error("Error Name:", err?.name);
    console.error("Error Message:", err?.message);
    console.error("Full Error:", err);

    throw err;
  }
};