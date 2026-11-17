/**
 * holdiday controller
 */

import { factories } from "@strapi/strapi";
import { Context } from "koa";
import axios from "axios";

const HOLDIDAY_UID = "api::holdiday.holdiday" as any;
const CLUB_OWNER_UID = "api::club-owner.club-owner" as any;

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
      populate: ["role"],
    });

  const role =
    fullUser?.role?.name?.toLowerCase().replace(/[\s_-]+/g, "") ||
    fullUser?.role?.type?.toLowerCase().replace(/[\s_-]+/g, "") ||
    "";
  user._cachedRole = role;
  return role;
}

/* ---------- CLUB OWNER LOOKUP FOR AUTH USER ---------- */
async function getClubOwnerForUser(user: any) {
  if (!user) return null;
  const userObj = typeof user === "object" ? user : null;
  const userId = userObj ? userObj.id : user;

  if (userObj?._cachedClubOwner) {
    return userObj._cachedClubOwner;
  }

  // 1. Direct query to club-owner by user relation
  let owner: any = null;
  if (userId) {
    owner = await strapi.db.query(CLUB_OWNER_UID).findOne({
      where: { user: userId },
      select: [
        "id",
        "documentId",
        "clubId",
        "clubName",
        "ownerName",
        "phoneNumber",
        "email",
      ],
    });
  }

  // 2. Fallback via user table populate
  if (!owner && userId) {
    const userWithDetail: any = await strapi.db
      .query("plugin::users-permissions.user")
      .findOne({
        where: { id: userId },
        select: ["id"],
        populate: ["club_owner"],
      });

    owner = userWithDetail?.club_owner || null;
  }

  if (userObj && owner) {
    userObj._cachedClubOwner = owner;
  }

  return owner || null;
}

/* ---------- FIND CLUB OWNER BY IDENTIFIER ---------- */
async function findClubOwnerByIdentifier(identifier: string | number) {
  if (!identifier) return null;
  const val = String(identifier).trim();
  const isNumeric = !isNaN(Number(val)) && /^\d+$/.test(val);

  return await strapi.db.query(CLUB_OWNER_UID).findOne({
    where: isNumeric
      ? {
          $or: [{ id: Number(val) }, { documentId: val }, { clubId: val }],
        }
      : {
          $or: [{ documentId: val }, { clubId: val }],
        },
    select: [
      "id",
      "documentId",
      "clubId",
      "clubName",
      "ownerName",
      "phoneNumber",
      "email",
    ],
  });
}

const POPULATE_CONFIG: any = ["club_owner"];

const FITFOB_LOGO_URL = "https://admin.fitfob.com/logo.png";

