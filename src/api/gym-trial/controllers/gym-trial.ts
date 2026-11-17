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
    client = await strapi.db
      .query("api::client-detail.client-detail")
      .findOne({
        where: { email: user.email },
        populate: { selfieUpload: true },
      });
  }

  // 4. Fallback by phoneNumber
  if (!client && user.phoneNumber) {
    client = await strapi.db
      .query("api::client-detail.client-detail")
      .findOne({
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
          return ctx.badRequest("Invalid trialDate format. Expected YYYY-MM-DD");
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
          const earliestTime = parseDateToTime(
            trialsInLast42Days[0].trialDate,
          );
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
          created = await strapi.db
            .query("api::gym-trial.gym-trial")
            .create({
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
            "Access denied. Only Admin and SuperAdmin can access this endpoint."
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
                ? { $or: [{ id: Number(cleanDocId) }, { documentId: cleanDocId }] }
                : { $or: [{ documentId: cleanDocId }, { clientId: cleanDocId }] },
              select: ["id", "documentId", "clientId", "name"],
            });
        }

        if (!clientDetail) {
          return ctx.notFound(`Client with documentId '${cleanDocId}' not found`);
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

  
    
  }),
);
