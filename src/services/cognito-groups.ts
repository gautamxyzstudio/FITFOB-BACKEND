import {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const client = new CognitoIdentityProviderClient({
  region: process.env.COGNITO_REGION,
});

/**
 * Adds a user to a Cognito group
 */
export const addUserToCognitoGroup = async (
  username: string,
  role: string
) => {
  try {
    let groupName = "Member_users"; // default

    if (role === "Admin") groupName = "Admin_users";
    else if (role === "ClubOwner") groupName = "ClubOwner_users";
    else if (role === "Client") groupName = "Member_users";

    const command = new AdminAddUserToGroupCommand({
      UserPoolId: process.env.COGNITO_USER_POOL_ID!,
      Username: username,
      GroupName: groupName,
    });

    await client.send(command);

    strapi.log.info(`User ${username} added to Cognito group ${groupName}`);
  } catch (error) {
    strapi.log.error("COGNITO GROUP ASSIGN ERROR");
    strapi.log.error(error);
  }
};