const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const MONTHS_SHORT = [
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

const DAYS_OF_WEEK = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function formatCapitalName(name?: string | null): string {
  if (!name) return "Valued Member";
  const trimmed = String(name).trim();
  if (!trimmed) return "Valued Member";
  return trimmed
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function formatReadableDate(
  dateStr?: string | null,
  includeDayOfWeek: boolean = true,
): string {
  if (!dateStr) return "";
  const clean = String(dateStr).split("T")[0].trim();
  const parts = clean.split("-");
  if (parts.length === 3) {
    const year = Number(parts[0]);
    const month = Number(parts[1]) - 1;
    const day = Number(parts[2]);
    if (
      !isNaN(year) &&
      !isNaN(month) &&
      !isNaN(day) &&
      month >= 0 &&
      month < 12
    ) {
      const d = new Date(Date.UTC(year, month, day));
      const dayName = DAYS_OF_WEEK[d.getUTCDay()];
      const monthName = MONTHS_LONG[month];
      if (includeDayOfWeek && dayName) {
        return `${dayName}, ${day} ${monthName} ${year}`;
      }
      return `${day} ${monthName} ${year}`;
    }
  }
  return dateStr;
}

function formatShortDate(dateStr?: string | null): string {
  if (!dateStr) return "";
  const clean = String(dateStr).split("T")[0].trim();
  const parts = clean.split("-");
  if (parts.length === 3) {
    const year = Number(parts[0]);
    const month = Number(parts[1]) - 1;
    const day = Number(parts[2]);
    if (
      !isNaN(year) &&
      !isNaN(month) &&
      !isNaN(day) &&
      month >= 0 &&
      month < 12
    ) {
      return `${day} ${MONTHS_SHORT[month]} ${year}`;
    }
  }
  return dateStr;
}

function formatTimeAMPM(timeStr?: string | null): string {
  if (!timeStr) return "";
  const parts = String(timeStr).split(":");
  if (parts.length >= 2) {
    let hours = parseInt(parts[0], 10);
    const minutes = parts[1];
    if (isNaN(hours)) return String(timeStr);
    const ampm = hours >= 12 ? "PM" : "AM";
    hours = hours % 12;
    hours = hours ? hours : 12;
    return `${hours}:${minutes} ${ampm}`;
  }
  return String(timeStr);
}

function getHolidayEmailTemplate(options: {
  clientName: string;
  gymName: string;
  trialDate: string;
  isFullDay: boolean;
  startTime?: string | null;
  endtime?: string | null;
}): string {
  const { clientName, gymName, trialDate, isFullDay, startTime, endtime } =
    options;

  const formattedClientName = formatCapitalName(clientName);
  const formattedDate = formatReadableDate(trialDate, true);

  const formattedStartTime = formatTimeAMPM(startTime);
  const formattedEndTime = formatTimeAMPM(endtime);
  const timeRange =
    formattedStartTime && formattedEndTime
      ? `${formattedStartTime} - ${formattedEndTime}`
      : startTime && endtime
        ? `${startTime} - ${endtime}`
        : "Partial hours";

  const title = isFullDay
    ? `Holiday Announced at ${gymName}`
    : `Operating Hours Update at ${gymName}`;

  const messageBox = isFullDay
    ? `
      <div style="background-color: #fdf2f4; border: 1.5px solid #e23744; border-radius: 12px; padding: 18px 20px; margin: 20px 0; text-align: left;">
        <p style="margin: 0 0 8px 0; font-size: 15px; font-weight: 700; color: #e23744;">
          🗓️ Full Day Holiday: ${formattedDate}
        </p>
        <p style="margin: 0; font-size: 14px; line-height: 1.5; color: #4a4a4a;">
          The gym owner of <strong>${gymName}</strong> has added a <strong>full-day holiday</strong> for <strong>${formattedDate}</strong>. The gym will be closed for the entire day.
        </p>
      </div>

      <div style="background-color: #f8f9fa; border-radius: 10px; padding: 16px 20px; margin: 20px 0; text-align: left; border-left: 4px solid #3182ce;">
        <p style="margin: 0 0 6px 0; font-size: 14px; font-weight: 600; color: #2d3748;">
          Your Trial Options:
        </p>
        <p style="margin: 0; font-size: 13px; line-height: 1.5; color: #4a5568;">
          You can either <strong>cancel</strong> your trial or <strong>reschedule</strong> it to tomorrow (or another convenient date) directly from the FitFob app.
        </p>
      </div>
    `
    : `
      <div style="background-color: #fffaf0; border: 1.5px solid #dd6b20; border-radius: 12px; padding: 18px 20px; margin: 20px 0; text-align: left;">
        <p style="margin: 0 0 8px 0; font-size: 15px; font-weight: 700; color: #dd6b20;">
          ⏰ Partial Day Closure on ${formattedDate}
        </p>
        <p style="margin: 0 0 10px 0; font-size: 14px; line-height: 1.5; color: #4a4a4a;">
          The gym owner of <strong>${gymName}</strong> has added a partial holiday/closure for <strong>${formattedDate}</strong>.
        </p>
        <p style="margin: 0; font-size: 14px; font-weight: 600; color: #7b341e;">
          ⛔ Closed Timings: <span style="background-color: #feebc8; padding: 3px 8px; border-radius: 6px;">${timeRange}</span>
        </p>
      </div>

      <div style="background-color: #f8f9fa; border-radius: 10px; padding: 16px 20px; margin: 20px 0; text-align: left; border-left: 4px solid #3182ce;">
        <p style="margin: 0 0 6px 0; font-size: 14px; font-weight: 600; color: #2d3748;">
          Important Note:
        </p>
        <p style="margin: 0; font-size: 13px; line-height: 1.5; color: #4a5568;">
          Please make sure to plan your trial visit outside the closed timings. The gym will remain open and welcome your trial session during its normal operating hours outside of this closure period.
        </p>
      </div>
    `;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f6f8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1a1d1e;">
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #f4f6f8; padding: 40px 10px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 540px; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.05); border: 1px solid #eaeaea;">
          
          <!-- Header -->
          <tr>
            <td style="padding: 16px 32px; text-align: center; border-bottom: 1px solid #f0f0f0;">
              <table role="presentation" align="center" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td align="center">
                    <img src="${FITFOB_LOGO_URL}" alt="FitFob Logo" style="display: block; margin: 0 auto; border: 0; width: 100px; height: 35px; object-fit: contain;" />
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Content Body -->
          <tr>
            <td style="padding: 32px 28px;">
              <h2 style="margin: 0 0 16px 0; font-size: 19px; font-weight: 700; color: #1a1d1e; text-align: center;">
                ${title}
              </h2>
              <p style="margin: 0 0 16px 0; font-size: 14px; line-height: 1.5; color: #4a4a4a;">
                Hi <strong>${formattedClientName}</strong>,
              </p>
              <p style="margin: 0 0 16px 0; font-size: 14px; line-height: 1.5; color: #4a4a4a;">
                You have an upcoming gym trial booked at <strong>${gymName}</strong> on <strong>${formattedDate}</strong>.
              </p>

              ${messageBox}

              <hr style="border: none; border-top: 1px solid #f0f0f0; margin: 24px 0;" />

              <p style="margin: 0; font-size: 12px; line-height: 1.4; color: #8c939b; text-align: center;">
                Need help? Open the FitFob app or contact our support team.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #fafbfc; padding: 18px 32px; text-align: center; border-top: 1px solid #f0f0f0;">
              <p style="margin: 0; font-size: 12px; color: #9aa0a6;">
                &copy; ${new Date().getFullYear()} FitFob. All rights reserved.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

async function notifyTrialClientsOnHoliday(options: {
  clubOwner: any;
  startDate: string;
  endDate?: string | null;
  closureType: string;
  startTime?: string | null;
  endtime?: string | null;
}) {
  const { clubOwner, startDate, endDate, closureType, startTime, endtime } =
    options;

  if (!clubOwner) return;

  const actualEndDate = endDate || startDate;
  const isFullDay = closureType === "full_day";
  const gymName = clubOwner.clubName || clubOwner.club_name || "the gym";

  try {
    const ownerFilter: any[] = [{ club_owner: clubOwner.id }];
    if (clubOwner.documentId) {
      ownerFilter.push({ club_owner: { documentId: clubOwner.documentId } });
    }

    const dateCondition: any =
      startDate === actualEndDate
        ? startDate
        : { $gte: startDate, $lte: actualEndDate };

    const bookedTrials: any[] = await strapi.db
      .query("api::gym-trial.gym-trial")
      .findMany({
        where: {
          $or: ownerFilter,
          trialDate: dateCondition,
          trialstatus: "booked",
        },
        populate: {
          client_detail: {
            populate: {
              user: {
                select: ["id", "email", "username"],
              },
            },
          },
        },
      });

    if (!bookedTrials || bookedTrials.length === 0) {
      strapi.log.info(
        `[HolidayNotification] No booked trials found at '${gymName}' for ${startDate} to ${actualEndDate}.`,
      );
      return;
    }

    strapi.log.info(
      `[HolidayNotification] Found ${bookedTrials.length} booked trial(s) at '${gymName}' during holiday (${startDate} to ${actualEndDate}). Sending emails...`,
    );

    const apiKey = process.env.BREVO_API_KEY;
    if (!apiKey) {
      strapi.log.warn(
        "[HolidayNotification] BREVO_API_KEY is not set; skipping email dispatch.",
      );
      return;
    }

    for (const trial of bookedTrials) {
      const client = trial.client_detail;
      const recipientEmail = client?.email || client?.user?.email;
      const rawName = client?.name || client?.user?.username || "Client";
      const formattedClientName = formatCapitalName(rawName);
      const trialDate = trial.trialDate || startDate;
      const shortDate = formatShortDate(trialDate);

      if (!recipientEmail) {
        strapi.log.warn(
          `[HolidayNotification] Skipping trial ID ${trial.id}: No email address found for client.`,
        );
        continue;
      }

      try {
        const subject = isFullDay
          ? `Important: Holiday at ${gymName} on ${shortDate}`
          : `Important: Partial Closure Timings at ${gymName} on ${shortDate}`;

        const htmlContent = getHolidayEmailTemplate({
          clientName: formattedClientName,
          gymName,
          trialDate,
          isFullDay,
          startTime,
          endtime,
        });

        await axios.post(
          "https://api.brevo.com/v3/smtp/email",
          {
            sender: { name: "FitFob", email: "qaxyzstudio@gmail.com" },
            to: [{ email: recipientEmail, name: formattedClientName }],
            subject,
            htmlContent,
          },
          {
            headers: {
              "api-key": apiKey,
              "content-type": "application/json",
            },
          },
        );

        strapi.log.info(
          `[HolidayNotification] Sent email to ${recipientEmail} for trial on ${shortDate}.`,
        );
      } catch (sendErr: any) {
        strapi.log.error(
          `[HolidayNotification] Failed sending email to ${recipientEmail}:`,
          sendErr?.response?.data || sendErr?.message || sendErr,
        );
      }
    }
  } catch (error) {
    strapi.log.error(
      "[HolidayNotification] Error in notifyTrialClientsOnHoliday:",
      error,
    );
  }
}

function getHolidayShiftedEmailTemplate(options: {
  clientName: string;
  gymName: string;
  trialDate: string;
  newHolidayDate?: string | null;
}): string {
  const { clientName, gymName, trialDate, newHolidayDate } = options;

  const formattedClientName = formatCapitalName(clientName);
  const formattedTrialDate = formatReadableDate(trialDate, true);
  const formattedNewDate = newHolidayDate
    ? formatReadableDate(newHolidayDate, true)
    : null;

  const title = `Good News: Gym is Open on ${formatShortDate(trialDate)}!`;

  const shiftedText = formattedNewDate
    ? `The holiday previously scheduled for <strong>${formattedTrialDate}</strong> has been shifted to <strong>${formattedNewDate}</strong>.`
    : `The holiday previously scheduled for <strong>${formattedTrialDate}</strong> has been cancelled by the gym owner.`;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f6f8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1a1d1e;">
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #f4f6f8; padding: 40px 10px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 540px; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.05); border: 1px solid #eaeaea;">
          
          <!-- Header -->
          <tr>
            <td style="padding: 16px 32px; text-align: center; border-bottom: 1px solid #f0f0f0;">
              <table role="presentation" align="center" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td align="center">
                    <img src="${FITFOB_LOGO_URL}" alt="FitFob Logo" style="display: block; margin: 0 auto; border: 0; width: 100px; height: 35px; object-fit: contain;" />
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Content Body -->
          <tr>
            <td style="padding: 32px 28px;">
              <h2 style="margin: 0 0 16px 0; font-size: 19px; font-weight: 700; color: #1a1d1e; text-align: center;">
                ${title}
              </h2>
              <p style="margin: 0 0 16px 0; font-size: 14px; line-height: 1.5; color: #4a4a4a;">
                Hi <strong>${formattedClientName}</strong>,
              </p>
              <p style="margin: 0 0 16px 0; font-size: 14px; line-height: 1.5; color: #4a4a4a;">
                Great news regarding your upcoming gym trial booked at <strong>${gymName}</strong> on <strong>${formattedTrialDate}</strong>.
              </p>

              <!-- Open Status Banner -->
              <div style="background-color: #f0fff4; border: 1.5px solid #38a169; border-radius: 12px; padding: 18px 20px; margin: 20px 0; text-align: left;">
                <p style="margin: 0 0 8px 0; font-size: 15px; font-weight: 700; color: #276749;">
                  ✅ Gym is OPEN on ${formattedTrialDate}
                </p>
                <p style="margin: 0; font-size: 14px; line-height: 1.5; color: #2d3748;">
                  ${shiftedText} <strong>${gymName}</strong> will be <strong>open as usual</strong> on your trial date!
                </p>
              </div>

              <div style="background-color: #f8f9fa; border-radius: 10px; padding: 16px 20px; margin: 20px 0; text-align: left; border-left: 4px solid #38a169;">
                <p style="margin: 0 0 6px 0; font-size: 14px; font-weight: 600; color: #2d3748;">
                  Trial Status:
                </p>
                <p style="margin: 0; font-size: 13px; line-height: 1.5; color: #4a5568;">
                  You can get your trial on <strong>${formattedTrialDate}</strong> if you have not cancelled or rescheduled it yet.
                </p>
              </div>

              <hr style="border: none; border-top: 1px solid #f0f0f0; margin: 24px 0;" />

              <p style="margin: 0; font-size: 12px; line-height: 1.4; color: #8c939b; text-align: center;">
                Need help? Open the FitFob app or contact our support team.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #fafbfc; padding: 18px 32px; text-align: center; border-top: 1px solid #f0f0f0;">
              <p style="margin: 0; font-size: 12px; color: #9aa0a6;">
                &copy; ${new Date().getFullYear()} FitFob. All rights reserved.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

async function notifyTrialClientsOnHolidayShifted(options: {
  clubOwner: any;
  previousStartDate: string;
  previousEndDate?: string | null;
  newStartDate?: string | null;
  newEndDate?: string | null;
}) {
  const {
    clubOwner,
    previousStartDate,
    previousEndDate,
    newStartDate,
    newEndDate,
  } = options;

  if (!clubOwner || !previousStartDate) return;

  const actualPrevEnd = previousEndDate || previousStartDate;
  const actualNewStart = newStartDate || null;
  const actualNewEnd = newEndDate || actualNewStart;
  const gymName = clubOwner.clubName || clubOwner.club_name || "the gym";

  try {
    const ownerFilter: any[] = [{ club_owner: clubOwner.id }];
    if (clubOwner.documentId) {
      ownerFilter.push({ club_owner: { documentId: clubOwner.documentId } });
    }

    const prevDateCondition: any =
      previousStartDate === actualPrevEnd
        ? previousStartDate
        : { $gte: previousStartDate, $lte: actualPrevEnd };

    const bookedTrials: any[] = await strapi.db
      .query("api::gym-trial.gym-trial")
      .findMany({
        where: {
          $or: ownerFilter,
          trialDate: prevDateCondition,
          trialstatus: "booked",
        },
        populate: {
          client_detail: {
            populate: {
              user: {
                select: ["id", "email", "username"],
              },
            },
          },
        },
      });

    if (!bookedTrials || bookedTrials.length === 0) {
      return;
    }

    // Filter out trials that still fall within the new holiday date range (if any)
    const affectedTrials = bookedTrials.filter((trial: any) => {
      const tDate = trial.trialDate;
      if (!tDate) return false;
      if (actualNewStart && actualNewEnd) {
        if (tDate >= actualNewStart && tDate <= actualNewEnd) {
          return false;
        }
      }
      return true;
    });

    if (affectedTrials.length === 0) return;

    strapi.log.info(
      `[HolidayShifted] Found ${affectedTrials.length} booked trial(s) at '${gymName}' on previous holiday date (${previousStartDate} to ${actualPrevEnd}). Sending 'gym is open' emails...`,
    );

    const apiKey = process.env.BREVO_API_KEY;
    if (!apiKey) {
      strapi.log.warn(
        "[HolidayShifted] BREVO_API_KEY is not set; skipping email dispatch.",
      );
      return;
    }

    for (const trial of affectedTrials) {
      const client = trial.client_detail;
      const recipientEmail = client?.email || client?.user?.email;
      const rawName = client?.name || client?.user?.username || "Client";
      const formattedClientName = formatCapitalName(rawName);
      const trialDate = trial.trialDate || previousStartDate;
      const shortDate = formatShortDate(trialDate);

      if (!recipientEmail) continue;

      try {
        const subject = `Good News: Gym is Open on ${shortDate} at ${gymName}!`;

        const htmlContent = getHolidayShiftedEmailTemplate({
          clientName: formattedClientName,
          gymName,
          trialDate,
          newHolidayDate: actualNewStart,
        });

        await axios.post(
          "https://api.brevo.com/v3/smtp/email",
          {
            sender: { name: "FitFob", email: "qaxyzstudio@gmail.com" },
            to: [{ email: recipientEmail, name: formattedClientName }],
            subject,
            htmlContent,
          },
          {
            headers: {
              "api-key": apiKey,
              "content-type": "application/json",
            },
          },
        );

        strapi.log.info(
          `[HolidayShifted] Sent 'gym is open' email to ${recipientEmail} for trial on ${shortDate}.`,
        );
      } catch (sendErr: any) {
        strapi.log.error(
          `[HolidayShifted] Failed sending email to ${recipientEmail}:`,
          sendErr?.response?.data || sendErr?.message || sendErr,
        );
      }
    }
  } catch (error) {
    strapi.log.error(
      "[HolidayShifted] Error in notifyTrialClientsOnHolidayShifted:",
      error,
    );
  }
}

/* =======================================================
   MEMBER HOLIDAY EMAIL TEMPLATES & NOTIFICATION HELPERS
======================================================= */

function getMemberHolidayEmailTemplate(options: {
  clientName: string;
  gymName: string;
  holidayDate: string;
  isFullDay: boolean;
  startTime?: string | null;
  endtime?: string | null;
}): string {
  const { clientName, gymName, holidayDate, isFullDay, startTime, endtime } =
    options;

  const formattedClientName = formatCapitalName(clientName);
  const formattedDate = formatReadableDate(holidayDate, true);

  const formattedStartTime = formatTimeAMPM(startTime);
  const formattedEndTime = formatTimeAMPM(endtime);
  const timeRange =
    formattedStartTime && formattedEndTime
      ? `${formattedStartTime} - ${formattedEndTime}`
      : startTime && endtime
        ? `${startTime} - ${endtime}`
        : "Partial hours";

  const title = isFullDay
    ? `Gym Closure Notice: ${gymName}`
    : `Operating Hours Update: ${gymName}`;

  const messageBox = isFullDay
    ? `
      <div style="background-color: #fdf2f4; border: 1.5px solid #e23744; border-radius: 12px; padding: 18px 20px; margin: 20px 0; text-align: left;">
        <p style="margin: 0 0 8px 0; font-size: 15px; font-weight: 700; color: #e23744;">
          🗓️ Full Day Holiday: ${formattedDate}
        </p>
        <p style="margin: 0; font-size: 14px; line-height: 1.5; color: #4a4a4a;">
          Please be informed that <strong>${gymName}</strong> will remain <strong>closed for the entire day</strong> on <strong>${formattedDate}</strong>.
        </p>
      </div>

      <div style="background-color: #f8f9fa; border-radius: 10px; padding: 16px 20px; margin: 20px 0; text-align: left; border-left: 4px solid #3182ce;">
        <p style="margin: 0 0 6px 0; font-size: 14px; font-weight: 600; color: #2d3748;">
          Notice:
        </p>
        <p style="margin: 0; font-size: 13px; line-height: 1.5; color: #4a5568;">
          Regular workout sessions and gym operations will resume on the next operating day. Thank you for your understanding!
        </p>
      </div>
    `
    : `
      <div style="background-color: #fffaf0; border: 1.5px solid #dd6b20; border-radius: 12px; padding: 18px 20px; margin: 20px 0; text-align: left;">
        <p style="margin: 0 0 8px 0; font-size: 15px; font-weight: 700; color: #dd6b20;">
          ⏰ Partial Day Closure on ${formattedDate}
        </p>
        <p style="margin: 0 0 10px 0; font-size: 14px; line-height: 1.5; color: #4a4a4a;">
          Please note that <strong>${gymName}</strong> will have a partial closure on <strong>${formattedDate}</strong>.
        </p>
        <p style="margin: 0; font-size: 14px; font-weight: 600; color: #7b341e;">
          ⛔ Closed Timings: <span style="background-color: #feebc8; padding: 3px 8px; border-radius: 6px;">${timeRange}</span>
        </p>
      </div>

      <div style="background-color: #f8f9fa; border-radius: 10px; padding: 16px 20px; margin: 20px 0; text-align: left; border-left: 4px solid #3182ce;">
        <p style="margin: 0 0 6px 0; font-size: 14px; font-weight: 600; color: #2d3748;">
           Notice:
        </p>
        <p style="margin: 0; font-size: 13px; line-height: 1.5; color: #4a5568;">
          The gym will remain open and members can enjoy their workout sessions during regular operating hours outside of this closed period. Please plan your workout accordingly.
        </p>
      </div>
    `;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f6f8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1a1d1e;">
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #f4f6f8; padding: 40px 10px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 540px; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.05); border: 1px solid #eaeaea;">
          
          <!-- Header -->
          <tr>
            <td style="padding: 16px 32px; text-align: center; border-bottom: 1px solid #f0f0f0;">
              <table role="presentation" align="center" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td align="center">
                    <img src="${FITFOB_LOGO_URL}" alt="FitFob Logo" style="display: block; margin: 0 auto; border: 0; width: 100px; height: 35px; object-fit: contain;" />
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Content Body -->
          <tr>
            <td style="padding: 32px 28px;">
              <h2 style="margin: 0 0 16px 0; font-size: 19px; font-weight: 700; color: #1a1d1e; text-align: center;">
                ${title}
              </h2>
              <p style="margin: 0 0 16px 0; font-size: 14px; line-height: 1.5; color: #4a4a4a;">
                Hi <strong>${formattedClientName}</strong>,
              </p>
              <p style="margin: 0 0 16px 0; font-size: 14px; line-height: 1.5; color: #4a4a4a;">
                This is an important update regarding your gym membership at <strong>${gymName}</strong>.
              </p>

              ${messageBox}

              <hr style="border: none; border-top: 1px solid #f0f0f0; margin: 24px 0;" />

              <p style="margin: 0; font-size: 12px; line-height: 1.4; color: #8c939b; text-align: center;">
                Have questions? Open the FitFob app or contact your gym desk.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #fafbfc; padding: 18px 32px; text-align: center; border-top: 1px solid #f0f0f0;">
              <p style="margin: 0; font-size: 12px; color: #9aa0a6;">
                &copy; ${new Date().getFullYear()} FitFob. All rights reserved.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

function getMemberHolidayShiftedEmailTemplate(options: {
  clientName: string;
  gymName: string;
  previousDate: string;
  newHolidayDate?: string | null;
}): string {
  const { clientName, gymName, previousDate, newHolidayDate } = options;

  const formattedClientName = formatCapitalName(clientName);
  const formattedPrevDate = formatReadableDate(previousDate, true);
  const formattedNewDate = newHolidayDate
    ? formatReadableDate(newHolidayDate, true)
    : null;

  const title = `Good News: ${gymName} is Open on ${formatShortDate(previousDate)}!`;

  const shiftedText = formattedNewDate
    ? `The holiday previously scheduled for <strong>${formattedPrevDate}</strong> has been shifted to <strong>${formattedNewDate}</strong>.`
    : `The holiday previously scheduled for <strong>${formattedPrevDate}</strong> has been cancelled.`;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f6f8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1a1d1e;">
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #f4f6f8; padding: 40px 10px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 540px; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.05); border: 1px solid #eaeaea;">
          
          <!-- Header -->
          <tr>
            <td style="padding: 16px 32px; text-align: center; border-bottom: 1px solid #f0f0f0;">
              <table role="presentation" align="center" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td align="center">
                    <img src="${FITFOB_LOGO_URL}" alt="FitFob Logo" style="display: block; margin: 0 auto; border: 0; width: 100px; height: 35px; object-fit: contain;" />
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Content Body -->
          <tr>
            <td style="padding: 32px 28px;">
              <h2 style="margin: 0 0 16px 0; font-size: 19px; font-weight: 700; color: #1a1d1e; text-align: center;">
                ${title}
              </h2>
              <p style="margin: 0 0 16px 0; font-size: 14px; line-height: 1.5; color: #4a4a4a;">
                Hi <strong>${formattedClientName}</strong>,
              </p>
              <p style="margin: 0 0 16px 0; font-size: 14px; line-height: 1.5; color: #4a4a4a;">
                We have an update regarding operating hours at <strong>${gymName}</strong>.
              </p>

              <!-- Open Status Banner -->
              <div style="background-color: #f0fff4; border: 1.5px solid #38a169; border-radius: 12px; padding: 18px 20px; margin: 20px 0; text-align: left;">
                <p style="margin: 0 0 8px 0; font-size: 15px; font-weight: 700; color: #276749;">
                  ✅ Gym is OPEN as Usual on ${formattedPrevDate}
                </p>
                <p style="margin: 0; font-size: 14px; line-height: 1.5; color: #2d3748;">
                  ${shiftedText} <strong>${gymName}</strong> will remain <strong>open for regular workouts</strong> on <strong>${formattedPrevDate}</strong>!
                </p>
              </div>

              <div style="background-color: #f8f9fa; border-radius: 10px; padding: 16px 20px; margin: 20px 0; text-align: left; border-left: 4px solid #38a169;">
                <p style="margin: 0 0 6px 0; font-size: 14px; font-weight: 600; color: #2d3748;">
                  Workout as Scheduled:
                </p>
                <p style="margin: 0; font-size: 13px; line-height: 1.5; color: #4a5568;">
                  You are welcome to visit the gym and enjoy your session during regular hours on <strong>${formattedPrevDate}</strong>.
                </p>
              </div>

              <hr style="border: none; border-top: 1px solid #f0f0f0; margin: 24px 0;" />

              <p style="margin: 0; font-size: 12px; line-height: 1.4; color: #8c939b; text-align: center;">
                Need help? Open the FitFob app or contact your gym desk.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #fafbfc; padding: 18px 32px; text-align: center; border-top: 1px solid #f0f0f0;">
              <p style="margin: 0; font-size: 12px; color: #9aa0a6;">
                &copy; ${new Date().getFullYear()} FitFob. All rights reserved.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

async function notifyActiveMembersOnHoliday(options: {
  clubOwner: any;
  startDate: string;
  endDate?: string | null;
  closureType: string;
  startTime?: string | null;
  endtime?: string | null;
}) {
  const { clubOwner, startDate, endDate, closureType, startTime, endtime } =
    options;

  if (!clubOwner) return;

  const isFullDay = closureType === "full_day";
  const gymName = clubOwner.clubName || clubOwner.club_name || "the gym";

  try {
    const contracts = await strapi.db
      .query("api::gym-contract.gym-contract")
      .findMany({
        where: {
          $or: [
            { club_owner: clubOwner.id },
            ...(clubOwner.documentId
              ? [{ club_owner: { documentId: clubOwner.documentId } }]
              : []),
          ],
        },
        select: ["id", "documentId", "contractId"],
      });

    const contractIds = (contracts || []).map((c: any) => c.id);
    if (contractIds.length === 0) return;

    const activeMemberships: any[] = await strapi.db
      .query("api::gym-membership.gym-membership")
      .findMany({
        where: {
          gym_contract: { id: { $in: contractIds } },
          membershipStatus: "active",
          endDate: { $gte: startDate },
        },
        populate: {
          client_detail: {
            populate: {
              user: {
                select: ["id", "email", "username"],
              },
            },
          },
        },
      });

    if (!activeMemberships || activeMemberships.length === 0) {
      strapi.log.info(
        `[MemberHolidayNotification] No active members found at '${gymName}' for ${startDate}.`,
      );
      return;
    }

    const apiKey = process.env.BREVO_API_KEY;
    if (!apiKey) {
      strapi.log.warn(
        "[MemberHolidayNotification] BREVO_API_KEY is not set; skipping email dispatch.",
      );
      return;
    }

    const seenEmails = new Set<string>();
    const shortDate = formatShortDate(startDate);
    const subject = isFullDay
      ? `Gym Closure Notice: ${gymName} is Closed on ${shortDate}`
      : `Operating Hours Notice: Partial Closure at ${gymName} on ${shortDate}`;

    for (const m of activeMemberships) {
      const client = m.client_detail;
      const recipientEmail = client?.email || client?.user?.email;
      if (!recipientEmail) continue;

      const normEmail = String(recipientEmail).trim().toLowerCase();
      if (seenEmails.has(normEmail)) continue;
      seenEmails.add(normEmail);

      const rawName = client?.name || client?.user?.username || "Member";
      const formattedClientName = formatCapitalName(rawName);

      try {
        const htmlContent = getMemberHolidayEmailTemplate({
          clientName: formattedClientName,
          gymName,
          holidayDate: startDate,
          isFullDay,
          startTime,
          endtime,
        });

        await axios.post(
          "https://api.brevo.com/v3/smtp/email",
          {
            sender: { name: "FitFob", email: "qaxyzstudio@gmail.com" },
            to: [{ email: normEmail, name: formattedClientName }],
            subject,
            htmlContent,
          },
          {
            headers: {
              "api-key": apiKey,
              "content-type": "application/json",
            },
          },
        );

        strapi.log.info(
          `[MemberHolidayNotification] Sent holiday notice to member ${normEmail} for ${shortDate}.`,
        );
      } catch (sendErr: any) {
        strapi.log.error(
          `[MemberHolidayNotification] Failed sending email to ${normEmail}:`,
          sendErr?.response?.data || sendErr?.message || sendErr,
        );
      }
    }
  } catch (error) {
    strapi.log.error(
      "[MemberHolidayNotification] Error in notifyActiveMembersOnHoliday:",
      error,
    );
  }
}

async function notifyActiveMembersOnHolidayShifted(options: {
  clubOwner: any;
  previousStartDate: string;
  previousEndDate?: string | null;
  newStartDate?: string | null;
  newEndDate?: string | null;
}) {
  const {
    clubOwner,
    previousStartDate,
    previousEndDate,
    newStartDate,
    newEndDate,
  } = options;

  if (!clubOwner || !previousStartDate) return;

  const actualNewStart = newStartDate || null;
  const actualNewEnd = newEndDate || actualNewStart;
  const gymName = clubOwner.clubName || clubOwner.club_name || "the gym";

  if (actualNewStart && actualNewEnd) {
    if (
      previousStartDate >= actualNewStart &&
      previousStartDate <= actualNewEnd
    ) {
      return;
    }
  }

  try {
    const contracts = await strapi.db
      .query("api::gym-contract.gym-contract")
      .findMany({
        where: {
          $or: [
            { club_owner: clubOwner.id },
            ...(clubOwner.documentId
              ? [{ club_owner: { documentId: clubOwner.documentId } }]
              : []),
          ],
        },
        select: ["id", "documentId", "contractId"],
      });

    const contractIds = (contracts || []).map((c: any) => c.id);
    if (contractIds.length === 0) return;

    const activeMemberships: any[] = await strapi.db
      .query("api::gym-membership.gym-membership")
      .findMany({
        where: {
          gym_contract: { id: { $in: contractIds } },
          membershipStatus: "active",
          endDate: { $gte: previousStartDate },
        },
        populate: {
          client_detail: {
            populate: {
              user: {
                select: ["id", "email", "username"],
              },
            },
          },
        },
      });

    if (!activeMemberships || activeMemberships.length === 0) return;

    const apiKey = process.env.BREVO_API_KEY;
    if (!apiKey) return;

    const seenEmails = new Set<string>();
    const shortDate = formatShortDate(previousStartDate);
    const subject = `Good News: ${gymName} is Open on ${shortDate}!`;

    for (const m of activeMemberships) {
      const client = m.client_detail;
      const recipientEmail = client?.email || client?.user?.email;
      if (!recipientEmail) continue;

      const normEmail = String(recipientEmail).trim().toLowerCase();
      if (seenEmails.has(normEmail)) continue;
      seenEmails.add(normEmail);

      const rawName = client?.name || client?.user?.username || "Member";
      const formattedClientName = formatCapitalName(rawName);

      try {
        const htmlContent = getMemberHolidayShiftedEmailTemplate({
          clientName: formattedClientName,
          gymName,
          previousDate: previousStartDate,
          newHolidayDate: actualNewStart,
        });

        await axios.post(
          "https://api.brevo.com/v3/smtp/email",
          {
            sender: { name: "FitFob", email: "qaxyzstudio@gmail.com" },
            to: [{ email: normEmail, name: formattedClientName }],
            subject,
            htmlContent,
          },
          {
            headers: {
              "api-key": apiKey,
              "content-type": "application/json",
            },
          },
        );

        strapi.log.info(
          `[MemberHolidayShifted] Sent 'gym is open' email to member ${normEmail} for ${shortDate}.`,
        );
      } catch (sendErr: any) {
        strapi.log.error(
          `[MemberHolidayShifted] Failed sending email to ${normEmail}:`,
          sendErr?.response?.data || sendErr?.message || sendErr,
        );
      }
    }
  } catch (error) {
    strapi.log.error(
      "[MemberHolidayShifted] Error in notifyActiveMembersOnHolidayShifted:",
      error,
    );
  }
}

export default factories.createCoreController(
  "api::holdiday.holdiday" as any,
  ({ strapi }) => ({
    /* =======================================================
       1. FIND ALL HOLIDAYS
       - Admin / SuperAdmin can access all holidays across all gyms
       - Club Owner can ONLY see their own gym's holidays
    ======================================================= */
    async find(ctx: Context) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const roleName = await getUserRole(user);
        const isAdmin = roleName === "admin" || roleName === "superadmin";

        const {
          clubOwnerId,
          clubId,
          club_owner,
          date,
          startDate,
          endDate,
          closureType,
          search,
          sort,
        } = ctx.query as any;

        const andClauses: any[] = [];

        // ============================================================
        // SCOPING LOGIC: ADMIN vs CLUB OWNER
        // ============================================================
        if (!isAdmin) {
          // Club Owner: Strictly scoped to their own gym only
          const owner = await getClubOwnerForUser(user);

          if (!owner) {
            return ctx.forbidden(
              "Access denied. Club owner profile not found for this user.",
            );
          }

          andClauses.push({ club_owner: owner.id });
        } else {
          // Admin / SuperAdmin: Can view all, or optionally filter by club
          const targetClubIdentifier = clubOwnerId || clubId || club_owner;

          if (targetClubIdentifier) {
            const targetOwner = await findClubOwnerByIdentifier(
              targetClubIdentifier,
            );

            if (targetOwner) {
              andClauses.push({ club_owner: targetOwner.id });
            } else {
              return ctx.send({
                data: [],
                meta: {
                  total: 0,
                },
              });
            }
          }
        }

        // ============================================================
        // DATE FILTERS
        // ============================================================
        if (date) {
          const targetDate = String(date).trim();
          andClauses.push({
            startDate: { $lte: targetDate },
            $or: [
              { endDate: { $gte: targetDate } },
              { endDate: { $null: true } },
            ],
          });
        } else if (startDate || endDate) {
          if (startDate) {
            andClauses.push({ startDate: { $gte: String(startDate).trim() } });
          }
          if (endDate) {
            andClauses.push({ endDate: { $lte: String(endDate).trim() } });
          }
        }

        // ============================================================
        // CLOSURE TYPE FILTER (full_day / partial_day)
        // ============================================================
        if (closureType) {
          const ct = String(closureType).toLowerCase().trim();
          if (ct === "full_day" || ct === "partial_day") {
            andClauses.push({ closureType: ct });
          }
        }

        // ============================================================
        // KEYWORD SEARCH
        // ============================================================
        if (search && String(search).trim()) {
          const s = String(search).trim();
          andClauses.push({ title: { $containsi: s } });
        }

        const where: any =
          andClauses.length > 1
            ? { $and: andClauses }
            : andClauses.length === 1
            ? andClauses[0]
            : {};

        // ============================================================
        // SORTING
        // ============================================================
        let orderBy: any = { startDate: "desc", id: "desc" };
        if (sort) {
          const parts = String(sort).split(":");
          if (parts.length === 2) {
            orderBy = { [parts[0]]: parts[1].toLowerCase() };
          } else if (parts.length === 1) {
            orderBy = { [parts[0]]: "desc" };
          }
        }

        // Fetch records using db.query
        let holidays: any[] = [];
        try {
          holidays = await strapi.db.query(HOLDIDAY_UID).findMany({
            where,
            populate: POPULATE_CONFIG,
            orderBy,
          });
        } catch (dbErr) {
          strapi.log.warn("db.query findMany fallback in holiday find:", dbErr);
          if ((strapi as any).documents) {
            holidays = await (strapi as any).documents(HOLDIDAY_UID).findMany({
              filters: where,
              populate: POPULATE_CONFIG,
            });
          }
        }

        return ctx.send({
          data: holidays || [],
          meta: {
            total: (holidays || []).length,
          },
        });
      } catch (error) {
        strapi.log.error("FIND HOLIDAYS ERROR:", error);
        return ctx.internalServerError("Failed to fetch holidays");
      }
    },

    /* =======================================================
       2. FIND ONE HOLIDAY BY ID
       - Admin / SuperAdmin can view any holiday
       - Club Owner can ONLY view their own gym's holiday
    ======================================================= */
    async findOne(ctx: Context) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const { id } = ctx.params;
        const identifier = String(id || "").trim();

        if (!identifier) {
          return ctx.badRequest("Holiday ID is required");
        }

        const isNumeric =
          !isNaN(Number(identifier)) && /^\d+$/.test(identifier);

        let holiday: any = null;

        if (isNumeric) {
          holiday = await strapi.db.query(HOLDIDAY_UID).findOne({
            where: { id: Number(identifier) },
            populate: POPULATE_CONFIG,
          });
        }

        if (!holiday) {
          holiday = await strapi.db.query(HOLDIDAY_UID).findOne({
            where: { documentId: identifier },
            populate: POPULATE_CONFIG,
          });
        }

        if (!holiday && (strapi as any).documents) {
          try {
            holiday = await (strapi as any).documents(HOLDIDAY_UID).findOne({
              documentId: identifier,
              populate: POPULATE_CONFIG,
            });
          } catch (docErr) {}
        }

        if (!holiday) {
          return ctx.notFound(`Holiday '${identifier}' not found`);
        }

        const roleName = await getUserRole(user);
        const isAdmin = roleName === "admin" || roleName === "superadmin";

        // If not Admin/SuperAdmin, verify ownership
        if (!isAdmin) {
          const owner = await getClubOwnerForUser(user);

          if (!owner) {
            return ctx.forbidden(
              "Access denied. Club owner profile not found for this user.",
            );
          }

          const holidayClubOwnerId =
            holiday.club_owner?.id ||
            holiday.club_owner?.documentId ||
            holiday.club_owner;

          const isOwnerMatch =
            holidayClubOwnerId &&
            (String(holidayClubOwnerId) === String(owner.id) ||
              (owner.documentId &&
                String(holidayClubOwnerId) === String(owner.documentId)));

          if (!isOwnerMatch) {
            return ctx.forbidden(
              "Access denied. You can only view holidays for your own gym.",
            );
          }
        }

        return ctx.send({
          data: holiday,
        });
      } catch (error) {
        strapi.log.error("FIND ONE HOLIDAY ERROR:", error);
        return ctx.internalServerError("Failed to fetch holiday");
      }
    },

    /* =======================================================
       3. CREATE HOLIDAY
    ======================================================= */
    async create(ctx: Context) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized(
            "Authentication required. Please provide a valid Bearer token.",
          );
        }

        const roleName = await getUserRole(user);
        const isAdmin = roleName === "admin" || roleName === "superadmin";

        if (isAdmin) {
          return ctx.forbidden(
            "Admins cannot create holidays. Only club owners can create holidays for their gym.",
          );
        }

        // Club Owner: Extract club owner from the Bearer token's user
        const targetOwner = await getClubOwnerForUser(user);

        if (!targetOwner) {
          return ctx.forbidden(
            "Access denied. Club owner profile not found for this account. Only registered club owners can create holidays.",
          );
        }

        const body = (ctx.request.body as any) ?? {};
        const data = body.data ?? body;

        if (!data || typeof data !== "object") {
          return ctx.badRequest("Holiday data is required in request body");
        }

        // Validate start date
        const startDate = data.startDate || data.date;
        if (!startDate) {
          return ctx.badRequest("startDate is required (e.g. '2026-10-15')");
        }
        const endDate = data.endDate || startDate;

        // Determine closureType (full_day / partial_day)
        const closureType =
          data.closureType ||
          (data.startTime || data.endtime || data.fromTime || data.toTime
            ? "partial_day"
            : "full_day");

        // Format times if partial day
        const startTime = data.startTime || data.fromTime || null;
        const endtime = data.endtime || data.toTime || null;

        const payload: any = {
          title:
            data.title ||
            (closureType === "full_day"
              ? `Holiday (${startDate})`
              : `Closure (${startDate} ${startTime || ""}-${endtime || ""})`),
          closureType,
          startDate,
          endDate,
          startTime,
          endtime,
          club_owner: targetOwner.documentId || targetOwner.id,
          publishedAt: new Date(),
        };

        let created: any = null;
        if ((strapi as any).documents) {
          try {
            created = await (strapi as any).documents(HOLDIDAY_UID).create({
              data: payload,
              populate: POPULATE_CONFIG,
            });
          } catch (docErr) {
            strapi.log.warn(
              "documents.create fallback in holiday create:",
              docErr,
            );
          }
        }

        if (!created) {
          created = await strapi.entityService.create(HOLDIDAY_UID, {
            data: payload,
            populate: POPULATE_CONFIG,
          });
        }

        // 📝 Log Activity
        try {
          const activityLogService: any = strapi.service(
            "api::activity-log.activity-log",
          );
          if (activityLogService?.createActivityLog) {
            const targetOwnerId = targetOwner.documentId || targetOwner.id;
            const closureLabel =
              created?.closureType === "partial_day"
                ? `Partial Day (${created?.startTime || ""} - ${created?.endtime || ""})`
                : "Full Day";
            const dateRange =
              created?.startDate === created?.endDate || !created?.endDate
                ? created?.startDate
                : `${created?.startDate} to ${created?.endDate}`;

            await activityLogService.createActivityLog({
              actorType: "club_owner",
              actorId: targetOwnerId,
              actionType: "create",
              entityName: "Holiday",
              entityId: created?.documentId || created?.id,
              description: `Created holiday '${created?.title || payload.title}' (${closureLabel}, Date: ${dateRange})`,
            });
          }
        } catch (logErr) {
          strapi.log.warn("[ActivityLog] Failed to log holiday creation:", logErr);
        }

        // 📧 Notify booked trial clients if holiday affects their trial date
        notifyTrialClientsOnHoliday({
          clubOwner: targetOwner,
          startDate,
          endDate,
          closureType,
          startTime,
          endtime,
        }).catch((notifyErr) => {
          strapi.log.error(
            "[Holiday:create] Error in notifyTrialClientsOnHoliday:",
            notifyErr,
          );
        });

        // 📧 Notify active gym members of closure / holiday timings
        notifyActiveMembersOnHoliday({
          clubOwner: targetOwner,
          startDate,
          endDate,
          closureType,
          startTime,
          endtime,
        }).catch((memberErr) => {
          strapi.log.error(
            "[Holiday:create] Error in notifyActiveMembersOnHoliday:",
            memberErr,
          );
        });

        return ctx.send({
          data: created,
        });
      } catch (error: any) {
        strapi.log.error("CREATE HOLIDAY ERROR:", error);
        return ctx.internalServerError(
          error.message || "Failed to create holiday",
        );
      }
    },

    /* =======================================================
       4. UPDATE HOLIDAY
       - Club Owner: can only update holidays for their own gym
       - Admin: can update any holiday
    ======================================================= */
    async update(ctx: Context) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const { id } = ctx.params;
        const identifier = String(id || "").trim();

        if (!identifier) {
          return ctx.badRequest("Holiday ID is required");
        }

        const isNumeric =
          !isNaN(Number(identifier)) && /^\d+$/.test(identifier);
        const existing = await strapi.db.query(HOLDIDAY_UID).findOne({
          where: isNumeric
            ? { $or: [{ id: Number(identifier) }, { documentId: identifier }] }
            : { documentId: identifier },
          populate: POPULATE_CONFIG,
        });

        if (!existing) {
          return ctx.notFound(`Holiday '${identifier}' not found`);
        }

        const roleName = await getUserRole(user);
        const isAdmin = roleName === "admin" || roleName === "superadmin";

        let owner: any = null;
        if (!isAdmin) {
          owner = await getClubOwnerForUser(user);

          if (!owner) {
            return ctx.forbidden(
              "Access denied. Club owner profile not found for this user.",
            );
          }

          const existingClubOwnerId =
            existing.club_owner?.id || existing.club_owner;

          if (
            !existingClubOwnerId ||
            Number(existingClubOwnerId) !== Number(owner.id)
          ) {
            return ctx.forbidden(
              "Access denied. You can only update holidays for your own gym.",
            );
          }
        }

        const body = (ctx.request.body as any) ?? {};
        const data = body.data ?? body;

        const updateData: any = { ...data };
        delete updateData.club_owner; // Prevent changing ownership unless admin explicitly handles it

        let updated: any = null;
        if ((strapi as any).documents && existing.documentId) {
          try {
            updated = await (strapi as any).documents(HOLDIDAY_UID).update({
              documentId: existing.documentId,
              data: updateData,
              populate: POPULATE_CONFIG,
            });
          } catch (docErr) {
            strapi.log.warn(
              "documents.update fallback in holiday update:",
              docErr,
            );
          }
        }

        if (!updated) {
          updated = await strapi.entityService.update(
            HOLDIDAY_UID,
            existing.id,
            {
              data: updateData,
              populate: POPULATE_CONFIG,
            },
          );
        }

        // 📝 Log Activity
        const targetOwnerId =
          owner?.documentId ||
          owner?.id ||
          existing.club_owner?.documentId ||
          existing.club_owner?.id ||
          existing.club_owner;

        if (targetOwnerId) {
          try {
            const activityLogService: any = strapi.service(
              "api::activity-log.activity-log",
            );
            if (activityLogService?.createActivityLog) {
              const changedDetails: string[] = [];

              if (
                updateData.title !== undefined &&
                updateData.title !== existing.title
              ) {
                changedDetails.push(
                  `title: '${existing.title ?? ""}' -> '${updateData.title}'`,
                );
              }
              if (
                updateData.closureType !== undefined &&
                updateData.closureType !== existing.closureType
              ) {
                changedDetails.push(
                  `closureType: '${existing.closureType}' -> '${updateData.closureType}'`,
                );
              }
              if (
                updateData.startDate !== undefined &&
                updateData.startDate !== existing.startDate
              ) {
                changedDetails.push(
                  `startDate: '${existing.startDate}' -> '${updateData.startDate}'`,
                );
              }
              if (
                updateData.endDate !== undefined &&
                updateData.endDate !== existing.endDate
              ) {
                changedDetails.push(
                  `endDate: '${existing.endDate}' -> '${updateData.endDate}'`,
                );
              }
              if (
                updateData.startTime !== undefined &&
                updateData.startTime !== existing.startTime
              ) {
                changedDetails.push(
                  `startTime: '${existing.startTime}' -> '${updateData.startTime}'`,
                );
              }
              if (
                updateData.endtime !== undefined &&
                updateData.endtime !== existing.endtime
              ) {
                changedDetails.push(
                  `endtime: '${existing.endtime}' -> '${updateData.endtime}'`,
                );
              }

              const changesStr =
                changedDetails.length > 0
                  ? ` (${changedDetails.join(", ")})`
                  : "";

              await activityLogService.createActivityLog({
                actorType: "club_owner",
                actorId: targetOwnerId,
                actionType: "update",
                entityName: "Holiday",
                entityId: existing.documentId || existing.id,
                description: `Updated holiday '${existing.title || "Holiday"}'${changesStr}`,
              });
            }
          } catch (logErr) {
            strapi.log.warn("[ActivityLog] Failed to log holiday update:", logErr);
          }
        }

        // 📧 Notify booked trial clients if holiday affects their trial date
        const updatedOwner =
          owner ||
          (existing.club_owner && typeof existing.club_owner === "object"
            ? existing.club_owner
            : null);

        if (updatedOwner) {
          const previousStartDate = existing.startDate;
          const previousEndDate = existing.endDate || existing.startDate;

          const finalStartDate =
            updated?.startDate || data.startDate || existing.startDate;
          const finalEndDate =
            updated?.endDate || data.endDate || existing.endDate || finalStartDate;
          const finalClosureType =
            updated?.closureType || data.closureType || existing.closureType || "full_day";
          const finalStartTime =
            updated?.startTime !== undefined
              ? updated.startTime
              : data.startTime !== undefined
                ? data.startTime
                : existing.startTime;
          const finalEndTime =
            updated?.endtime !== undefined
              ? updated.endtime
              : data.endtime !== undefined
                ? data.endtime
                : existing.endtime;

          // 1. Notify trials & active members on the NEW holiday date(s)
          notifyTrialClientsOnHoliday({
            clubOwner: updatedOwner,
            startDate: finalStartDate,
            endDate: finalEndDate,
            closureType: finalClosureType,
            startTime: finalStartTime,
            endtime: finalEndTime,
          }).catch((notifyErr) => {
            strapi.log.error(
              "[Holiday:update] Error in notifyTrialClientsOnHoliday:",
              notifyErr,
            );
          });

          notifyActiveMembersOnHoliday({
            clubOwner: updatedOwner,
            startDate: finalStartDate,
            endDate: finalEndDate,
            closureType: finalClosureType,
            startTime: finalStartTime,
            endtime: finalEndTime,
          }).catch((memberErr) => {
            strapi.log.error(
              "[Holiday:update] Error in notifyActiveMembersOnHoliday:",
              memberErr,
            );
          });

          // 2. If holiday date shifted, notify trials & active members on the PREVIOUS date that gym is open!
          if (
            previousStartDate &&
            (previousStartDate !== finalStartDate || previousEndDate !== finalEndDate)
          ) {
            notifyTrialClientsOnHolidayShifted({
              clubOwner: updatedOwner,
              previousStartDate,
              previousEndDate,
              newStartDate: finalStartDate,
              newEndDate: finalEndDate,
            }).catch((shiftedErr) => {
              strapi.log.error(
                "[Holiday:update] Error in notifyTrialClientsOnHolidayShifted:",
                shiftedErr,
              );
            });

            notifyActiveMembersOnHolidayShifted({
              clubOwner: updatedOwner,
              previousStartDate,
              previousEndDate,
              newStartDate: finalStartDate,
              newEndDate: finalEndDate,
            }).catch((memberShiftedErr) => {
              strapi.log.error(
                "[Holiday:update] Error in notifyActiveMembersOnHolidayShifted:",
                memberShiftedErr,
              );
            });
          }
        }

        return ctx.send({
          success: true,
          message: "Holiday updated successfully",
          data: updated,
        });
      } catch (error: any) {
        strapi.log.error("UPDATE HOLIDAY ERROR:", error);
        return ctx.internalServerError(
          error.message || "Failed to update holiday",
        );
      }
    },

    /* =======================================================
       5. DELETE HOLIDAY
       - Club Owner: can only delete holidays for their own gym
       - Admin: can delete any holiday
    ======================================================= */
    async delete(ctx: Context) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized("Authentication required");
        }

        const { id } = ctx.params;
        const identifier = String(id || "").trim();

        if (!identifier) {
          return ctx.badRequest("Holiday ID is required");
        }

        const isNumeric =
          !isNaN(Number(identifier)) && /^\d+$/.test(identifier);
        const existing = await strapi.db.query(HOLDIDAY_UID).findOne({
          where: isNumeric
            ? { $or: [{ id: Number(identifier) }, { documentId: identifier }] }
            : { documentId: identifier },
          populate: POPULATE_CONFIG,
        });

        if (!existing) {
          return ctx.notFound(`Holiday '${identifier}' not found`);
        }

        const roleName = await getUserRole(user);
        const isAdmin = roleName === "admin" || roleName === "superadmin";

        let owner: any = null;
        if (!isAdmin) {
          owner = await getClubOwnerForUser(user);

          if (!owner) {
            return ctx.forbidden(
              "Access denied. Club owner profile not found for this user.",
            );
          }

          const existingClubOwnerId =
            existing.club_owner?.id || existing.club_owner;

          if (
            !existingClubOwnerId ||
            Number(existingClubOwnerId) !== Number(owner.id)
          ) {
            return ctx.forbidden(
              "Access denied. You can only delete holidays for your own gym.",
            );
          }
        }

        if ((strapi as any).documents && existing.documentId) {
          try {
            await (strapi as any).documents(HOLDIDAY_UID).delete({
              documentId: existing.documentId,
            });
          } catch (docErr) {
            await strapi.entityService.delete(HOLDIDAY_UID, existing.id);
          }
        } else {
          await strapi.entityService.delete(HOLDIDAY_UID, existing.id);
        }

        // 📝 Log Activity
        const targetOwnerId =
          owner?.documentId ||
          owner?.id ||
          existing.club_owner?.documentId ||
          existing.club_owner?.id ||
          existing.club_owner;

        if (targetOwnerId) {
          try {
            const activityLogService: any = strapi.service(
              "api::activity-log.activity-log",
            );
            if (activityLogService?.createActivityLog) {
              const closureLabel =
                existing.closureType === "partial_day"
                  ? `Partial Day (${existing.startTime || ""} - ${existing.endtime || ""})`
                  : "Full Day";
              const dateRange =
                existing.startDate === existing.endDate || !existing.endDate
                  ? existing.startDate
                  : `${existing.startDate} to ${existing.endDate}`;

              await activityLogService.createActivityLog({
                actorType: "club_owner",
                actorId: targetOwnerId,
                actionType: "delete",
                entityName: "Holiday",
                entityId: existing.documentId || existing.id,
                description: `Deleted holiday '${existing.title || "Holiday"}' (${closureLabel}, Date: ${dateRange})`,
              });
            }
          } catch (logErr) {
            strapi.log.warn("[ActivityLog] Failed to log holiday deletion:", logErr);
          }
        }

        // 📧 Notify booked trial clients & active members that the holiday was removed and gym is open
        const deletedOwner =
          owner ||
          (existing.club_owner && typeof existing.club_owner === "object"
            ? existing.club_owner
            : null);

        if (deletedOwner && existing.startDate) {
          notifyTrialClientsOnHolidayShifted({
            clubOwner: deletedOwner,
            previousStartDate: existing.startDate,
            previousEndDate: existing.endDate || existing.startDate,
            newStartDate: null,
            newEndDate: null,
          }).catch((shiftedErr) => {
            strapi.log.error(
              "[Holiday:delete] Error in notifyTrialClientsOnHolidayShifted:",
              shiftedErr,
            );
          });

          notifyActiveMembersOnHolidayShifted({
            clubOwner: deletedOwner,
            previousStartDate: existing.startDate,
            previousEndDate: existing.endDate || existing.startDate,
            newStartDate: null,
            newEndDate: null,
          }).catch((memberShiftedErr) => {
            strapi.log.error(
              "[Holiday:delete] Error in notifyActiveMembersOnHolidayShifted:",
              memberShiftedErr,
            );
          });
        }

        return ctx.send({
          message: "Holiday deleted successfully",
        });
      } catch (error: any) {
        strapi.log.error("DELETE HOLIDAY ERROR:", error);
        return ctx.internalServerError("Failed to delete holiday");
      }
    },
  }),
);
