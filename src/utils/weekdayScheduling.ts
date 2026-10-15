export const DAYS_OF_WEEK = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export type DayOfWeek = (typeof DAYS_OF_WEEK)[number];

export interface OpenDaySchedule {
  openingTime: string;
  closingTime: string;
  [key: string]: any;
}

export type DaySchedule = OpenDaySchedule | "closed";

export type WeekdayScheduling = Record<DayOfWeek, DaySchedule> &
  Record<string, any>;

/**
 * Parses diverse time string formats (e.g., "9am", "9pm", "9:30 AM", "09:00", "09:00:00.000")
 * into normalized "HH:MM" 24-hour format string.
 */
export function formatTimeToHHMM(timeStr: any): string | null {
  if (timeStr === null || timeStr === undefined) return null;
  if (typeof timeStr !== "string") {
    timeStr = String(timeStr);
  }

  const trimmed = timeStr.trim();
  if (!trimmed) return null;

  // Check 12-hour format with AM/PM e.g. "9am", "9:30pm", "09:00 AM"
  const ampmRegex = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i;
  const ampmMatch = trimmed.match(ampmRegex);
  if (ampmMatch) {
    let hours = parseInt(ampmMatch[1], 10);
    const minutes = ampmMatch[2] ? parseInt(ampmMatch[2], 10) : 0;
    const meridian = ampmMatch[3].toLowerCase();

    if (meridian === "pm" && hours < 12) {
      hours += 12;
    } else if (meridian === "am" && hours === 12) {
      hours = 0;
    }

    const hh = String(hours).padStart(2, "0");
    const mm = String(minutes).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  // Check 24-hour format e.g. "09:00", "9:00", "22:00:00", "22:00:00.000"
  const time24Regex = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;
  const match24 = trimmed.match(time24Regex);
  if (match24) {
    const hours = parseInt(match24[1], 10);
    const minutes = parseInt(match24[2], 10);
    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      const hh = String(hours).padStart(2, "0");
      const mm = String(minutes).padStart(2, "0");
      return `${hh}:${mm}`;
    }
  }

  return trimmed;
}

/**
 * Reorders any weekdayScheduling object strictly in Monday-Sunday order
 * with openingTime always before closingTime.
 */
export function orderWeekdayScheduling(
  scheduling: any,
): WeekdayScheduling | null {
  if (!scheduling) return null;

  let raw = scheduling;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }

  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const ordered = {} as WeekdayScheduling;

  for (const day of DAYS_OF_WEEK) {
    const dayData = raw[day];

    if (
      !dayData ||
      dayData === "closed" ||
      (typeof dayData === "string" && dayData.toLowerCase() === "closed")
    ) {
      ordered[day] = "closed";
    } else if (typeof dayData === "object") {
      if (
        dayData.isClosed === true ||
        dayData.closed === true ||
        dayData.isOpen === false ||
        dayData.status === "closed"
      ) {
        ordered[day] = "closed";
      } else {
        const openingTime = formatTimeToHHMM(
          dayData.openingTime ||
            dayData.open ||
            dayData.opening_time ||
            dayData.from,
        );
        const closingTime = formatTimeToHHMM(
          dayData.closingTime ||
            dayData.close ||
            dayData.closing_time ||
            dayData.to,
        );

        if (!openingTime || !closingTime) {
          ordered[day] = "closed";
        } else {
          // Strictly insert openingTime first, then closingTime
          ordered[day] = {
            openingTime,
            closingTime,
          };
        }
      }
    } else {
      ordered[day] = "closed";
    }
  }

  return ordered;
}

/**
 * Normalizes weekday scheduling input.
 *
 * Requirements:
 * 1. Everyday object: { everyday: { openingTime: "9am", closingTime: "9pm" } }
 *    -> All 7 days get { openingTime: "09:00", closingTime: "21:00" } in Monday-Sunday order
 * 2. Per-day custom timings: { monday: { openingTime: "06:00", closingTime: "22:00" }, ... }
 *    -> Open days get { openingTime: "...", closingTime: "..." } in Monday-Sunday order
 *    -> Any missing or closed day is marked as "closed" (e.g. "sunday": "closed")
 * 3. Array of days: [{ day: "monday", openingTime: "...", closingTime: "..." }, ...]
 */
