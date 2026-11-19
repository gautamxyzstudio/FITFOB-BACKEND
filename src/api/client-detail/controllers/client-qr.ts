import QRCode from "qrcode";
import sharp from "sharp";
import { Context } from "koa";
import { generateClientAssets } from "../../../utils/generateClientId";

/* =======================================================
   HELPERS FOR DATE & CLOSING TIME
======================================================= */

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

function getISTDateString(offsetDays: number = 0): string {
  const now = new Date();
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  const target = new Date(
    now.getTime() + IST_OFFSET + offsetDays * 24 * 60 * 60 * 1000
  );
  const year = target.getUTCFullYear();
  const month = String(target.getUTCMonth() + 1).padStart(2, "0");
  const day = String(target.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getGymClosingTimeForDate(
  scheduling: any,
  dateStr: string | null | undefined
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
    const [year, month, day] = cleanDate.split("-").map(Number);
    const d = new Date(Date.UTC(year, month - 1, day));
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

export default {
  async getQR(ctx: Context) {
    try {
      const user = await getAuthUser(ctx);

      if (!user) {
        return ctx.unauthorized("Login required");
      }

      let client: any = await strapi.db
        .query("api::client-detail.client-detail")
        .findOne({
          where: { user: user.id },
        });

      if (!client) {
        const userWithDetail: any = await strapi.db
          .query("plugin::users-permissions.user")
          .findOne({
            where: { id: user.id },
            populate: { client_detail: true },
          });

        client = userWithDetail?.client_detail || null;
      }

      if (!client) {
        return ctx.notFound("Client profile not found");
      }

      if (!client.clientId) {
        const { clientId } = await generateClientAssets();
        client.clientId = clientId;
        try {
          await strapi.db.query("api::client-detail.client-detail").update({
            where: { id: client.id },
            data: { clientId },
          });
        } catch (_) {}
      }

      /* ============================================
         QR SETTINGS
      ============================================ */

      const width = 500;
      const margin = 2;

      const qrBuffer = await QRCode.toBuffer(client.clientId, {
        errorCorrectionLevel: "H",
        type: "png",
        width,
        margin,
        color: {
          dark: "#111111",
          light: "#FFFFFF",
        },
      });

      /* ============================================
         GET QR MODULE COUNT
      ============================================ */

      const qrData = QRCode.create(client.clientId, {
        errorCorrectionLevel: "H",
      });

      const moduleCount = qrData.modules.size;
      const totalModules = moduleCount + margin * 2;
      const moduleSize = width / totalModules;

      const red = "#E23744";

      /* ============================================
         FINDER CENTER POSITIONS
      ============================================ */

      const innerSize = moduleSize * 3;

      const cleanupPadding = 2;

      const cleanupSize = Math.ceil(innerSize) + cleanupPadding * 2;

      const topLeft = {
        left:
          Math.floor((margin + 2) * moduleSize) -
          cleanupPadding,

        top:
          Math.floor((margin + 2) * moduleSize) -
          cleanupPadding,
      };

      const topRight = {
        left:
          Math.floor(
            (margin + moduleCount - 5) * moduleSize
          ) - cleanupPadding,

        top:
          Math.floor((margin + 2) * moduleSize) -
          cleanupPadding,
      };

      const bottomLeft = {
        left:
          Math.floor((margin + 2) * moduleSize) -
          cleanupPadding,

        top:
          Math.floor(
            (margin + moduleCount - 5) * moduleSize
          ) - cleanupPadding,
      };

      /* ============================================
         CREATE CLEAN FINDER CENTER
      ============================================ */

      const redInset = cleanupPadding;

      const redSize =
        cleanupSize - redInset * 2;

      const finderCenter = Buffer.from(`
        <svg
          width="${cleanupSize}"
          height="${cleanupSize}"
          viewBox="0 0 ${cleanupSize} ${cleanupSize}"
          xmlns="http://www.w3.org/2000/svg"
        >

          <!--
            WHITE CLEANUP AREA

            Slightly larger than original black
            center so no black border survives.
          -->
          <rect
            x="0"
            y="0"
            width="${cleanupSize}"
            height="${cleanupSize}"
            fill="#FFFFFF"
          />

          <!-- RED ROUNDED CENTER -->
          <rect
            x="${redInset}"
            y="${redInset}"
            width="${redSize}"
            height="${redSize}"
            rx="8"
            ry="8"
            fill="${red}"
          />

        </svg>
      `);

      /* ============================================
         APPLY TO ALL 3 FINDER PATTERNS
      ============================================ */

      const styledQR = await sharp(qrBuffer)
        .composite([
          {
            input: finderCenter,
            left: topLeft.left,
            top: topLeft.top,
          },
          {
            input: finderCenter,
            left: topRight.left,
            top: topRight.top,
          },
          {
            input: finderCenter,
            left: bottomLeft.left,
            top: bottomLeft.top,
          },
        ])
        .png()
        .toBuffer();

      /* ============================================
         CONVERT TO BASE64
      ============================================ */

      const qrCode =
        `data:image/png;base64,${styledQR.toString("base64")}`;

      /* ============================================
         FETCH LATEST GYM MEMBERSHIP
      ============================================ */

      let latestGymMembership: any = await strapi.db
        .query("api::gym-membership.gym-membership")
        .findOne({
          where: {
            client_detail: client.id,
          },
          orderBy: { id: "desc" },
        });

      if (
        !latestGymMembership &&
        client.documentId &&
        (strapi as any).documents
      ) {
        const docs = await (strapi as any)
          .documents("api::gym-membership.gym-membership")
          .findMany({
            filters: {
              client_detail: {
                documentId: client.documentId,
              },
            },
            sort: "createdAt:desc",
            limit: 1,
          });
        latestGymMembership = docs?.[0] || null;
      }

      const formattedGymMembership = latestGymMembership
        ? {
            plan: latestGymMembership.duration ?? null,
            duration: latestGymMembership.durationMonths ?? null,
            customerPrice:
              typeof latestGymMembership.customerPriceSnapshot === "string"
                ? parseFloat(latestGymMembership.customerPriceSnapshot)
                : latestGymMembership.customerPriceSnapshot ?? null,
            membershipStatus: latestGymMembership.membershipStatus ?? null,
            startDate: latestGymMembership.startDate ?? null,
            endDate: latestGymMembership.endDate ?? null,
          }
        : null;

      /* ============================================
         FETCH GYM TRIALS (TODAY & TOMORROW)
         trialstatus: 'booked' or 'rescheduled'
      ============================================ */

      const todayStr = getISTDateString(0);
      const tomorrowStr = getISTDateString(1);

      let gymTrials: any[] = await strapi.db
        .query("api::gym-trial.gym-trial")
        .findMany({
          where: {
            client_detail: client.id,
            trialDate: { $in: [todayStr, tomorrowStr] },
            trialstatus: { $in: ["booked", "rescheduled"] },
          },
          populate: {
            club_owner: {
              populate: { logo: true },
            },
          },
          orderBy: { trialDate: "asc", id: "desc" },
        });

      if (
        (!gymTrials || gymTrials.length === 0) &&
        client.documentId &&
        (strapi as any).documents
      ) {
        try {
          const docs = await (strapi as any)
            .documents("api::gym-trial.gym-trial")
            .findMany({
              filters: {
                client_detail: {
                  documentId: client.documentId,
                },
                trialDate: { $in: [todayStr, tomorrowStr] },
                trialstatus: { $in: ["booked", "rescheduled"] },
              },
              populate: {
                club_owner: {
                  populate: { logo: true },
                },
              },
              sort: "trialDate:asc",
            });
          gymTrials = docs || [];
        } catch (_) {}
      }

      const formatTrialItem = (item: any) => {
        if (!item) return null;
        const club = item.club_owner || {};
        const gymName = club.clubName || club.name || club.ownerName || null;
        const trialDateStr = item.trialDate
          ? String(item.trialDate).split("T")[0]
          : null;
        const closingTime = getGymClosingTimeForDate(
          club.weekdayScheduling || club.weekday_scheduling,
          trialDateStr
        );
        const status = item.trialstatus || "booked";
        const isToday = trialDateStr === todayStr;
        const isTomorrow = trialDateStr === tomorrowStr;

        return {
          id: item.id,
          documentId: item.documentId || null,
          gymname: gymName,
          trialDate: trialDateStr,
          trialStatus: status,
          closingTime,
          isToday,
          isTomorrow,
          clubAddress: club.clubAddress || club.address || null,
          latitude: club.latitude || null,
          longitude: club.longitude || null,
        };
      };
      const formattedGymTrials = (gymTrials || []).map(formatTrialItem);

      ctx.send({
        clientId: client.clientId,
        qrCode,
        gymMembership: formattedGymMembership,
        gymTrials: formattedGymTrials,
      });
    } catch (error) {
      console.error("QR generation error:", error);

      return ctx.internalServerError(
        "Failed to generate QR code"
      );
    }
  },
};