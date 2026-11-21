/**
 * Maintenance windows for prod, in this machine's local time, such as
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

/** Whether `at` (local time) falls inside the window. */
export function inWindow(w: MaintenanceWindow, at: Date): boolean {
  const now = at.getHours() * 60 + at.getMinutes();
  const today = at.getDay();
  const yesterday = (today + 6) % 7;
  if (w.end > w.start) return (w.day === null || w.day === today) && now >= w.start && now < w.end;
  // Past midnight: the late part belongs to the window's day, the early part to the day after.
  return ((w.day === null || w.day === today) && now >= w.start) || ((w.day === null || w.day === yesterday) && now < w.end);
}

/** The window `at` is in, or null. */
export function currentWindow(windows: readonly MaintenanceWindow[], at: Date): MaintenanceWindow | null {
  return windows.find((w) => inWindow(w, at)) ?? null;
}

/** When the next window opens after `at`, to the minute (searches the next 8 days). */
export function nextWindowStart(windows: readonly MaintenanceWindow[], at: Date): Date | null {
  const t = new Date(at);
  t.setSeconds(0, 0);
  for (let i = 1; i <= 8 * 24 * 60; i++) {
    t.setMinutes(t.getMinutes() + 1);
    const mins = t.getHours() * 60 + t.getMinutes();
    if (windows.some((w) => w.start === mins && (w.day === null || w.day === t.getDay()))) return new Date(t);
  }
  return null;
}
