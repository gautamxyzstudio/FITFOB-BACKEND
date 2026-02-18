import {
  CognitoIdentityProviderClient,
  AdminSetUserPasswordCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const client = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION!,
});

export const cognitoForceChangePassword = async (
  username: string,
  newPassword: string
) => {
  const command = new AdminSetUserPasswordCommand({
    UserPoolId: process.env.COGNITO_USER_POOL_ID!,
    Username: username,
    Password: newPassword,
    Permanent: true,
  });

  await client.send(command);
};
