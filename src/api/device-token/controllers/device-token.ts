import { factories } from "@strapi/strapi";
import { sendPushNotification }
    from "../../../utils/push-notification";
const DEVICE_TOKEN_UID = "api::device-token.device-token" as any;

export default factories.createCoreController(
    "api::device-token.device-token",
    ({ strapi }) => ({

        async register(ctx) {
            try {
                const user = ctx.state.user;

                if (!user) {
                    return ctx.unauthorized("Login required");
                }

                const {
                    token,
                    platform,
                } = ctx.request.body as {
                    token?: string;
                    platform?: "web" | "android" | "ios";
                };

                /* ================= VALIDATION ================= */

                if (!token?.trim()) {
                    return ctx.badRequest("Device token is required");
                }

                const allowedPlatforms = ["web", "android", "ios"];

                if (!platform || !allowedPlatforms.includes(platform)) {
                    return ctx.badRequest(
                        "Platform must be web, android, or ios"
                    );
                }

                const normalizedToken = token.trim();

                /* ================= FIND EXISTING TOKEN ================= */

                const existingToken = await strapi.db
                    .query(DEVICE_TOKEN_UID)
                    .findOne({
                        where: {
                            token: normalizedToken,
                        },
                    });

                /* ================= UPDATE EXISTING ================= */

                if (existingToken) {
                    const updatedToken = await strapi.db
                        .query(DEVICE_TOKEN_UID)
                        .update({
                            where: {
                                id: existingToken.id,
                            },

                            data: {
                                users_permissions_user: user.id,
                                platform,
                                isActive: true,
                                lastUsedAt: new Date(),
                            },

                            populate: {
                                users_permissions_user: true,
                            },
                        });

                    return ctx.send({
                        message: "Device token updated successfully",
                        data: updatedToken,
                    });
                }

                /* ================= CREATE NEW ================= */

                const createdToken = await strapi.db
                    .query(DEVICE_TOKEN_UID)
                    .create({
                        data: {
                            users_permissions_user: user.id,
                            token: normalizedToken,
                            platform,
                            isActive: true,
                            lastUsedAt: new Date(),
                            publishedAt: new Date(),
                        },

                        populate: {
                            users_permissions_user: true,
                        },
                    });

                return ctx.send(
                    {
                        message: "Device token registered successfully",
                        data: createdToken,
                    },
                    201
                );
            } catch (error) {
                strapi.log.error(
                    "Device token registration failed",
                    error
                );

                return ctx.internalServerError(
                    "Failed to register device token"
                );
            }
        },

        async unregister(ctx) {
            try {
                const user = ctx.state.user;

                if (!user) {
                    return ctx.unauthorized("Login required");
                }

                const { token } = ctx.request.body as {
                    token?: string;
                };

                if (!token?.trim()) {
                    return ctx.badRequest("Device token is required");
                }

                const existingToken = await strapi.db
                    .query(DEVICE_TOKEN_UID)
                    .findOne({
                        where: {
                            token: token.trim(),
                            users_permissions_user: user.id,
                        },
                    });

                if (!existingToken) {
                    return ctx.notFound("Device token not found");
                }

                await strapi.db
                    .query(DEVICE_TOKEN_UID)
                    .update({
                        where: {
                            id: existingToken.id,
                        },

                        data: {
                            isActive: false,
                            lastUsedAt: new Date(),
                        },
                    });

                return ctx.send({
                    message: "Device unregistered successfully",
                });
            } catch (error) {
                strapi.log.error(
                    "Device token unregister failed",
                    error
                );

                return ctx.internalServerError(
                    "Failed to unregister device"
                );
            }
        },

        async testPush(ctx) {
            try {
                const user = ctx.state.user;

                if (!user) {
                    return ctx.unauthorized("Login required");
                }

                const result = await sendPushNotification(
                    user.id,
                    {
                        title: "FITFOB Test Notification",

                        body:
                            "Push notifications are working successfully!",

                        data: {
                            type: "test",
                        },
                    }
                );

                return ctx.send({
                    message: "Push notification processed",
                    result,
                });
            } catch (error) {
                strapi.log.error(
                    "Test push notification failed",
                    error
                );

                return ctx.internalServerError(
                    "Failed to send test notification"
                );
            }
        }

    })
);