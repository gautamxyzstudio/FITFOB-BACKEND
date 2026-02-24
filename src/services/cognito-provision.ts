import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";

type CognitoProvisionResult = {
  sub: string;
  logs: string[];
};

const client = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION!,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

const formatPhone = (phone: string) =>
  phone.startsWith("+") ? phone : `+91${phone}`;

export const createCognitoUser = async (
  identifier: string,
  password: string,
  username: string,
  isPhone: boolean,
): Promise<CognitoProvisionResult> => {

  const logs: string[] = [];
  const log = (m: string) => logs.push(m);

  log("===== COGNITO PROVISION START =====");

  let attributes: any[];

  if (isPhone) {
    const formatted = formatPhone(identifier);
    log(`PHONE USER: ${formatted}`);

    attributes = [
      { Name: "phone_number", Value: formatted },
      { Name: "phone_number_verified", Value: "true" },
      { Name: "name", Value: username },
    ];
  } else {
    log(`EMAIL USER: ${identifier}`);

    attributes = [
      { Name: "email", Value: identifier },
      { Name: "email_verified", Value: "true" },
      { Name: "name", Value: username },
    ];
  }

  await client.send(
    new AdminCreateUserCommand({
      UserPoolId: process.env.COGNITO_USER_POOL_ID!,
      Username: identifier,
      MessageAction: "SUPPRESS",
      UserAttributes: attributes,
    }),
  );

  log("Cognito user created");

  await client.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: process.env.COGNITO_USER_POOL_ID!,
      Username: identifier,
      Password: password,
      Permanent: true,
    }),
  );

  log("Password synced with Cognito");

  const userData = await client.send(
    new AdminGetUserCommand({
      UserPoolId: process.env.COGNITO_USER_POOL_ID!,
      Username: identifier,
    }),
  );

  const subAttr = userData.UserAttributes?.find((a) => a.Name === "sub");
  const cognitoSub = subAttr?.Value;

  log(`Cognito SUB: ${cognitoSub}`);
  log("===== COGNITO PROVISION END =====");

  return {
    sub: cognitoSub!,
    logs,
  };
};