import {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";

type CognitoGroupResult = {
  logs: string[];
};

const client = new CognitoIdentityProviderClient({
  region: process.env.COGNITO_REGION,
});

/**
 * Adds a user to a Cognito group
 */
export const addUserToCognitoGroup = async (
  username: string,
  role: string
): Promise<CognitoGroupResult> => {

  const logs: string[] = [];
  const log = (msg: string) => logs.push(msg);

  let groupName = "Member_users";

  if (role === "Admin") groupName = "Admin_users";
  else if (role === "ClubOwner") groupName = "ClubOwner_users";
  else if (role === "Client") groupName = "Member_users";

  try {
    const command = new AdminAddUserToGroupCommand({
      UserPoolId: process.env.COGNITO_USER_POOL_ID!,
      Username: username,
      GroupName: groupName,
    });

    await client.send(command);

    log(`User ${username} added to Cognito group ${groupName}`);

  } catch (error) {
    log("COGNITO GROUP ASSIGN ERROR");
    log(String(error));
  }

  return { logs };
};