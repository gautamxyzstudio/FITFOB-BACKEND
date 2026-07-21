import {
  CognitoIdentityProviderClient,
  AdminDeleteUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const client = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION!,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

export const deleteCognitoUser = async (username: string) => {
  try {
    await client.send(
      new AdminDeleteUserCommand({
        UserPoolId: process.env.COGNITO_USER_POOL_ID!,
        Username: username,
      })
    );

    strapi.log.info(`COGNITO USER ROLLED BACK ✔ ${username}`);
  } catch (err: any) {
    if (err?.name === "UserNotFoundException") {
      return;
    }

    throw err;
  }
};