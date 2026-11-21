/**
 * Maintenance windows for prod, in PROD_MAINTENANCE_TZ (or this machine's local time), such as
 * "Sun 02:00-04:00" or "daily 23:30-00:30". Several are separated by commas.
 * A window that ends at or before it starts runs past midnight into the next day.
 */
export interface MaintenanceWindow {
  /** 0 = Sunday ... 6 = Saturday; null = every day. */
  day: number | null;
  /** Minutes after midnight. */
  start: number;
  end: number;
  text: string;
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function minutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? h * 60 + min : null;
}

const FULL_DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** "Sun" or "Sunday" (any case) to 0, "daily" to null; undefined for anything else. */
function dayNumber(word: string): number | null | undefined {
  const w = word.toLowerCase();
  if (w === "daily") return null;
  const i = DAYS.indexOf(w) >= 0 ? DAYS.indexOf(w) : FULL_DAYS.indexOf(w);
  return i >= 0 ? i : undefined;
}

/** Parses PROD_MAINTENANCE_WINDOW. Throws with a clear message on anything it cannot read. */
export function parseWindows(raw: string | undefined): MaintenanceWindow[] {
  if (raw === undefined || raw.trim() === "") throw new Error('Set PROD_MAINTENANCE_WINDOW, for example "Sun 02:00-04:00"');
  return raw.split(",").map((part) => {
    const text = part.trim();
    const m = /^(\w+)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(text);
    const day = m ? dayNumber(m[1]!) : undefined;
    const start = m ? minutes(m[2]!) : null;
    const end = m ? minutes(m[3]!) : null;
    if (day === undefined || start === null || end === null) {
      throw new Error(`Cannot read maintenance window "${text}". Use a day and times, for example "Sun 02:00-04:00" or "daily 23:30-00:30".`);
    }
    return { day, start, end, text };
  });
}

/** A moment as a wall clock: the day of the week (0 = Sunday) and minutes after midnight. */
export interface WallClock {
  day: number;
  minutes: number;
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Checks an IANA time zone name such as America/Los_Angeles. Throws on an unknown one. */
export function checkTimeZone(tz: string | undefined): string | undefined {
  if (tz === undefined || tz.trim() === "") return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz.trim() });
  } catch {
    throw new Error(`PROD_MAINTENANCE_TZ must be a time zone name such as America/Los_Angeles, not "${tz}"`);
  }
  return tz.trim();
}

/** The wall clock at `at` in time zone `tz` (this machine's when left out). Daylight saving time is followed. */
export function wallClock(at: Date, tz?: string): WallClock {
  if (!tz) return { day: at.getDay(), minutes: at.getHours() * 60 + at.getMinutes() };
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return { day: WEEKDAY[parts.weekday!]!, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** A moment written in time zone `tz` (this machine's when left out), for messages. */
export function formatIn(at: Date, tz?: string): string {
  if (!tz) return at.toString();
  return `${new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).format(at)} (${tz})`;
}

/** Whether `at` falls inside the window, in time zone `tz` (this machine's when left out). */
export function inWindow(w: MaintenanceWindow, at: Date, tz?: string): boolean {
  const { day: today, minutes: now } = wallClock(at, tz);
  const yesterday = (today + 6) % 7;
  if (w.end > w.start) return (w.day === null || w.day === today) && now >= w.start && now < w.end;
  // Past midnight: the late part belongs to the window's day, the early part to the day after.
  return ((w.day === null || w.day === today) && now >= w.start) || ((w.day === null || w.day === yesterday) && now < w.end);
}

/** The window `at` is in, or null. */
export function currentWindow(windows: readonly MaintenanceWindow[], at: Date, tz?: string): MaintenanceWindow | null {
  return windows.find((w) => inWindow(w, at, tz)) ?? null;
}

/** When the next window opens after `at`, to the minute (searches the next 8 days). */
export function nextWindowStart(windows: readonly MaintenanceWindow[], at: Date, tz?: string): Date | null {
  const t = new Date(at);
  t.setSeconds(0, 0);
  for (let i = 1; i <= 8 * 24 * 60; i++) {
    t.setTime(t.getTime() + 60_000);
    const c = wallClock(t, tz);
    if (windows.some((w) => w.start === c.minutes && (w.day === null || w.day === c.day))) return new Date(t);
  }
  return null;
}
