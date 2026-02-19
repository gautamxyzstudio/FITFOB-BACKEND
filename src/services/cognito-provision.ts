import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const client = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION!,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

  console.log("AWS_ACCESS_KEY_ID:", process.env.AWS_ACCESS_KEY_ID);
  console.log("AWS_SECRET_ACCESS_KEY:", process.env.AWS_SECRET_ACCESS_KEY);
  console.log("AWS_REGION:", process.env.AWS_REGION);

const formatPhone = (phone: string) =>
  phone.startsWith("+") ? phone : `+91${phone}`;

export const createCognitoUser = async (
  identifier: string,
  password: string,
  username: string,
  isPhone: boolean,
) => {
  console.log("\n===== COGNITO PROVISION START =====");
  console.log("AWS_ACCESS_KEY_ID:", process.env.AWS_ACCESS_KEY_ID);
  console.log("AWS_SECRET_ACCESS_KEY:", process.env.AWS_SECRET_ACCESS_KEY);
  console.log("AWS_REGION:", process.env.AWS_REGION);

  let attributes: any[];

  if (isPhone) {
    const formatted = formatPhone(identifier);
    console.log("PHONE USER:", formatted);

    attributes = [
      { Name: "phone_number", Value: formatted },
      { Name: "phone_number_verified", Value: "true" },
      { Name: "name", Value: username },
    ];
  } else {
    console.log("EMAIL USER:", identifier);

    attributes = [
      { Name: "email", Value: identifier },
      { Name: "email_verified", Value: "true" },
      { Name: "name", Value: username },
    ];
  }

  // ---------- CREATE USER ----------
  await client.send(
    new AdminCreateUserCommand({
      UserPoolId: process.env.COGNITO_USER_POOL_ID!,
      Username: identifier,
      MessageAction: "SUPPRESS",
      UserAttributes: attributes,
    }),
  );

  console.log("Cognito user created");

  // ---------- SET PASSWORD ----------
  await client.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: process.env.COGNITO_USER_POOL_ID!,
      Username: identifier,
      Password: password,
      Permanent: true,
    }),
  );

  console.log("Password synced with Cognito");

  // ---------- FETCH REAL SUB ----------
  const userData = await client.send(
    new AdminGetUserCommand({
      UserPoolId: process.env.COGNITO_USER_POOL_ID!,
      Username: identifier,
    }),
  );

  const subAttr = userData.UserAttributes?.find((a) => a.Name === "sub");
  const cognitoSub = subAttr?.Value;

  console.log("Cognito SUB:", cognitoSub);
  console.log("===== COGNITO PROVISION END =====\n");

  return cognitoSub;
};
