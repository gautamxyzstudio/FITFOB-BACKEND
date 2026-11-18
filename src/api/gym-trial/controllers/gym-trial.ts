/**
 * gym-trial controller
 */

import { factories } from "@strapi/strapi";
import { Context } from "koa";
import { sendClubOwnerTrialBookedNotification } from "../../../utils/club-owner-push-notification";

/* =======================================================
   HELPERS
======================================================= */

const SIX_WEEKS_MS = 42 * 24 * 60 * 60 * 1000; // 42 days = 6 weeks

function parseDateToTime(dateStr: string): number {
  if (!dateStr) return 0;
  const clean = String(dateStr).split("T")[0];
  const [year, month, day] = clean.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function formatDateFromTime(timestamp: number): string {
  const d = new Date(timestamp);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatMediaUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  const baseUrl = strapi.config.get("server.url") || "";
  return `${baseUrl}${url}`;
}

function getMediaUrl(media: any): string | null {
  if (!media) return null;
  if (Array.isArray(media)) {
    if (media.length === 0) return null;
    return getMediaUrl(media[0]);
  }
  if (typeof media === "string") return formatMediaUrl(media);

  const target = media.data ? media.data : media;
  const item = target.attributes ? target.attributes : target;

  let formats = item?.formats;
  if (typeof formats === "string") {
    try {
      formats = JSON.parse(formats);
    } catch (_) {}
  }

  const rawUrl =
    formats?.small?.url || formats?.thumbnail?.url || item?.url || null;
  return formatMediaUrl(rawUrl);
}

function getTodayDateString(): string {
  const now = new Date();
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  const nowIST = new Date(now.getTime() + IST_OFFSET);
  const year = nowIST.getUTCFullYear();
  const month = String(nowIST.getUTCMonth() + 1).padStart(2, "0");
  const day = String(nowIST.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function calculateHaversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371; // Earth's radius in kilometers
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function getGymClosingTimeForDate(
  scheduling: any,
  dateStr: string | null | undefined,
): string | null {
  if (!scheduling || !dateStr) return null;
  try {
    let sched = scheduling;
    if (typeof sched === "string") {
      try {
        sched = JSON.parse(sched);
      } catch (_) {}
    }
    const cleanDate = String(dateStr).split("T")[0];
    const d = new Date(`${cleanDate}T00:00:00Z`);
    const dayNames = [
      "sunday",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
    ];
    const dayName = dayNames[d.getUTCDay()];
    const daySchedule = sched[dayName];
    if (!daySchedule || daySchedule === "closed" || daySchedule.isClosed) {
      return null;
    }
    const rawClosing = daySchedule.closingTime || daySchedule.closing_time;
    if (!rawClosing) return null;

    if (typeof rawClosing === "string" && rawClosing.includes(":")) {
      const [hStr, mStr] = rawClosing.split(":");
      let h = parseInt(hStr, 10);
      const m = mStr || "00";
      const ampm = h >= 12 ? "PM" : "AM";
      h = h % 12 || 12;
      return `${String(h).padStart(2, "0")}:${m} ${ampm}`;
    }
    return String(rawClosing);
  } catch (_) {
    return null;
  }
}

function getISTDateString(offsetDays: number = 0): string {
  const now = new Date();
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  const target = new Date(
    now.getTime() + IST_OFFSET + offsetDays * 24 * 60 * 60 * 1000,
  );
  const year = target.getUTCFullYear();
  const month = String(target.getUTCMonth() + 1).padStart(2, "0");
  const day = String(target.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatTimeIST(dateVal: any): string | null {
  if (!dateVal) return null;
  try {
    const d = new Date(dateVal);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleTimeString("en-IN", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
  } catch (_) {
    return null;
  }
}

function formatBookedAtText(createdAt: any, todayStr: string): string | null {
  if (!createdAt) return null;
  try {
    const d = new Date(createdAt);
    const cleanDate = d.toISOString().split("T")[0];

    if (!d) return null;

    if (cleanDate === todayStr) {
      return `Booked today · ${createdAt}`;
    }

    const [tY, tM, tD] = todayStr.split("-").map(Number);
    const todayMs = Date.UTC(tY, tM - 1, tD);
    const [cY, cM, cD] = cleanDate.split("-").map(Number);
    const createdMs = Date.UTC(cY, cM - 1, cD);

    if (todayMs - createdMs === 24 * 60 * 60 * 1000) {
      return `Booked yesterday · ${createdAt}`;
    }
    return `Booked ${createdAt}`;
  } catch (_) {
    return null;
  }
}

function formatDisplayDate(
  dateStr: string,
  todayStr: string,
  tomorrowStr: string,
): string {
  try {
    const clean = String(dateStr).split("T")[0];
    const [year, month, day] = clean.split("-").map(Number);
    const d = new Date(Date.UTC(year, month - 1, day));

    const dayNamesShort = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const monthNamesShort = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];

    const dayName = dayNamesShort[d.getUTCDay()];
    const monthName = monthNamesShort[d.getUTCMonth()];

    if (clean === todayStr) {
      return `Today · ${dayName}, ${day} ${monthName}`;
    }
    if (clean === tomorrowStr) {
      return `Tomorrow · ${dayName}, ${day} ${monthName}`;
    }
    return `${dayName}, ${day} ${monthName}`;
  } catch (_) {
    return dateStr;
  }
}

async function resolveClubOwnerForUser(user: any) {
  if (!user?.id) return null;

  let clubOwner = await strapi.db.query("api::club-owner.club-owner").findOne({
    where: { user: user.id },
    populate: { logo: true },
  });

  if (!clubOwner) {
    const fullUser: any = await strapi.db
      .query("plugin::users-permissions.user")
      .findOne({
        where: { id: user.id },
        populate: {
          club_owner: {
            populate: { logo: true },
          },
        },
      });
    clubOwner = fullUser?.club_owner || null;
  }

  if (!clubOwner) {
    try {
      const lnk: any = await (strapi.db as any)
        .connection("up_users_club_owner_lnk")
        .where({ user_id: user.id })
        .first();
      if (lnk?.club_owner_id) {
        clubOwner = await strapi.db
          .query("api::club-owner.club-owner")
          .findOne({
            where: { id: lnk.club_owner_id },
            populate: { logo: true },
          });
      }
    } catch (_) {}
  }

  if (!clubOwner && user.email) {
    clubOwner = await strapi.db.query("api::club-owner.club-owner").findOne({
      where: { email: user.email },
      populate: { logo: true },
    });
  }

  if (!clubOwner && user.phoneNumber) {
    clubOwner = await strapi.db.query("api::club-owner.club-owner").findOne({
      where: { phoneNumber: user.phoneNumber },
      populate: { logo: true },
    });
  }

  return clubOwner;
}

async function getAuthUser(ctx: Context) {
  let user = ctx.state?.user;
  if (user?.id) return user;

  const authHeader = ctx.request?.header?.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
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
          if (user) {
            ctx.state.user = user;
            return user;
          }
        }
      }
    } catch (_) {}
  }

  return null;
}

/* ---------- ROLE HELPER ---------- */
async function getUserRole(user: any): Promise<string> {
  if (!user) return "";
  if (user._cachedRole) return user._cachedRole;

  if (user.role && typeof user.role === "object") {
    const role =
      user.role.name?.toLowerCase().replace(/[\s_-]+/g, "") ||
      user.role.type?.toLowerCase().replace(/[\s_-]+/g, "") ||
      "";
    if (role) {
      user._cachedRole = role;
      return role;
    }
  }

  const userId = typeof user === "object" ? user.id : user;
  if (!userId) return "";

  const fullUser: any = await strapi.db
    .query("plugin::users-permissions.user")
    .findOne({
      where: { id: userId },
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

  if (user && typeof user === "object") {
    user._cachedRole = role;
  }
  return role;
}

async function resolveClientDetailForUser(user: any) {
  if (!user?.id) return null;

  // 1. Direct query by user relation
  let client = await strapi.db
    .query("api::client-detail.client-detail")
    .findOne({
      where: { user: user.id },
      populate: {
        selfieUpload: true,
        user: { select: ["id", "username", "email", "phoneNumber"] },
      },
    });

  // 2. Fallback via user table populate
  if (!client) {
    const fullUser: any = await strapi.db
      .query("plugin::users-permissions.user")
      .findOne({
        where: { id: user.id },
        populate: {
          client_detail: {
            populate: {
              selfieUpload: true,
            },
          },
        },
      });
    client = fullUser?.client_detail || null;
  }

  // 3. Fallback by email
  if (!client && user.email) {
    client = await strapi.db.query("api::client-detail.client-detail").findOne({
      where: { email: user.email },
      populate: { selfieUpload: true },
    });
  }

  // 4. Fallback by phoneNumber
  if (!client && user.phoneNumber) {
    client = await strapi.db.query("api::client-detail.client-detail").findOne({
      where: { phoneNumber: user.phoneNumber },
      populate: { selfieUpload: true },
    });
  }

  return client;
}

async function resolveClubOwner(identifier: any) {
  if (!identifier) return null;
  const raw = String(
    typeof identifier === "object"
      ? identifier.id || identifier.documentId || identifier.clubId
      : identifier,
  ).trim();
  if (!raw) return null;

  const isNum = !isNaN(Number(raw)) && /^\d+$/.test(raw);

  const clubOwner = await strapi.db
    .query("api::club-owner.club-owner")
    .findOne({
      where: isNum
        ? { $or: [{ id: Number(raw) }, { documentId: raw }] }
        : { $or: [{ documentId: raw }, { clubId: raw }] },
      populate: {
        logo: true,
        user: true,
      },
    });

  return clubOwner;
}

const POPULATE_CONFIG: any = {
  client_detail: {
    populate: {
      selfieUpload: true,
    },
  },
  club_owner: {
    populate: {
      logo: true,
    },
  },
};

function formatTrial(item: any, fallbackDate?: string) {
  if (!item) return null;

  return {
    id: item.id,
    documentId: item.documentId || null,
    trialDate: item.trialDate || fallbackDate || null,
    trialstatus: item.trialstatus || "booked",
    createdAt: item.createdAt || null,
  };
}

export default factories.createCoreController(
  "api::gym-trial.gym-trial",
  ({ strapi }) => ({
    /* =======================================================
       - A client can book max 3 trials per 6 weeks.
    ======================================================= */
    async create(ctx: Context) {
      try {
        const user = await getAuthUser(ctx);

        if (!user?.id) {
          return ctx.unauthorized("Authentication required");
        }

        const body = (ctx.request.body as any) || {};
        const data = body.data || body;

        // 1. Resolve client profile strictly for the authenticated user
        const clientDetail = await resolveClientDetailForUser(user);

        if (!clientDetail) {
          return ctx.badRequest(
            "Client profile not found for this user. Only registered clients can book a trial slot.",
          );
        }

        // 2. Reject any attempt to book for another client
        const rawPassedClient =
          data.client_detail || data.clientDetail || data.clientId;
        if (rawPassedClient) {
          const passedStr = String(
            typeof rawPassedClient === "object"
              ? rawPassedClient.id ||
                  rawPassedClient.documentId ||
                  rawPassedClient.clientId
              : rawPassedClient,
          ).trim();

          const isOwn =
            passedStr === String(clientDetail.id) ||
            passedStr === String(clientDetail.documentId) ||
            (clientDetail.clientId &&
              passedStr === String(clientDetail.clientId));

          if (!isOwn) {
            return ctx.forbidden(
              "Booking a trial slot for another client is not permitted. Users can only book a trial for themselves.",
            );
          }
        }

        // 3. Validate club owner
        const rawClubOwner =
          data.club_owner ||
          data.clubOwner ||
          data.club_owner_id ||
          data.clubOwnerId ||
          data.clubId ||
          data.gymId;

        if (!rawClubOwner) {
          return ctx.badRequest("club_owner is required");
        }

        const clubOwner = await resolveClubOwner(rawClubOwner);
        if (!clubOwner) {
          return ctx.notFound("Gym / club owner not found");
        }

        // Club owners cannot book a trial slot at their own gym
        const isOwnGym =
          (clubOwner.user &&
            (clubOwner.user === user.id || clubOwner.user?.id === user.id)) ||
          (clubOwner.phoneNumber &&
            clubOwner.phoneNumber === user.phoneNumber) ||
          (clubOwner.email && clubOwner.email === user.email);

        if (isOwnGym) {
          return ctx.badRequest(
            "Club owners cannot book a trial slot at their own gym",
          );
        }

        // 4. Validate trialDate
        const rawTrialDate = data.trialDate || data.trial_date || data.date;
        if (!rawTrialDate || !String(rawTrialDate).trim()) {
          return ctx.badRequest("trialDate is required (format: YYYY-MM-DD)");
        }

        const trialDateStr = String(rawTrialDate).trim().split("T")[0];
        if (!/^\d{4}-\d{2}-\d{2}$/.test(trialDateStr)) {
          return ctx.badRequest(
            "Invalid trialDate format. Expected YYYY-MM-DD",
          );
        }

        const todayDateStr = getTodayDateString();
        if (trialDateStr < todayDateStr) {
          return ctx.badRequest("Cannot book a trial for a past date");
        }

        // 5. Check if gym allows trials
        if (clubOwner.isTrialEnabled === false) {
          return ctx.badRequest(
            "Free trial is currently not enabled for this gym",
          );
        }

        // 6. Check gym daily trial slot limit
        const dailyLimit =
          Number(clubOwner.dailyTrialLimit) > 0
            ? Number(clubOwner.dailyTrialLimit)
            : 3;

        const bookedCountForDate = await strapi.db
          .query("api::gym-trial.gym-trial")
          .count({
            where: {
              club_owner: clubOwner.id,
              trialDate: trialDateStr,
              trialstatus: { $ne: "cancelled" },
            },
          });

        if (bookedCountForDate >= dailyLimit) {
          return ctx.badRequest(
            `All trial slots for ${trialDateStr} are fully booked (Daily limit: ${dailyLimit})`,
          );
        }

        // 7. Check if client already booked or completed a trial for this date at this gym
        const existingForDate = await strapi.db
          .query("api::gym-trial.gym-trial")
          .findOne({
            where: {
              client_detail: clientDetail.id,
              club_owner: clubOwner.id,
              trialDate: trialDateStr,
              trialstatus: { $ne: "cancelled" },
            },
          });

        if (existingForDate) {
          const st = existingForDate.trialstatus;
          let msg = `You already have a booked trial at this gym on ${trialDateStr}`;
          if (st === "completed") {
            msg = `You have already completed a trial at this gym on ${trialDateStr}`;
          } else if (st === "no-show" || st === "no_show") {
            msg = `You booked a trial at this gym on ${trialDateStr} but were marked as no-show`;
          }
          return ctx.badRequest(msg);
        }

        // 8. Check if client has any pending/upcoming booked trial at this gym
        const activeUpcoming = await strapi.db
          .query("api::gym-trial.gym-trial")
          .findOne({
            where: {
              client_detail: clientDetail.id,
              club_owner: clubOwner.id,
              trialstatus: "booked",
              trialDate: { $gte: todayDateStr },
            },
          });

        if (activeUpcoming) {
          return ctx.badRequest(
            `You already have an active trial booked for ${activeUpcoming.trialDate} at this gym`,
          );
        }

        /* ========================================================
           9. 6-WEEK TRIAL QUOTA CHECK (MAX 3 TRIALS PER 6 WEEKS)
           Limit resets after each 6-week cycle (42 days)
        ======================================================== */
        const targetTime = parseDateToTime(trialDateStr);

        const clientTrials: any[] = await strapi.db
          .query("api::gym-trial.gym-trial")
          .findMany({
            where: {
              client_detail: clientDetail.id,
              trialstatus: { $ne: "cancelled" },
            },
            orderBy: { trialDate: "asc", id: "asc" },
            select: ["id", "trialDate", "trialstatus"],
          });

        // Group past trials into consecutive 6-week (42-day) periods
        interface TrialPeriod {
          start: number;
          end: number;
          trials: any[];
        }

        const periods: TrialPeriod[] = [];
        let currentPeriod: TrialPeriod | null = null;

        for (const t of clientTrials) {
          const tTime = parseDateToTime(t.trialDate);
          if (!tTime) continue;

          if (!currentPeriod || tTime > currentPeriod.end) {
            currentPeriod = {
              start: tTime,
              end: tTime + SIX_WEEKS_MS,
              trials: [t],
            };
            periods.push(currentPeriod);
          } else {
            currentPeriod.trials.push(t);
          }
        }

        // A. Period check: target date falls within an active period with >= 3 trials
        const matchingPeriod = periods.find(
          (p) => targetTime >= p.start && targetTime <= p.end,
        );

        if (matchingPeriod && matchingPeriod.trials.length >= 3) {
          const resetDateStr = formatDateFromTime(
            matchingPeriod.end + 24 * 60 * 60 * 1000,
          );
          return ctx.badRequest(
            `You can book only 3 trials per 6 weeks. Your trial limit resets on ${resetDateStr}.`,
          );
        }

        // B. Rolling check: 3 trials in the 42 days leading up to target date
        const trialsInLast42Days = clientTrials.filter((t: any) => {
          const tTime = parseDateToTime(t.trialDate);
          return tTime <= targetTime && tTime >= targetTime - SIX_WEEKS_MS;
        });

        if (trialsInLast42Days.length >= 3) {
          const earliestTime = parseDateToTime(trialsInLast42Days[0].trialDate);
          const resetDateStr = formatDateFromTime(
            earliestTime + SIX_WEEKS_MS + 24 * 60 * 60 * 1000,
          );
          return ctx.badRequest(
            `You can book only 3 trials per 6 weeks. Your trial limit resets on ${resetDateStr}.`,
          );
        }

        // 10. Create gym trial record
        const payload: any = {
          trialDate: trialDateStr,
          client_detail: clientDetail.id,
          club_owner: clubOwner.id,
          trialstatus: data.trialstatus || "booked",
        };

        let created: any = null;
        if ((strapi as any).documents) {
          try {
            created = await (strapi as any)
              .documents("api::gym-trial.gym-trial")
              .create({
                data: payload,
                populate: POPULATE_CONFIG,
              });
          } catch (docErr) {
            strapi.log.warn(
              "documents.create fallback in gym-trial create:",
              docErr,
            );
          }
        }

        if (!created) {
          try {
            created = await strapi.entityService.create(
              "api::gym-trial.gym-trial",
              {
                data: payload,
                populate: POPULATE_CONFIG as any,
              },
            );
          } catch (entityErr) {
            strapi.log.warn(
              "entityService.create fallback in gym-trial create:",
              entityErr,
            );
          }
        }

        if (!created) {
          created = await strapi.db.query("api::gym-trial.gym-trial").create({
            data: payload,
          });
        }

        // 11. Log client activity
        try {
          const activityLogService: any = strapi.service(
            "api::activity-log.activity-log",
          );
          if (activityLogService?.createActivityLog) {
            const gymName = clubOwner.clubName || "gym";
            await activityLogService.createActivityLog({
              actorType: "client",
              actorId: clientDetail.documentId || clientDetail.id,
              actionType: "create",
              entityName: "gym-trial",
              entityId: created?.documentId || created?.id,
              description: `Booked free trial at ${gymName} for ${trialDateStr}`,
            });
          }
        } catch (actErr) {
          strapi.log.warn("[Trial] Activity logging failed:", actErr);
        }

        // 12. Send push notification to ONLY this gym owner's devices
        try {
          await sendClubOwnerTrialBookedNotification(clubOwner, {
            trial: created,
            client: clientDetail,
            trialDate: trialDateStr,
          });
        } catch (pushErr) {
          strapi.log.error(
            "[GymTrial] Failed to send push notification to club owner:",
            pushErr,
          );
        }

        return ctx.send({
          message: "Trial booked successfully",
          data: formatTrial(created, trialDateStr),
        });
      } catch (error) {
        strapi.log.error("Error creating gym trial:", error);
        return ctx.internalServerError("Failed to create gym trial");
      }
    },

    /* =======================================================
       ADMIN: GET CLIENT TRIALS IN 6-WEEK PERIOD
    ======================================================= */
    async adminClientTrials(ctx: Context) {
      try {
        const user = await getAuthUser(ctx);
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        const isAdmin =
          roleName === "admin" ||
          roleName === "superadmin" ||
          roleName.includes("admin");

        if (!isAdmin) {
          return ctx.forbidden(
            "Access denied. Only Admin and SuperAdmin can access this endpoint.",
          );
        }

        const params = (ctx.params || {}) as any;
        const query = (ctx.query || {}) as any;

        const targetId =
          params.id ||
          params.clientdocumentid ||
          params.clientdocumentId ||
          params.clientDocumentId ||
          query.clientdocumentid ||
          query.clientdocumentId ||
          query.clientDocumentId ||
          query.clientId ||
          query.documentId ||
          query.id;

        if (!targetId || !String(targetId).trim()) {
          return ctx.badRequest("Please provide client documentId");
        }

        const cleanDocId = String(targetId).trim();
        const isNum = !isNaN(Number(cleanDocId)) && /^\d+$/.test(cleanDocId);

        let clientDetail: any = null;

        if ((strapi as any).documents && !isNum) {
          try {
            clientDetail = await (strapi as any)
              .documents("api::client-detail.client-detail")
              .findOne({
                documentId: cleanDocId,
                select: ["id", "documentId", "clientId", "name"],
              });
          } catch (_) {}
        }

        if (!clientDetail) {
          clientDetail = await strapi.db
            .query("api::client-detail.client-detail")
            .findOne({
              where: isNum
                ? {
                    $or: [
                      { id: Number(cleanDocId) },
                      { documentId: cleanDocId },
                    ],
                  }
                : {
                    $or: [{ documentId: cleanDocId }, { clientId: cleanDocId }],
                  },
              select: ["id", "documentId", "clientId", "name"],
            });
        }

        if (!clientDetail) {
          return ctx.notFound(
            `Client with documentId '${cleanDocId}' not found`,
          );
        }

        // Fetch all trials for this client
        const clientTrials: any[] = await strapi.db
          .query("api::gym-trial.gym-trial")
          .findMany({
            where: {
              client_detail: clientDetail.id,
            },
            populate: {
              club_owner: {
                select: ["id", "clubName", "clubId", "ownerName"],
              },
            },
            orderBy: { trialDate: "asc", id: "asc" },
          });

        // Group into consecutive 6-week (42 days) periods starting when the first trial is booked
        interface Period {
          start: number;
          end: number;
          trials: any[];
        }

        const periods: Period[] = [];
        let curPeriod: Period | null = null;

        for (const t of clientTrials) {
          const tTime = parseDateToTime(t.trialDate);
          if (!tTime) continue;

          if (!curPeriod || tTime > curPeriod.end) {
            curPeriod = {
              start: tTime,
              end: tTime + SIX_WEEKS_MS,
              trials: [t],
            };
            periods.push(curPeriod);
          } else {
            curPeriod.trials.push(t);
          }
        }

        // Format all periods with from/to date range and trials inside each period
        const responseData = periods.map((p) => {
          const from = formatDateFromTime(p.start);
          const to = formatDateFromTime(p.end);

          const Trials = p.trials.map((t: any) => {
            const clubName =
              t.club_owner?.clubName ||
              t.club_owner?.name ||
              t.club_owner?.ownerName ||
              null;

            return {
              clubName,
              trialDate: t.trialDate || null,
              trialstatus: t.trialstatus || null,
            };
          });

          return {
            from,
            to,
            Trials,
          };
        });

        return ctx.send(responseData);
      } catch (error) {
        strapi.log.error("ADMIN CLIENT TRIALS ERROR:", error);
        return ctx.internalServerError("Failed to fetch client trials");
      }
    },

    /* =======================================================
       ADMIN: GET CLUB OWNER FREE TRIAL CLIENT LIST
       Endpoint: GET /api/gym-trials/club-owner/:ownerDocId
       Allows admin to fetch the list of free trial clients for a club owner
       Returns: client name, profile image, date, status
    ======================================================= */
    async adminClubOwnerTrials(ctx: Context) {
      try {
        const user = await getAuthUser(ctx);
        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        const isAdmin =
          roleName === "admin" ||
          roleName === "superadmin" ||
          roleName.includes("admin");

        const params = (ctx.params || {}) as any;
        const query = (ctx.query || {}) as any;

        const targetId =
          params.ownerDocId ||
          params.ownerdocId ||
          params.clubOwnerDocumentId ||
          params.clubownerdocumentid ||
          params.ownerDocumentId ||
          params.documentId ||
          params.id ||
          query.ownerDocId ||
          query.ownerdocId ||
          query.clubOwnerDocumentId ||
          query.clubownerdocumentid ||
          query.ownerDocumentId ||
          query.documentId ||
          query.id;

        if (!targetId || !String(targetId).trim()) {
          return ctx.badRequest(
            "Please provide club owner documentId (ownerDocId)",
          );
        }

        const cleanDocId = String(targetId).trim();
        const isNum = !isNaN(Number(cleanDocId)) && /^\d+$/.test(cleanDocId);

        let clubOwner = await resolveClubOwner(cleanDocId);

        if (!clubOwner && (strapi as any).documents && !isNum) {
          try {
            clubOwner = await (strapi as any)
              .documents("api::club-owner.club-owner")
              .findOne({
                documentId: cleanDocId,
                populate: { user: true },
              });
          } catch (_) {}
        }

        if (!clubOwner) {
          clubOwner = await strapi.db
            .query("api::club-owner.club-owner")
            .findOne({
              where: isNum
                ? {
                    $or: [
                      { id: Number(cleanDocId) },
                      { documentId: cleanDocId },
                    ],
                  }
                : { $or: [{ documentId: cleanDocId }, { clubId: cleanDocId }] },
              populate: { user: true },
            });
        }

        if (!clubOwner) {
          return ctx.notFound(
            `Club owner with identifier '${cleanDocId}' not found`,
          );
        }

        // Check permission: Admin/SuperAdmin or the club owner themselves
        const isOwnGym =
          (clubOwner.user &&
            (clubOwner.user === user.id || clubOwner.user?.id === user.id)) ||
          (clubOwner.phoneNumber &&
            clubOwner.phoneNumber === user.phoneNumber) ||
          (clubOwner.email && clubOwner.email === user.email);

        if (!isAdmin && !isOwnGym) {
          return ctx.forbidden(
            "Access denied. Only Admin and SuperAdmin can access this endpoint.",
          );
        }

        // Query gym trials for this club owner
        const whereClause: any = {
          club_owner: clubOwner.id,
        };

        if (query.status || query.trialstatus) {
          whereClause.trialstatus = query.status || query.trialstatus;
        }
        if (query.date || query.trialDate) {
          whereClause.trialDate = String(query.date || query.trialDate)
            .trim()
            .split("T")[0];
        }

        const trials: any[] = await strapi.db
          .query("api::gym-trial.gym-trial")
          .findMany({
            where: whereClause,
            populate: {
              client_detail: {
                populate: {
                  selfieUpload: true,
                  user: {
                    select: [
                      "id",
                      "username",
                      "email",
                      "phoneNumber",
                      "fullName",
                    ],
                  },
                },
              },
            },
            orderBy: { trialDate: "desc", createdAt: "desc", id: "desc" },
          });

        // Format trial client list
        const responseData = trials.map((item: any) => {
          const client = item.client_detail;
          const clientName =
            client?.name ||
            client?.user?.fullName ||
            client?.user?.username ||
            "Unknown Client";

          const selfie = client?.selfieUpload;
          const profileImageUrl = getMediaUrl(selfie);

          let trialDateStr: string | null = null;
          if (item.trialDate) {
            if (typeof item.trialDate === "string") {
              trialDateStr = item.trialDate.split("T")[0];
            } else if (item.trialDate instanceof Date) {
              const year = item.trialDate.getFullYear();
              const month = String(item.trialDate.getMonth() + 1).padStart(
                2,
                "0",
              );
              const day = String(item.trialDate.getDate()).padStart(2, "0");
              trialDateStr = `${year}-${month}-${day}`;
            } else {
              trialDateStr = String(item.trialDate);
            }
          } else if (item.createdAt) {
            trialDateStr = String(item.createdAt).split("T")[0];
          }

          const statusStr = item.trialstatus || "booked";

          return {
            id: item.id,
            documentId: item.documentId || null,
            clientName,
            selfieUrl: profileImageUrl,
            trialDate: trialDateStr,
            trialstatus: statusStr,
            createdAt: item.createdAt || null,
            clientId: client?.clientId || null,
            clientDocumentId: client?.documentId || null,
            gender: client?.gender || null,
          };
        });

        // Optional search filter
        let filteredData = responseData;
        if (query.search || query.q) {
          const q = String(query.search || query.q)
            .toLowerCase()
            .trim();
          filteredData = filteredData.filter((item: any) => {
            return (
              (item.clientName && item.clientName.toLowerCase().includes(q)) ||
              (item.clientId && item.clientId.toLowerCase().includes(q)) ||
              (item.email && item.email.toLowerCase().includes(q)) ||
              (item.phoneNumber &&
                item.phoneNumber.toLowerCase().includes(q)) ||
              (item.status && item.status.toLowerCase().includes(q))
            );
          });
        }

        if (query.wrap === "true") {
          return ctx.send({
            clubOwner: {
              id: clubOwner.id,
              documentId: clubOwner.documentId,
              clubId: clubOwner.clubId,
              clubName: clubOwner.clubName,
              ownerName: clubOwner.ownerName,
            },
            total: filteredData.length,
            data: filteredData,
          });
        }

        return ctx.send(filteredData);
      } catch (error) {
        strapi.log.error("ADMIN CLUB OWNER TRIALS ERROR:", error);
        return ctx.internalServerError(
          "Failed to fetch club owner trial client list",
        );
      }
    },

    /* =======================================================
       OVERRIDE CORE FIND
       If requested by a client with Bearer token, return their own trial history.
       Otherwise delegate to core find.
    ======================================================= */
    async find(ctx: Context, next?: any) {
      try {
        const user = await getAuthUser(ctx);
        if (user?.id) {
          const role = await getUserRole(user);
          if (role === "client" || role === "authenticated") {
            return (this as any).myTrialHistory(ctx, next);
          }
        }
      } catch (_) {}
      return super.find(ctx);
    },

    /* =======================================================
       CLIENT: GET OWN TRIAL HISTORY BY AUTH TOKEN
       Endpoint: GET /api/gym-trials/my-trials
                 GET /api/client/my-trials
       Returns: clubname, address, latitude, langtude, trialdate,
                trialStatus, distance when status is booked,
                and info string:
                - booked: "vaild upto gym closing time"
                - complete: "Checked in at {updateAttime}"
                - canceled: "Cancelled by you"
                - no-show: "Not visited by closing time"
    ======================================================= */
    async myTrialHistory(ctx: Context, next?: any) {
      try {
        const user = await getAuthUser(ctx);
        if (!user?.id) {
          return ctx.unauthorized("Authentication required");
        }

        const clientDetail = await resolveClientDetailForUser(user);
        if (!clientDetail?.id) {
          return ctx.notFound(
            "Client profile not found. This endpoint is for registered clients.",
          );
        }

        const rawUserLat =
          ctx.query?.latitude ??
          ctx.query?.lat ??
          clientDetail?.latitude ??
          (ctx.request?.headers?.["x-latitude"] as string | undefined);

        const rawUserLon =
          ctx.query?.longitude ??
          ctx.query?.lon ??
          ctx.query?.lng ??
          clientDetail?.longitude ??
          (ctx.request?.headers?.["x-longitude"] as string | undefined);

        const userLat =
          rawUserLat !== undefined &&
          rawUserLat !== null &&
          !isNaN(Number(rawUserLat))
            ? Number(rawUserLat)
            : null;

        const userLon =
          rawUserLon !== undefined &&
          rawUserLon !== null &&
          !isNaN(Number(rawUserLon))
            ? Number(rawUserLon)
            : null;

        const trials: any[] = await strapi.db
          .query("api::gym-trial.gym-trial")
          .findMany({
            where: {
              client_detail: clientDetail.id,
            },
            populate: {
              club_owner: {
                populate: {
                  logo: true,
                },
              },
            },
            orderBy: { trialDate: "desc", createdAt: "desc", id: "desc" },
          });

        const responseData = trials.map((item: any) => {
          const club = item.club_owner || {};
          const statusRaw = String(item.trialstatus || "booked")
            .toLowerCase()
            .trim();

          // 1. Format date (YYYY-MM-DD)
          let trialDateStr: string | null = null;
          if (item.trialDate) {
            if (typeof item.trialDate === "string") {
              trialDateStr = item.trialDate.split("T")[0];
            } else if (item.trialDate instanceof Date) {
              const year = item.trialDate.getFullYear();
              const month = String(item.trialDate.getMonth() + 1).padStart(
                2,
                "0",
              );
              const day = String(item.trialDate.getDate()).padStart(2, "0");
              trialDateStr = `${year}-${month}-${day}`;
            } else {
              trialDateStr = String(item.trialDate);
            }
          } else if (item.createdAt) {
            trialDateStr = String(item.createdAt).split("T")[0];
          }

          // 2. Format distance only when status is booked
          let distance: number | null = null;
          if (statusRaw === "booked") {
            const clubLat =
              club.latitude !== undefined &&
              club.latitude !== null &&
              !isNaN(Number(club.latitude))
                ? Number(club.latitude)
                : null;
            const clubLon =
              club.longitude !== undefined &&
              club.longitude !== null &&
              !isNaN(Number(club.longitude))
                ? Number(club.longitude)
                : null;

            if (
              userLat !== null &&
              userLon !== null &&
              clubLat !== null &&
              clubLon !== null
            ) {
              const dist = calculateHaversineDistance(
                userLat,
                userLon,
                clubLat,
                clubLon,
              );
              distance = Number(dist.toFixed(2));
            }
          }

          // 3. Format info text based on status:
          // - booked: "vaild upto gym closing time"
          // - complete: "Checked in at {updateAttime}"
          // - canceled: "Cancelled by you"
          // - no-show: "Not visited by closing time"
          let info = "";
          let updateAttime: string | null = null;

          if (statusRaw === "booked") {
            info = "vaild upto gym closing time";
          } else if (statusRaw === "completed" || statusRaw === "complete") {
            if (item.updatedAt) {
              updateAttime = item.updatedAt;
            }
            info = updateAttime
              ? `Checked in at ${updateAttime}`
              : "Checked in";
          } else if (statusRaw === "cancelled" || statusRaw === "canceled") {
            info = "Cancelled by you";
          } else if (statusRaw === "no-show" || statusRaw === "no_show") {
            info = "Not visited by closing time";
          } else {
            info = item.trialstatus || "";
          }

          const clubName = club.clubName || club.name || club.ownerName || null;
          const address = club.clubAddress || club.address || null;
          const lat =
            club.latitude !== undefined && club.latitude !== null
              ? String(club.latitude)
              : null;
          const lon =
            club.longitude !== undefined && club.longitude !== null
              ? String(club.longitude)
              : null;

          const closingTime = getGymClosingTimeForDate(
            club.weekdayScheduling || club.weekday_scheduling,
            trialDateStr,
          );

          return {
            id: item.id,
            documentId: item.documentId || null,
            clubName: clubName,
            clubAddress: address,
            latitude: lat,
            longitude: lon,
            trialDate: trialDateStr,
            trialStatus: item.trialstatus || "booked",
            distance: distance,
            distanceUnit: distance !== null ? "km" : null,
            info: info,
            checkintime: updateAttime,
            closingTime: closingTime,
            createdAt: item.createdAt || null,
            updatedAt: item.updatedAt || null,
          };
        });

        return ctx.send(responseData);
      } catch (error) {
        strapi.log.error("CLIENT TRIAL HISTORY ERROR:", error);
        return ctx.internalServerError("Failed to fetch trial history");
      }
    },

    async myTrials(ctx: Context, next?: any) {
      return (this as any).myTrialHistory(ctx, next);
    },

    /* =======================================================
       CLUB OWNER: GET OWN TRIAL HISTORY BY AUTH TOKEN
       Endpoint: GET /api/gym-trials/club-owner/my-trials
                 GET /api/club-owner/my-trials
                 GET /api/club-owner/trial-guests
       Returns: clientName, clientProfile, trialdate, trialStatus,
                info string according to UI requirements:
                - booked: "vaild upto gym closing time"
                - complete: "Checked in · {updateAt}"
                - canceled: "Cancelled by guest · {updateAt}"
                - no-show: "Not visited by closing time"
                Supports filters:
                - ?filter=all (default)
                - ?filter=today
                - ?filter=tomorrow
                - ?filter=by-date&date=YYYY-MM-DD (or ?date=YYYY-MM-DD)
                - ?status=booked|completed|cancelled|no-show
                - ?search=... or ?q=... (by guest name or phone)
    ======================================================= */
    async ownerTrialHistory(ctx: Context, next?: any) {
      try {
        const user = await getAuthUser(ctx);
        if (!user?.id) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        const isAdmin =
          roleName === "admin" ||
          roleName === "superadmin" ||
          roleName.includes("admin");

        let clubOwner: any = null;

        // If admin queries with query parameter:
        const targetParam =
          ctx.query?.clubOwnerId ||
          ctx.query?.ownerDocId ||
          ctx.query?.clubId ||
          ctx.query?.documentId;
        if (isAdmin && targetParam) {
          clubOwner = await resolveClubOwner(targetParam);
        }

        if (!clubOwner) {
          clubOwner = await resolveClubOwnerForUser(user);
        }

        if (!clubOwner) {
          return ctx.notFound(
            "Club owner profile not found for this user. Only gym owners can access this endpoint.",
          );
        }

        const todayStr = getISTDateString(0);
        const tomorrowStr = getISTDateString(1);

        // Fetch all trials for this club owner
        const allTrials: any[] = await strapi.db
          .query("api::gym-trial.gym-trial")
          .findMany({
            where: {
              club_owner: clubOwner.id,
            },
            populate: {
              client_detail: {
                populate: {
                  selfieUpload: true,
                  user: {
                    select: [
                      "id",
                      "username",
                      "email",
                      "phoneNumber",
                      "fullName",
                    ],
                  },
                },
              },
            },
            orderBy: { trialDate: "desc", createdAt: "desc", id: "desc" },
          });

        const dailyTrialLimit =
          Number(clubOwner.dailyTrialLimit) > 0
            ? Number(clubOwner.dailyTrialLimit)
            : 5;

        // Compute tab counts (All, Today, Tomorrow)
        const tabCounts = {
          all: allTrials.length,
          today: allTrials.filter((t: any) => {
            const d = t.trialDate ? String(t.trialDate).split("T")[0] : "";
            return d === todayStr;
          }).length,
          tomorrow: allTrials.filter((t: any) => {
            const d = t.trialDate ? String(t.trialDate).split("T")[0] : "";
            return d === tomorrowStr;
          }).length,
        };

        // Parse filters from query
        const queryFilter = String(ctx.query?.filter || "")
          .toLowerCase()
          .trim();
        const dateQuery = ctx.query?.date
          ? String(ctx.query.date).trim().split("T")[0]
          : "";
        const statusQuery = ctx.query?.status
          ? String(ctx.query.status).toLowerCase().trim()
          : "";
        const searchQuery = String(ctx.query?.search || ctx.query?.q || "")
          .toLowerCase()
          .trim();

        let filtered = allTrials;

        // Date filter
        if (dateQuery) {
          filtered = filtered.filter((t: any) => {
            const d = t.trialDate ? String(t.trialDate).split("T")[0] : "";
            return d === dateQuery;
          });
        } else if (queryFilter === "today") {
          filtered = filtered.filter((t: any) => {
            const d = t.trialDate ? String(t.trialDate).split("T")[0] : "";
            return d === todayStr;
          });
        } else if (queryFilter === "tomorrow") {
          filtered = filtered.filter((t: any) => {
            const d = t.trialDate ? String(t.trialDate).split("T")[0] : "";
            return d === tomorrowStr;
          });
        }

        // Status filter
        if (statusQuery && statusQuery !== "all") {
          filtered = filtered.filter((t: any) => {
            const st = String(t.trialstatus || "")
              .toLowerCase()
              .trim();
            return st === statusQuery;
          });
        }

        // Search query filter (matches name, phone, email, clientId)
        if (searchQuery) {
          filtered = filtered.filter((t: any) => {
            const c = t.client_detail;
            const name = String(
              c?.name || c?.user?.fullName || c?.user?.username || "",
            ).toLowerCase();
            const phone = String(
              c?.phoneNumber || c?.user?.phoneNumber || "",
            ).toLowerCase();
            const email = String(
              c?.email || c?.user?.email || "",
            ).toLowerCase();
            const cid = String(c?.clientId || "").toLowerCase();
            return (
              name.includes(searchQuery) ||
              phone.includes(searchQuery) ||
              email.includes(searchQuery) ||
              cid.includes(searchQuery)
            );
          });
        }

        // Format trial item
        const formatItem = (item: any) => {
          const client = item.client_detail;
          const clientName =
            client?.name ||
            client?.user?.fullName ||
            client?.user?.username ||
            "Guest";

          const selfie = client?.selfieUpload;
          const profileImageUrl = getMediaUrl(selfie);

          let trialDateStr: string | null = null;
          if (item.trialDate) {
            if (typeof item.trialDate === "string") {
              trialDateStr = item.trialDate.split("T")[0];
            } else if (item.trialDate instanceof Date) {
              const year = item.trialDate.getFullYear();
              const month = String(item.trialDate.getMonth() + 1).padStart(
                2,
                "0",
              );
              const day = String(item.trialDate.getDate()).padStart(2, "0");
              trialDateStr = `${year}-${month}-${day}`;
            } else {
              trialDateStr = String(item.trialDate);
            }
          } else if (item.createdAt) {
            trialDateStr = String(item.createdAt).split("T")[0];
          }

          const statusRaw = String(item.trialstatus || "booked")
            .toLowerCase()
            .trim();
          const updateAt = item.updatedAt;

          let info = "";
          if (statusRaw === "booked") {
            info = "vaild upto gym closing time";
          } else if (statusRaw === "completed" || statusRaw === "complete") {
            info = updateAt ? `Checked in · ${updateAt}` : "Checked in";
          } else if (statusRaw === "cancelled" || statusRaw === "canceled") {
            info = updateAt
              ? `Cancelled by guest · ${updateAt}`
              : "Cancelled by guest";
          } else if (statusRaw === "no-show" || statusRaw === "no_show") {
            info = "Not visited by closing time";
          } else {
            info = item.trialstatus || "";
          }

          const bookedAtText = formatBookedAtText(item.createdAt, todayStr);
          const phone =
            client?.phoneNumber || client?.user?.phoneNumber || null;

          const closingTime = getGymClosingTimeForDate(
            clubOwner.weekdayScheduling || clubOwner.weekday_scheduling,
            trialDateStr,
          );

          return {
            clientName,
            clientProfile: profileImageUrl,
            clientPhone: phone,
            trialDate: trialDateStr,
            trialStatus: item.trialstatus || "booked",
            info,
            bookedAtText,
            closingTime,
            createdAt: item.createdAt || null,
            updatedAt: item.updatedAt || null,
            clientId: client?.clientId || null,
          };
        };

        const formattedTrials = filtered.map(formatItem);

        // Compute summary metrics for the filtered set
        const summary = {
          total: formattedTrials.length,
          checkedIn: formattedTrials.filter((t: any) =>
            String(t.trialStatus).toLowerCase().includes("complete"),
          ).length,
          upcoming: formattedTrials.filter(
            (t: any) => String(t.trialStatus).toLowerCase() === "booked",
          ).length,
          missed: formattedTrials.filter((t: any) => {
            const st = String(t.trialStatus).toLowerCase();
            return st === "no-show" || st === "no_show";
          }).length,
          cancelled: formattedTrials.filter((t: any) =>
            String(t.trialStatus).toLowerCase().includes("cancel"),
          ).length,
        };

        // Group into sections by date for Screen 1 / Screen 4 list views
        const dateGroupsMap = new Map<string, any[]>();
        for (const item of formattedTrials) {
          const d = item.trialDate || "Unknown";
          if (!dateGroupsMap.has(d)) {
            dateGroupsMap.set(d, []);
          }
          dateGroupsMap.get(d)!.push(item);
        }

        const groupedByDate = Array.from(dateGroupsMap.entries()).map(
          ([dateKey, items]) => {
            const filled = items.filter((x: any) => {
              const st = String(x.trialStatus).toLowerCase();
              return st === "booked" || st.includes("complete");
            }).length;

            const displayDate = formatDisplayDate(
              dateKey,
              todayStr,
              tomorrowStr,
            );
            return {
              date: dateKey,
              displayDate,
              headerTitle: displayDate.toUpperCase(),
              capacity: dailyTrialLimit,
              filled,
              capacityText: `${filled} of ${dailyTrialLimit} filled`,
              trials: items,
            };
          },
        );

        // Subgroups for Today & Tomorrow tab layouts (Screen 2 / Screen 3)
        const groups = {
          toArrive: formattedTrials.filter(
            (t: any) => String(t.trialStatus).toLowerCase() === "booked",
          ),
          checkedIn: formattedTrials.filter((t: any) =>
            String(t.trialStatus).toLowerCase().includes("complete"),
          ),
          cancelled: formattedTrials.filter((t: any) =>
            String(t.trialStatus).toLowerCase().includes("cancel"),
          ),
          noShow: formattedTrials.filter((t: any) => {
            const st = String(t.trialStatus).toLowerCase();
            return st === "no-show" || st === "no_show";
          }),
        };

        const todayFilled = allTrials.filter((t: any) => {
          const d = t.trialDate ? String(t.trialDate).split("T")[0] : "";
          const st = String(t.trialstatus || "").toLowerCase();
          return d === todayStr && (st === "booked" || st.includes("complete"));
        }).length;

        const tomorrowFilled = allTrials.filter((t: any) => {
          const d = t.trialDate ? String(t.trialDate).split("T")[0] : "";
          const st = String(t.trialstatus || "").toLowerCase();
          return (
            d === tomorrowStr && (st === "booked" || st.includes("complete"))
          );
        }).length;

        const clubClosingTime = getGymClosingTimeForDate(
          clubOwner.weekdayScheduling || clubOwner.weekday_scheduling,
          todayStr,
        );

        if (ctx.query?.raw === "true" || ctx.query?.format === "flat") {
          return ctx.send(formattedTrials);
        }

        return ctx.send({
          club: {
            todayFilled,
            todaySlotsLeft: Math.max(0, dailyTrialLimit - todayFilled),
            tomorrowFilled,
            tomorrowSlotsOpen: Math.max(0, dailyTrialLimit - tomorrowFilled),
            todayCapacityText: `${todayFilled} of ${dailyTrialLimit} filled`,
            tomorrowCapacityText: `${tomorrowFilled} of ${dailyTrialLimit} filled`,
          },
          tabCounts,
          summary,
          filter: queryFilter || (dateQuery ? "by-date" : "all"),
          selectedDate: dateQuery || null,
          data: formattedTrials,
          trials: formattedTrials,
          groupedByDate,
          groups,
        });
      } catch (error) {
        strapi.log.error("CLUB OWNER TRIAL HISTORY ERROR:", error);
        return ctx.internalServerError(
          "Failed to fetch club owner trial history",
        );
      }
    },

    async clubOwnerTrialHistory(ctx: Context, next?: any) {
      return (this as any).ownerTrialHistory(ctx, next);
    },
  }),
);