export function normalizeWeekdayScheduling(
  input: any,
): WeekdayScheduling | null {
  if (!input) return null;

  let raw = input;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }

  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  // Unwrap nested properties if passed under weekdayScheduling or weekday_scheduling
  if (raw.weekdayScheduling && typeof raw.weekdayScheduling === "object") {
    raw = raw.weekdayScheduling;
  } else if (
    raw.weekday_scheduling &&
    typeof raw.weekday_scheduling === "object"
  ) {
    raw = raw.weekday_scheduling;
  }

  /* =====================================================
     CASE 1: EVERYDAY / ALL DAYS SCHEDULE
  ===================================================== */
  const everydayObj =
    raw.everyday ||
    raw.everyDay ||
    raw.allDays ||
    raw.all_days ||
    (raw.isEveryday || raw.mode === "everyday" || raw.type === "everyday"
      ? raw
      : null);

  if (everydayObj && typeof everydayObj === "object") {
    const openRaw =
      everydayObj.openingTime ||
      everydayObj.open ||
      everydayObj.opening_time ||
      raw.openingTime ||
      raw.open;
    const closeRaw =
      everydayObj.closingTime ||
      everydayObj.close ||
      everydayObj.closing_time ||
      raw.closingTime ||
      raw.close;

    const openingTime = formatTimeToHHMM(openRaw);
    const closingTime = formatTimeToHHMM(closeRaw);

    if (openingTime && closingTime) {
      const result = {} as WeekdayScheduling;
      for (const day of DAYS_OF_WEEK) {
        result[day] = {
          openingTime,
          closingTime,
        };
      }
      return result;
    }
  }

  // Legacy flat fallback: only openingTime and closingTime provided without day keys
  const hasSpecificDays =
    Array.isArray(raw) ||
    DAYS_OF_WEEK.some(
      (d) => d in raw || d.charAt(0).toUpperCase() + d.slice(1) in raw,
    );

  if (
    !hasSpecificDays &&
    (raw.openingTime || raw.open) &&
    (raw.closingTime || raw.close)
  ) {
    const openingTime = formatTimeToHHMM(raw.openingTime || raw.open);
    const closingTime = formatTimeToHHMM(raw.closingTime || raw.close);

    if (openingTime && closingTime) {
      const result = {} as WeekdayScheduling;
      for (const day of DAYS_OF_WEEK) {
        result[day] = {
          openingTime,
          closingTime,
        };
      }
      return result;
    }
  }

  /* =====================================================
     CASE 2: PER-DAY CUSTOM SCHEDULE / ARRAY OF DAYS
  ===================================================== */
  const dayMap: Record<string, any> = {};

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item && typeof item === "object" && item.day) {
        const key = String(item.day).trim().toLowerCase();
        dayMap[key] = item;
      }
    }
  } else {
    for (const key of Object.keys(raw)) {
      const lowerKey = key.trim().toLowerCase();
      dayMap[lowerKey] = raw[key];
    }
  }

  const result = {} as WeekdayScheduling;

  for (const day of DAYS_OF_WEEK) {
    const dayData = dayMap[day];

    if (!dayData) {
      // Missing day -> Automatically "closed"
      result[day] = "closed";
      continue;
    }

    if (
      typeof dayData === "string" &&
      dayData.toLowerCase().trim() === "closed"
    ) {
      result[day] = "closed";
      continue;
    }

    if (typeof dayData !== "object") {
      result[day] = "closed";
      continue;
    }

    const isExplicitlyClosed =
      dayData.isClosed === true ||
      dayData.closed === true ||
      dayData.isOpen === false ||
      dayData.openStatus === false ||
      dayData.status === "closed";

    const openRaw =
      dayData.openingTime ||
      dayData.open ||
      dayData.opening_time ||
      dayData.from;
    const closeRaw =
      dayData.closingTime ||
      dayData.close ||
      dayData.closing_time ||
      dayData.to;

    const openingTime = formatTimeToHHMM(openRaw);
    const closingTime = formatTimeToHHMM(closeRaw);

    if (isExplicitlyClosed || !openingTime || !closingTime) {
      result[day] = "closed";
    } else {
      result[day] = {
        openingTime,
        closingTime,
      };
    }
  }

  return result;
}

/**
 * Validates that the weekday scheduling object has at least one day open with valid opening and closing times.
 */
export function isValidWeekdayScheduling(scheduling: any): boolean {
  if (!scheduling || typeof scheduling !== "object") return false;

  for (const day of DAYS_OF_WEEK) {
    const d = scheduling[day];
    if (d && typeof d === "object" && d.openingTime && d.closingTime) {
      return true;
    }
  }

  return false;
}
