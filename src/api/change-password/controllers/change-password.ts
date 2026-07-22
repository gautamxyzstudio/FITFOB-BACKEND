import bcrypt from "bcryptjs";
import { cognitoForceChangePassword } from "../../../services/cognito-reset";

export default {

    async changePassword(ctx) {
        let identifier = "UNKNOWN";

        try {
            /* =====================================================
               STEP 1 — AUTHENTICATED USER
            ===================================================== */
            const authUser = ctx.state.user;

            if (!authUser) {
                return ctx.unauthorized("Login required");
            }

            /* =====================================================
               STEP 2 — READ BODY
            ===================================================== */
            const body = ctx.request.body ?? {};

            const {
                oldPassword,
                newPassword,
            } = body;

            if (!oldPassword || !newPassword) {
                return ctx.badRequest(
                    "Old password and new password are required"
                );
            }

            if (oldPassword === newPassword) {
                return ctx.badRequest(
                    "New password must be different from old password"
                );
            }

            /* =====================================================
               STEP 3 — GET FULL USER WITH PASSWORD
            ===================================================== */
            const user = await strapi.db
                .query("plugin::users-permissions.user")
                .findOne({
                    where: {
                        id: authUser.id,
                    },
                    select: [
                        "id",
                        "email",
                        "phoneNumber",
                        "password",
                        "cognitoSub",
                    ],
                });

            if (!user) {
                return ctx.badRequest("User not found");
            }

            identifier =
                user.email ||
                user.phoneNumber ||
                String(user.id);

            if (!user.password) {
                return ctx.badRequest(
                    "Password is not configured for this account"
                );
            }

            if (!user.cognitoSub) {
                strapi.log.error(
                    `[CHANGE PASSWORD FAILED - COGNITO SUB MISSING] ${identifier}`
                );

                return ctx.internalServerError(
                    "Unable to change password. Please contact support."
                );
            }

            /* =====================================================
               STEP 4 — VERIFY OLD PASSWORD AGAINST STRAPI
            ===================================================== */
            const validOldPassword = await bcrypt.compare(
                oldPassword,
                user.password
            );

            if (!validOldPassword) {
                strapi.log.warn(
                    `[CHANGE PASSWORD BLOCKED - INVALID OLD PASSWORD] ${identifier}`
                );

                return ctx.badRequest(
                    "Old password is incorrect"
                );
            }

            /* =====================================================
               STEP 5 — CHANGE COGNITO PASSWORD FIRST
            ===================================================== */
            try {
                await cognitoForceChangePassword(
                    user.cognitoSub,
                    newPassword
                );

                strapi.log.info(
                    `[COGNITO PASSWORD CHANGE SUCCESS] ${identifier}`
                );
            } catch (cognitoErr) {

                /*
                 * Cognito failed.
                 *
                 * Strapi has NOT been changed yet,
                 * so both systems still have oldPassword.
                 */

                strapi.log.error(
                    `[COGNITO PASSWORD CHANGE FAILED] ${identifier}`,
                    cognitoErr
                );

                return ctx.internalServerError(
                    "Unable to change password. Please try again."
                );
            }

            /* =====================================================
               STEP 6 — UPDATE STRAPI PASSWORD
            ===================================================== */
            try {

                const hashedPassword = await bcrypt.hash(
                    newPassword,
                    10
                );

                await strapi.db
                    .query("plugin::users-permissions.user")
                    .update({
                        where: {
                            id: user.id,
                        },
                        data: {
                            password: hashedPassword,
                        },
                    });

                strapi.log.info(
                    `[STRAPI PASSWORD CHANGE SUCCESS] ${identifier}`
                );

            } catch (dbErr) {

                /* ===================================================
                   STRAPI FAILED
          
                   Current state:
          
                   Cognito = NEW PASSWORD
                   Strapi  = OLD PASSWORD
          
                   Therefore rollback Cognito → OLD PASSWORD
                =================================================== */

                strapi.log.error(
                    `[STRAPI PASSWORD CHANGE FAILED] ${identifier}`,
                    dbErr
                );

                strapi.log.warn(
                    `[COGNITO PASSWORD ROLLBACK STARTED] ${identifier}`
                );

                try {

                    /* =================================================
                       ROLLBACK COGNITO TO OLD PASSWORD
                    ================================================= */

                    await cognitoForceChangePassword(
                        user.cognitoSub,
                        oldPassword
                    );

                    strapi.log.info(
                        `[COGNITO PASSWORD ROLLBACK SUCCESS] ${identifier}`
                    );

                    /*
                     * Final state:
                     *
                     * Cognito = OLD PASSWORD
                     * Strapi  = OLD PASSWORD
                     *
                     * Both systems are synchronized again.
                     */

                    return ctx.internalServerError(
                        "Unable to change password. Your old password is still active."
                    );

                } catch (rollbackErr) {

                    /* =================================================
                       CRITICAL CASE
            
                       Cognito changed to NEW password
                       Strapi still has OLD password
                       Rollback also failed
            
                       Systems are now out of sync.
                    ================================================= */

                    strapi.log.error(
                        `[CRITICAL] COGNITO PASSWORD ROLLBACK FAILED FOR ${identifier}`,
                        rollbackErr
                    );

                    return ctx.internalServerError(
                        "Password update failed and could not be rolled back. Please contact support."
                    );
                }
            }

            /* =====================================================
               STEP 7 — SUCCESS
            ===================================================== */

            strapi.log.info(
                `[PASSWORD CHANGE COMPLETED] ${identifier}`
            );

            return ctx.send({
                message: "Password changed successfully",
            });

        } catch (err) {

            strapi.log.error(
                `[CHANGE PASSWORD FATAL ERROR] ${identifier}`,
                err
            );

            return ctx.internalServerError(
                "Password change failed"
            );
        }
    }
}