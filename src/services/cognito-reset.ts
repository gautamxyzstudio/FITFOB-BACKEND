import {
  CognitoIdentityProviderClient,
  AdminSetUserPasswordCommand,
  AdminConfirmSignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const client = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION!,
});

export const cognitoForceChangePassword = async (
  username: string,
  newPassword: string
) => {

  /* 1️⃣ Always set password */
  await client.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: process.env.COGNITO_USER_POOL_ID!,
      Username: username,
      Password: newPassword,
      Permanent: true,
    })
  );

  /* 2️⃣ Try to confirm user (only if needed) */
  try {
    await client.send(
      new AdminConfirmSignUpCommand({
        UserPoolId: process.env.COGNITO_USER_POOL_ID!,
        Username: username,
      })
    );
  } catch (err: any) {

    // THIS IS THE IMPORTANT PART
    if (err.name === "NotAuthorizedException") {
      // user already confirmed → ignore
      return;
    }

    // other Cognito errors should still fail
    throw err;
  }
};