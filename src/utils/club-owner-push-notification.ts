import { firebaseMessaging } from "./firebase-admin";

const DEVICE_TOKEN_UID = "api::device-token.device-token" as any;
const CLUB_OWNER_UID = "api::club-owner.club-owner" as any;
const NOTIFICATION_UID = "api::notification.notification" as any;

export interface ClubOwnerNotificationPayload {
  title: string;
  body: string;
  data?: Record<string, any>;
  sound?: string;
}

export interface ClubOwnerTrialBookingInfo {
  trial: any;
  client: any;
  trialDate: string;
}

/**
 * Format string to Title Case (e.g. "rahul sharma" -> "Rahul Sharma")
 */
function toTitleCase(str: string): string {
  if (!str) return "";
  return str
    .toLowerCase()
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
    .trim();
}

/**
 * Format YYYY-MM-DD into a human-friendly date (e.g. "Wednesday, 18 Nov 2026")
 */
function formatHumanDate(dateStr: string): string {
  if (!dateStr) return "";
  try {
    const clean = String(dateStr).split("T")[0];
    const [year, month, day] = clean.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.toLocaleDateString("en-US", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  } catch (_) {
    return dateStr;
  }
}

/**
 * Resolve the user ID and club owner record for a given club owner identifier
 * (Accepts Strapi ID, documentId, clubId e.g. "CF001", or already loaded club owner object)
 */
export async function resolveClubOwnerUser(
  clubOwnerIdentifier: any
): Promise<{
  userId: number | null;
  clubOwner: any;
}> {
  if (!clubOwnerIdentifier) return { userId: null, clubOwner: null };

  let clubOwner: any = null;

  if (typeof clubOwnerIdentifier === "object") {
    if (clubOwnerIdentifier.user?.id) {
      return {
        userId: Number(clubOwnerIdentifier.user.id),
        clubOwner: clubOwnerIdentifier,
      };
    }
    clubOwner = clubOwnerIdentifier;
  }

  const raw = String(
    typeof clubOwnerIdentifier === "object"
      ? clubOwnerIdentifier.id ||
          clubOwnerIdentifier.documentId ||
          clubOwnerIdentifier.clubId
      : clubOwnerIdentifier
  ).trim();

  if (!raw) return { userId: null, clubOwner: null };

  const isNum = !isNaN(Number(raw)) && /^\d+$/.test(raw);

  // 1. Fetch club owner with user relation populated
  const foundOwner = await strapi.db.query(CLUB_OWNER_UID).findOne({
    where: isNum
      ? { $or: [{ id: Number(raw) }, { documentId: raw }] }
      : { $or: [{ documentId: raw }, { clubId: raw }] },
    populate: {
      user: {
        select: ["id", "username", "email", "phoneNumber"],
      },
    },
  });

  const finalOwner = foundOwner || clubOwner;
  if (!finalOwner) {
    return { userId: null, clubOwner: null };
  }

  // 2. Direct user id on populated object
  if (finalOwner.user?.id) {
    return { userId: Number(finalOwner.user.id), clubOwner: finalOwner };
  }

  // 3. Fallback: Search user table by relation club_owner
  const ownerId = finalOwner.id;
  if (ownerId) {
    const userByRel: any = await strapi.db
      .query("plugin::users-permissions.user")
      .findOne({
        where: { club_owner: ownerId },
        select: ["id"],
      });
    if (userByRel?.id) {
      return { userId: Number(userByRel.id), clubOwner: finalOwner };
    }
  }

  // 4. Fallback: Match user by email
  if (finalOwner.email) {
    const userByEmail: any = await strapi.db
      .query("plugin::users-permissions.user")
      .findOne({
        where: { email: finalOwner.email },
        select: ["id"],
      });
    if (userByEmail?.id) {
      return { userId: Number(userByEmail.id), clubOwner: finalOwner };
    }
  }

  // 5. Fallback: Match user by phone number
  if (finalOwner.phoneNumber) {
    const userByPhone: any = await strapi.db
      .query("plugin::users-permissions.user")
      .findOne({
        where: { phoneNumber: finalOwner.phoneNumber },
        select: ["id"],
      });
    if (userByPhone?.id) {
      return { userId: Number(userByPhone.id), clubOwner: finalOwner };
    }
  }

  return { userId: null, clubOwner: finalOwner };
}

/**
 * Creates an in-app / normal notification record in Strapi
 */
export async function createNormalNotification(
  userId: number,
  title: string,
  description: string
) {
  try {
    let created: any = null;

    if ((strapi as any).documents) {
      try {
        created = await (strapi as any).documents(NOTIFICATION_UID).create({
          data: {
            title,
            description,
            users_permissions_user: userId,
          },
        });
      } catch (docErr) {
        strapi.log.warn("[NormalNotification] documents.create fallback:", docErr);
      }
    }

    if (!created && strapi.entityService) {
      try {
        created = await strapi.entityService.create(NOTIFICATION_UID, {
          data: {
            title,
            description,
            users_permissions_user: userId,
          },
        });
      } catch (entErr) {
        strapi.log.warn("[NormalNotification] entityService.create fallback:", entErr);
      }
    }

    if (!created) {
      created = await strapi.db.query(NOTIFICATION_UID).create({
        data: {
          title,
          description,
          users_permissions_user: userId,
        },
      });
    }

    strapi.log.info(
      `[NormalNotification] Saved in-app notification for user ${userId}: "${title}"`
    );
    return created;
  } catch (err) {
    strapi.log.error(
      `[NormalNotification] Failed to create in-app notification for user ${userId}:`,
      err
    );
    return null;
  }
}

/**
 * Send a push notification ONLY to the specified club owner's active devices,
 * and automatically saves the in-app / normal notification record in Strapi.
 * Supports both Expo push tokens and native FCM tokens.
 */
export async function sendClubOwnerPushNotification(
  clubOwnerIdentifier: any,
  payload: ClubOwnerNotificationPayload
): Promise<{
  success: boolean;
  sent: number;
  message?: string;
  results?: any[];
}> {
  try {
    const { title, body, data = {}, sound = "default" } = payload;

    // 1. Resolve club owner & linked user ID
    const { userId, clubOwner } = await resolveClubOwnerUser(
      clubOwnerIdentifier
    );

    if (!userId) {
      const ownerLabel =
        clubOwner?.clubName ||
        clubOwner?.ownerName ||
        clubOwner?.clubId ||
        String(clubOwnerIdentifier);
      strapi.log.warn(
        `[ClubOwnerPush] No linked user account found for club owner: ${ownerLabel}`
      );
      return {
        success: false,
        sent: 0,
        message: "No linked user account found for this club owner",
      };
    }

    // 2. Always create in-app / normal notification in Strapi database
    try {
      await createNormalNotification(userId, title, body);
    } catch (notifErr) {
      strapi.log.warn(
        `[ClubOwnerPush] Failed to create normal notification for user ${userId}:`,
        notifErr
      );
    }

    // 3. Query active devices registered for this user ONLY
    const devices = await strapi.db.query(DEVICE_TOKEN_UID).findMany({
      where: {
        users_permissions_user: userId,
        isActive: true,
      },
    });

    if (!devices || devices.length === 0) {
      strapi.log.info(
        `[ClubOwnerPush] No active device tokens found for club owner user ${userId} (${
          clubOwner?.clubName || "gym"
        })`
      );
      return {
        success: false,
        sent: 0,
        message: "No active devices found for this club owner",
      };
    }

    // 3. Separate Expo tokens vs FCM tokens
    const expoTokens: string[] = [];
    const fcmTokens: string[] = [];

    for (const dev of devices) {
      const token = dev.token?.trim();
      if (!token) continue;

      if (
        token.startsWith("ExpoPushToken[") ||
        token.startsWith("ExponentPushToken[")
      ) {
        if (!expoTokens.includes(token)) {
          expoTokens.push(token);
        }
      } else {
        if (!fcmTokens.includes(token)) {
          fcmTokens.push(token);
        }
      }
    }

    const totalTokens = expoTokens.length + fcmTokens.length;
    if (totalTokens === 0) {
      return {
        success: false,
        sent: 0,
        message: "No valid push tokens found for this club owner",
      };
    }

    const results: any[] = [];
    let sentCount = 0;

    // 4. Send to Expo Push Service
    if (expoTokens.length > 0) {
      const expoMessages = expoTokens.map((token) => ({
        to: token,
        sound,
        title,
        body,
        data,
      }));

      await Promise.allSettled(
        expoMessages.map(async (msg) => {
          try {
            const res = await fetch("https://exp.host/--/api/v2/push/send", {
              method: "POST",
              headers: {
                Accept: "application/json",
                "Accept-Encoding": "gzip, deflate",
                "Content-Type": "application/json",
              },
              body: JSON.stringify([msg]),
            });

            const json: any = await res.json();
            results.push({
              provider: "expo",
              token: msg.to,
              status: res.status,
              response: json,
            });

            const ticketData = json?.data;
            if (Array.isArray(ticketData) && ticketData[0]) {
              const ticket = ticketData[0];
              if (ticket.status === "ok") {
                sentCount++;
              }
            } else if (res.ok) {
              sentCount++;
            }
          } catch (err: any) {
            results.push({
              provider: "expo",
              token: msg.to,
              error: err.message || "Failed to send to Expo",
            });
          }
        })
      );
    }

    // 5. Send to Firebase Cloud Messaging (FCM)
    if (fcmTokens.length > 0 && firebaseMessaging) {
      try {
        const stringifiedData: Record<string, string> = {};
        if (data) {
          for (const [key, val] of Object.entries(data)) {
            stringifiedData[key] =
              typeof val === "object"
                ? JSON.stringify(val)
                : String(val ?? "");
          }
        }

        const fcmResponse = await firebaseMessaging.sendEachForMulticast({
          tokens: fcmTokens,
          notification: {
            title,
            body,
          },
          data: stringifiedData,
          android: {
            priority: "high",
            notification: {
              sound: "default",
              channelId: "default",
            },
          },
          apns: {
            payload: {
              aps: {
                sound: "default",
              },
            },
          },
        });

        sentCount += fcmResponse.successCount;
        results.push({
          provider: "fcm",
          successCount: fcmResponse.successCount,
          failureCount: fcmResponse.failureCount,
        });
      } catch (fcmErr: any) {
        strapi.log.warn("[ClubOwnerPush] FCM dispatch error:", fcmErr);
        results.push({
          provider: "fcm",
          error: fcmErr.message || "Failed to send FCM push",
        });
      }
    }

    strapi.log.info(
      `[ClubOwnerPush] Push sent to club owner ${userId} (${
        clubOwner?.clubName || "gym"
      }) on ${sentCount}/${totalTokens} devices`
    );

    return {
      success: sentCount > 0,
      sent: sentCount,
      results,
    };
  } catch (error) {
    strapi.log.error(
      "[ClubOwnerPush] Unexpected error in sendClubOwnerPushNotification:",
      error
    );
    return {
      success: false,
      sent: 0,
      message: "Push notification failed",
    };
  }
}

/**
 * Specifically dispatches a push notification to ONLY the gym owner whose gym has a new trial booked.
 */
export async function sendClubOwnerTrialBookedNotification(
  clubOwner: any,
  info: ClubOwnerTrialBookingInfo
) {
  try {
    const { trial, client, trialDate } = info;

    const rawClientName =
      client?.name ||
      client?.fullName ||
      client?.user?.username ||
      client?.email ||
      "A client";

    const clientName = toTitleCase(rawClientName);
    const gymName = clubOwner?.clubName || "your gym";
    const formattedDate = formatHumanDate(trialDate);

    const title = "New Gym Trial Booked! 🔔";
    const body = `${clientName} has booked a gym trial for ${formattedDate}`;

    // Deep linking data contract for the mobile app
    const data = {
      screen: "TrialManagerScreen",
      type: "GYM_TRIAL_BOOKED",
      trialDate: String(trialDate || ""),
      clientName: String(clientName),
    };

    return await sendClubOwnerPushNotification(clubOwner, {
      title,
      body,
      data,
    });
  } catch (err) {
    strapi.log.error(
      "[ClubOwnerPush] sendClubOwnerTrialBookedNotification error:",
      err
    );
    return {
      success: false,
      sent: 0,
      message: "Failed to dispatch trial booked push notification",
    };
  }
}

export interface ClubOwnerTrialCancelInfo {
  trial: any;
  client: any;
  trialDate: string;
  reason?: string;
}

export interface ClubOwnerTrialRescheduleInfo {
  trial: any;
  client: any;
  oldDate: string;
  newDate: string;
}

/**
 * Specifically dispatches a push notification to the gym owner when a trial is cancelled.
 */
export async function sendClubOwnerTrialCancelledNotification(
  clubOwner: any,
  info: ClubOwnerTrialCancelInfo
) {
  try {
    const { trial, client, trialDate, reason } = info;
    const rawClientName =
      client?.name ||
      client?.fullName ||
      client?.user?.username ||
      client?.email ||
      "A guest";

    const clientName = toTitleCase(rawClientName);
    const formattedDate = formatHumanDate(trialDate);

    const title = "Gym Trial Cancelled";
    const body = `${clientName} has cancelled their trial for ${formattedDate}${
      reason ? ` (${reason})` : ""
    }. Slot reopened.`;

    const data = {
      screen: "TrialManagerScreen",
      type: "GYM_TRIAL_CANCELLED",
      trialDate: String(trialDate || ""),
      clientName: String(clientName),
      reason: String(reason || ""),
    };

    return await sendClubOwnerPushNotification(clubOwner, {
      title,
      body,
      data,
    });
  } catch (err) {
    strapi.log.error(
      "[ClubOwnerPush] sendClubOwnerTrialCancelledNotification error:",
      err
    );
    return {
      success: false,
      sent: 0,
      message: "Failed to dispatch trial cancelled push notification",
    };
  }
}

/**
 * Specifically dispatches a push notification to the gym owner when a trial is rescheduled.
 */
export async function sendClubOwnerTrialRescheduledNotification(
  clubOwner: any,
  info: ClubOwnerTrialRescheduleInfo
) {
  try {
    const { trial, client, oldDate, newDate } = info;
    const rawClientName =
      client?.name ||
      client?.fullName ||
      client?.user?.username ||
      client?.email ||
      "A guest";

    const clientName = toTitleCase(rawClientName);
    const oldFormatted = formatHumanDate(oldDate);
    const newFormatted = formatHumanDate(newDate);

    const title = "Gym Trial Rescheduled 📅";
    const body = `${clientName} rescheduled their trial from ${oldFormatted} to ${newFormatted}`;

    const data = {
      screen: "TrialManagerScreen",
      type: "GYM_TRIAL_RESCHEDULED",
      oldDate: String(oldDate || ""),
      newDate: String(newDate || ""),
      clientName: String(clientName),
    };

    return await sendClubOwnerPushNotification(clubOwner, {
      title,
      body,
      data,
    });
  } catch (err) {
    strapi.log.error(
      "[ClubOwnerPush] sendClubOwnerTrialRescheduledNotification error:",
      err
    );
    return {
      success: false,
      sent: 0,
      message: "Failed to dispatch trial rescheduled push notification",
    };
  }
}
