import { factories } from "@strapi/strapi";
import { sendPushNotification }
    from "../../../utils/push-notification";
const DEVICE_TOKEN_UID = "api::device-token.device-token" as any;

/* ---------- ROLE HELPER ---------- */
async function getUserRole(user: any): Promise<string> {
    if (!user) return "";
    if (user._cachedRole) return user._cachedRole;

    if (user.role?.name || user.role?.type) {
        const role =
            user.role.name?.toLowerCase().replace(/[\s_-]+/g, "") ||
            user.role.type?.toLowerCase().replace(/[\s_-]+/g, "") ||
            "";
        user._cachedRole = role;
        return role;
    }

    const fullUser: any = await strapi.db
        .query("plugin::users-permissions.user")
        .findOne({
            where: { id: user.id },
            select: ["id"],
            populate: {
                role: {
                    select: ["id", "name", "type"],
                },
            },
        });

    const role =
        fullUser?.role?.name?.toLowerCase().replace(/[\s_-]+/g, "") ||
        fullUser?.role?.type?.toLowerCase().replace(/[\s_-]+/g, "") ||
        "";
    user._cachedRole = role;
    return role;
}

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
                let user = ctx.state.user;

                // Fallback: If Bearer token is provided in header
                if (!user && ctx.request?.header?.authorization?.startsWith("Bearer ")) {
                    const token = ctx.request.header.authorization.slice(7).trim();
                    try {
                        const jwtService = strapi.plugin("users-permissions")?.service("jwt");
                        if (jwtService?.verify) {
                            const payload = await jwtService.verify(token);
                            if (payload?.id) {
                                user = await strapi.db
                                    .query("plugin::users-permissions.user")
                                    .findOne({
                                        where: { id: payload.id },
                                        populate: { role: true },
                                    });
                            }
                        }
                    } catch (_) {}
                }

                if (!user) {
                    return ctx.unauthorized(
                        "Authentication required. Please provide a valid Bearer token."
                    );
                }

                // 1. Role verification: Only Admin can send test push notifications
                const roleName = await getUserRole(user);
                const isAdmin =
                    roleName === "admin" ||
                    roleName === "superadmin" ||
                    roleName.includes("admin");

                if (!isAdmin) {
                    return ctx.forbidden(
                        "Access denied. Only users with Admin role can send test push notifications."
                    );
                }

                const body = (ctx.request.body as any) || {};

                // 2. Fetch only device tokens where isActive is true
                const whereClause: any = { isActive: true };

                // Optional filter if admin wants to test for a specific user
                if (body.userId || body.user_id) {
                    whereClause.users_permissions_user = Number(body.userId || body.user_id);
                }

                const activeDevices = await strapi.db
                    .query(DEVICE_TOKEN_UID)
                    .findMany({
                        where: whereClause,
                        populate: {
                            users_permissions_user: {
                                select: ["id", "email", "username"],
                            },
                        },
                    });

                if (!activeDevices.length) {
                    return ctx.send({
                        success: false,
                        sent: 0,
                        message: "No active device tokens found (where isActive is true).",
                    });
                }

                // 3. Filter valid Expo Push Tokens
                const validTokens = [
                    ...new Set(
                        activeDevices
                            .map((device: any) => device.token)
                            .filter(
                                (token: string) =>
                                    token &&
                                    (
                                        token.startsWith("ExpoPushToken[") ||
                                        token.startsWith("ExponentPushToken[")
                                    )
                            )
                    ),
                ] as string[];

                if (!validTokens.length) {
                    return ctx.send({
                        success: false,
                        sent: 0,
                        message: "No valid Expo push tokens found among active devices.",
                    });
                }

                // 4. Build messages
                const title = body.title || "FITFOB Test Notification";
                const notificationBody =
                    body.body ||
                    body.message ||
                    "Push notifications are working successfully!";
                const data = body.data || { type: "test" };

                const messages = validTokens.map((token) => ({
                    to: token,
                    sound: "default",
                    title,
                    body: notificationBody,
                    data,
                }));

                // 5. Send to Expo Push API individually so tokens with different project/experience IDs don't conflict
                const sendResults: any[] = [];
                await Promise.allSettled(
                    messages.map(async (msg) => {
                        try {
                            const res = await fetch(
                                "https://exp.host/--/api/v2/push/send",
                                {
                                    method: "POST",
                                    headers: {
                                        Accept: "application/json",
                                        "Accept-Encoding": "gzip, deflate",
                                        "Content-Type": "application/json",
                                    },
                                    body: JSON.stringify([msg]),
                                }
                            );
                            const json = await res.json();
                            sendResults.push({
                                token: msg.to,
                                status: res.status,
                                response: json,
                            });
                        } catch (err: any) {
                            sendResults.push({
                                token: msg.to,
                                error: err.message || "Failed to send",
                            });
                        }
                    })
                );

                return ctx.send({
                    success: true,
                    message: `Test push notification processed for ${validTokens.length} active device(s)`,
                    sentCount: validTokens.length,
                    devices: activeDevices.map((d: any) => ({
                        id: d.id,
                        token: d.token,
                        platform: d.platform,
                        isActive: d.isActive,
                        user: d.users_permissions_user?.email || d.users_permissions_user?.id || null,
                    })),
                    results: sendResults,
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