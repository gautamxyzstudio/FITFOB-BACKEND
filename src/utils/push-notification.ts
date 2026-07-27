const DEVICE_TOKEN_UID =
  "api::device-token.device-token" as any;

interface PushNotificationOptions {
  title: string;
  body: string;
  data?: Record<string, any>;
}

export async function sendPushNotification(
  userId: number,
  options: PushNotificationOptions
) {
  try {
    const {
      title,
      body,
      data = {},
    } = options;

    /* ================= GET ACTIVE DEVICES ================= */

    const devices = await strapi.db
      .query(DEVICE_TOKEN_UID)
      .findMany({
        where: {
          users_permissions_user: userId,
          isActive: true,
        },
      });

    if (!devices.length) {
      return {
        success: false,
        sent: 0,
        message: "No active devices found",
      };
    }

    /* ================= GET UNIQUE TOKENS ================= */

    const tokens = [
      ...new Set(
        devices
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

    if (!tokens.length) {
      return {
        success: false,
        sent: 0,
        message: "No valid Expo push tokens found",
      };
    }

    /* ================= BUILD MESSAGES ================= */

    const messages = tokens.map((token) => ({
      to: token,
      sound: "default",
      title,
      body,
      data,
    }));

    /* ================= SEND TO EXPO ================= */

    const response = await fetch(
      "https://exp.host/--/api/v2/push/send",
      {
        method: "POST",

        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip, deflate",
          "Content-Type": "application/json",
        },

        body: JSON.stringify(messages),
      }
    );

    const result = await response.json();

    if (!response.ok) {
      throw new Error(
        `Expo Push API failed: ${JSON.stringify(result)}`
      );
    }

    strapi.log.info(
      `Expo push processed for user ${userId}`
    );

    return {
      success: true,
      sent: tokens.length,
      result,
    };
  } catch (error) {
    strapi.log.error(
      "Expo push notification failed",
      error
    );

    throw error;
  }
}