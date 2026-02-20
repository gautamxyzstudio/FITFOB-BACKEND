import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const cognito = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION,
});

export const checkCognitoUser = async (username: string) => {
  try {
    await cognito.send(
      new AdminGetUserCommand({
        UserPoolId: process.env.COGNITO_USER_POOL_ID as string,
        Username: username,
      })
    );
    return true; // user exists
  } catch (err: any) {
    if (err.name === "UserNotFoundException") return false;
    throw err;
  }
};