import jwt from "jsonwebtoken";
import jwkToPem from "jwk-to-pem";
import axios from "axios";

let pems: any = null;

async function getPems() {
  if (pems) return pems;

  const url = `https://cognito-idp.${process.env.AWS_REGION}.amazonaws.com/${process.env.COGNITO_USER_POOL_ID}/.well-known/jwks.json`;

  const { data } = await axios.get(url);

  pems = {};
  data.keys.forEach((key: any) => {
    pems[key.kid] = jwkToPem(key);
  });

  return pems;
}

/**
 * STRAPI V5 MIDDLEWARE FORMAT
 */
export default (config, { strapi }) => {
  return async (ctx, next) => {

    const authHeader = ctx.request.header.authorization;

    // allow public routes
    if (!authHeader) {
      return next();
    }

    const token = authHeader.split(" ")[1];
    if (!token) return ctx.unauthorized("Invalid token");

    try {
      const decodedHeader: any = jwt.decode(token, { complete: true });
      if (!decodedHeader) return ctx.unauthorized("Invalid token");

      const pems = await getPems();
      const pem = pems[decodedHeader.header.kid];

      const verified: any = jwt.verify(token, pem);

      const user = await strapi.db
        .query("plugin::users-permissions.user")
        .findOne({
          where: { cognitoSub: verified.sub },
          populate: ["role"],
        });

      if (!user) return ctx.unauthorized("User not found");

      // Attach user to request
      ctx.state.user = user;

      await next();

    } catch (err) {
      return ctx.unauthorized("Token verification failed");
    }
  };
};
