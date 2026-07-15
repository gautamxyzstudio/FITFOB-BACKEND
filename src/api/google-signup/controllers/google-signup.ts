import crypto from "crypto";

import { verifyGoogleToken } from "../services/google";
import { checkCognitoUser } from "../../../services/cognito-user-check";
import { createCognitoUser } from "../../../services/cognito-provision";
import { cognitoLogin } from "../../../services/cognito-auth";
import { addUserToCognitoGroup } from "../../../services/cognito-groups";
import { deleteCognitoUser } from "../../../services/cognito-delete";

const postLogs = (messages: string[]) => {
  setTimeout(() => {
    try {
      messages.forEach((m) => strapi.log.info(m));
    } catch (e) {
      console.error(e);
    }
  }, 0);
};

export default {

  async clientGoogleSignup(ctx: any) {
    try {
      const { idToken } = ctx.request.body;

      if (!idToken) {
        return ctx.badRequest("Google token is required.");
      }

      const role = "Client";
      const roleType = "client";

      const logs: string[] = [];

      /* ================= VERIFY GOOGLE ================= */

      const googleUser = await verifyGoogleToken(idToken);

      const email = googleUser.email;
      const username = email;

      logs.push(`[GOOGLE VERIFY] ${email}`);

      /* ================= EXISTING STRAPI USER ================= */

      const existingUser = await strapi.db
        .query("plugin::users-permissions.user")
        .findOne({
          where: { email },
        });

      if (existingUser) {
        return ctx.badRequest("User already exists. Please login.");
      }

      /* ================= EXISTING COGNITO USER ================= */

      const existsInCognito = await checkCognitoUser(email);

      if (existsInCognito) {
        return ctx.badRequest("User already exists in cognito. Please login.");
      }

      /* ================= STRAPI ROLE ================= */

      // const roles = await strapi.db
      //   .query("plugin::users-permissions.role")
      //   .findMany();

      // console.log("ROLES:", roles);

      /* ================= STRAPI ROLE ================= */

      const strapiRole = await strapi.db
        .query("plugin::users-permissions.role")
        .findOne({
          where: {
            type: roleType,
          },
        });

      console.log("FOUND ROLE:", strapiRole);

      if (!strapiRole) {
        return ctx.internalServerError(
          "Server role configuration error."
        );
      }

      /* ================= RANDOM PASSWORD ================= */

      const password =
        `FitFob@${crypto.randomBytes(16).toString("hex")}A1`;

      /* ================= COGNITO CREATE ================= */

      let cognitoSub: string;

      try {
        const result = await createCognitoUser(
          email,
          password,
          username,
          false
        );

        cognitoSub = result.sub;

        logs.push(...result.logs);

        const groupResult = await addUserToCognitoGroup(
          cognitoSub,
          role
        );

        logs.push(...groupResult.logs);

        logs.push("COGNITO USER CREATED ✔");
        logs.push("GROUP ASSIGNED ✔ → Member_users");
      } catch (err: any) {
        strapi.log.error("COGNITO ERROR:", err);

        /* ---------- rollback cognito user ---------- */

        try {
          await deleteCognitoUser(email);
          logs.push("COGNITO USER ROLLED BACK ✔");
        } catch (rollbackErr) {
          strapi.log.error(
            "COGNITO ROLLBACK FAILED:",
            rollbackErr
          );
        }

        return ctx.internalServerError(
          err?.name ||
          err?.message ||
          "Unable to create Cognito user."
        );
      }

      /* ================= CREATE STRAPI USER ================= */

      const userService =
        strapi.plugin("users-permissions").service("user");

      let user: any;

      try {
        user = await userService.add({
          username,
          email,
          password,
          confirmed: true,
          provider: "local",
          role: strapiRole.id,
        });
      } catch (err) {
        await deleteCognitoUser(email).catch((rollbackErr) => {
          strapi.log.error(
            "COGNITO ROLLBACK FAILED:",
            rollbackErr
          );
        });

        throw err;
      }

      /* ================= UPDATE USER ================= */

      try {
        await strapi.db
          .query("plugin::users-permissions.user")
          .update({
            where: {
              id: user.id,
            },
            data: {
              cognitoSub,
              isVerified: false,
              verification_status: "pending",
            },
          });
      } catch (err) {
        await strapi.db
          .query("plugin::users-permissions.user")
          .delete({
            where: {
              id: user.id,
            },
          });

        await deleteCognitoUser(email).catch((rollbackErr) => {
          strapi.log.error(
            "COGNITO ROLLBACK FAILED:",
            rollbackErr
          );
        });

        throw err;
      }

      logs.push("STRAPI USER CREATED ✔");

      /* ================= LOGIN ================= */

      let tokens;

      try {
        tokens = await cognitoLogin(email, password);
      } catch (err) {
        /* ---------- rollback strapi user ---------- */

        await strapi.db
          .query("plugin::users-permissions.user")
          .delete({
            where: {
              id: user.id,
            },
          });

        /* ---------- rollback cognito user ---------- */

        await deleteCognitoUser(email).catch((rollbackErr) => {
          strapi.log.error(
            "COGNITO ROLLBACK FAILED:",
            rollbackErr
          );
        });

        return ctx.internalServerError(
          "Account created but login failed. Please try again."
        );
      }

      /* ================= JWT ================= */

      const jwtService = strapi
        .plugin("users-permissions")
        .service("jwt");

      const jwt = jwtService.issue({
        id: user.id,
      });

      /* ================= USER ================= */

      const fullUser = await strapi.db
        .query("plugin::users-permissions.user")
        .findOne({
          where: {
            id: user.id,
          },
          populate: ["role"],
        });

      /* ================= RESPONSE ================= */

      ctx.body = {
        jwt,
        cognito: {
          accessToken: tokens.AccessToken,
          idToken: tokens.IdToken,
          refreshToken: tokens.RefreshToken,
          expiresIn: tokens.ExpiresIn,
        },
        user: {
          id: fullUser.id,
          username: fullUser.username,
          email: fullUser.email,
          isVerified: fullUser.isVerified,
          verification_status: fullUser.verification_status,
          cognitoSub: fullUser.cognitoSub,
          confirmed: fullUser.confirmed,
          blocked: fullUser.blocked,
          role: fullUser.role,
        },
      };

      logs.push(`[GOOGLE CLIENT SIGNUP SUCCESS] ${email}`);

      postLogs(logs);
    } catch (err: any) {
      strapi.log.error("GOOGLE CLIENT SIGNUP ERROR:", err);

      return ctx.internalServerError({
        message: err?.message || "Google signup failed",
      });
    }
  },

  async clubOwnerGoogleSignup(ctx: any) {
    try {
      const { idToken } = ctx.request.body;

      if (!idToken) {
        return ctx.badRequest("Google token is required.");
      }

      const role = "clubowner";


      const logs: string[] = [];

      /* ================= VERIFY GOOGLE ================= */

      const googleUser = await verifyGoogleToken(idToken);

      const email = googleUser.email;

      const username = email;

      logs.push(`[GOOGLE VERIFY] ${email}`);

      /* ================= EXISTING STRAPI USER ================= */

      const existingUser = await strapi.db
        .query("plugin::users-permissions.user")
        .findOne({
          where: { email },
        });

      if (existingUser) {
        return ctx.badRequest("User already exists. Please login.");
      }

      /* ================= EXISTING COGNITO USER ================= */

      const existsInCognito = await checkCognitoUser(email);

      if (existsInCognito) {
        return ctx.badRequest("User already exists in cognito. Please login.");
      }

      /* ================= RANDOM PASSWORD ================= */

      const password =
        `FitFob@${crypto.randomBytes(16).toString("hex")}A1`;

      /* ================= COGNITO CREATE ================= */

      let cognitoSub: string;

      try {
        const result = await createCognitoUser(
          email,
          password,
          username,
          false
        );

        cognitoSub = result.sub;

        logs.push(...result.logs);

        const groupResult = await addUserToCognitoGroup(
          cognitoSub,
          role
        );

        logs.push(...groupResult.logs);

        logs.push("COGNITO USER CREATED ✔");

        const groupName = "ClubOwner_users";

        logs.push(`GROUP ASSIGNED ✔ → ${groupName}`);

      } catch (err: any) {
        console.error(
          "COGNITO ERROR:",
          JSON.stringify(err, null, 2)
        );

        strapi.log.error("COGNITO ERROR:", err);

        return ctx.internalServerError(
          err?.name ||
          err?.message ||
          "Unable to create Cognito user."
        );
      }

      /* ================= STRAPI ROLE ================= */

      const roleType = "clubowner";

      // const roles = await strapi.db
      //   .query("plugin::users-permissions.role")
      //   .findMany();

      // console.log("ROLES:", roles);

      /* ================= STRAPI ROLE ================= */

      const strapiRole = await strapi.db
        .query("plugin::users-permissions.role")
        .findOne({
          where: {
            type: roleType,
          },
        });

      console.log("FOUND ROLE:", strapiRole);

      if (!strapiRole) {
        await deleteCognitoUser(email);

        return ctx.internalServerError(
          "Server role configuration error."
        );
      }


      /* ================= CREATE STRAPI USER ================= */

      const userService =
        strapi.plugin("users-permissions").service("user");

      let user;

      try {
        user = await userService.add({
          username,
          email,
          password,
          confirmed: true,
          provider: "local",
          role: strapiRole.id,
        });
      } catch (err) {
        await deleteCognitoUser(email);

        throw err;
      }

      try {

        await strapi.db
          .query("plugin::users-permissions.user")
          .update({
            where: {
              id: user.id,
            },
            data: {
              cognitoSub,
              isVerified: false,
              verification_status: "pending",
            },
          });

      } catch (err) {
        await strapi.db.query("plugin::users-permissions.user").delete({
          where: {
            id: user.id,
          },
        });

        await deleteCognitoUser(email);

        throw err;
      }

      logs.push("STRAPI USER CREATED ✔");

      /* ================= LOGIN ================= */

      let tokens;

      try {
        tokens = await cognitoLogin(email, password);
      } catch (err) {
        /* ---------- rollback strapi user ---------- */

        await strapi.db.query("plugin::users-permissions.user").delete({
          where: {
            id: user.id,
          },
        });

        return ctx.internalServerError(
          "Account created but login failed. Please try again."
        );
      }

      /* ================= JWT ================= */

      const jwtService = strapi
        .plugin("users-permissions")
        .service("jwt");

      const jwt = jwtService.issue({
        id: user.id,
      });

      /* ================= USER ================= */

      const fullUser = await strapi.db
        .query("plugin::users-permissions.user")
        .findOne({
          where: {
            id: user.id,
          },
          populate: ["role"],
        });

      /* ================= RESPONSE ================= */

      ctx.body = {
        jwt,
        cognito: {
          accessToken: tokens.AccessToken,
          idToken: tokens.IdToken,
          refreshToken: tokens.RefreshToken,
          expiresIn: tokens.ExpiresIn,
        },
        user: {
          id: fullUser.id,
          username: fullUser.username,
          email: fullUser.email,
          isVerified: fullUser.isVerified,
          verification_status: fullUser.verification_status,
          cognitoSub: fullUser.cognitoSub,
          confirmed: fullUser.confirmed,
          blocked: fullUser.blocked,
          role: fullUser.role,
        },
      };

      logs.push(`[GOOGLE CLUBOWNER SIGNUP SUCCESS] ${email}`);

      postLogs(logs);
    } catch (err: any) {
      strapi.log.error("GOOGLE SIGNUP ERROR:", err);

      return ctx.internalServerError({
        message: err?.message || "Google signup failed",
        stack: err?.stack,
      });
    }
  },
};