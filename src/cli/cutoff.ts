/**
 * Reads the cut-off for `pnpm db delete --before ...`. Times are the local
 * time of the machine the command runs on, because that is the clock the
 * owner is looking at.
 */

const TIME = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/;
const DATES: Array<[RegExp, (m: RegExpExecArray) => [number, number, number]]> = [
  [/^(\d{4})-(\d{1,2})-(\d{1,2})$/, (m) => [Number(m[1]), Number(m[2]), Number(m[3])]], // 2026-11-15
  [/^(\d{4})(\d{2})(\d{2})$/, (m) => [Number(m[1]), Number(m[2]), Number(m[3])]], // 20261115
  [/^(\d{2})(\d{2})(\d{2})$/, (m) => [2000 + Number(m[1]), Number(m[2]), Number(m[3])]], // 261115
];

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/** "2026-11-15 14:30:00" in local time. */
export function formatLocal(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function parseDate(token: string): [number, number, number] | null {
  for (const [pattern, read] of DATES) {
    const m = pattern.exec(token);
    if (m) return read(m);
  }
  return null;
}

function parseTime(token: string): [number, number, number] | null {
  const m = TIME.exec(token);
  if (!m) return null;
  const parts: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  return parts[0] <= 23 && parts[1] <= 59 && parts[2] <= 59 ? parts : null;
}

/**
 * The cut-off the words name, or null when they cannot be read.
 *
 *   now                    this instant
 *   14:30  or  14:30:00    that time today
 *   261115 or 2026-11-15   the start of that day
 *   261115 14:30:00        that day at that time (also "2026-11-15T14:30:00")
 *
 * A leading "--" on a word is ignored, so "--now" and "--261115" work too.
 */
export function parseCutoff(words: readonly string[], now: Date): Date | null {
  const tokens = words
    .flatMap((w) => w.trim().split(/[\sT]+/))
    .map((w) => w.replace(/^--/, ""))
    .filter(Boolean);
  if (tokens.length === 1 && tokens[0]!.toLowerCase() === "now") return new Date(now.getTime());
  if (tokens.length === 0 || tokens.length > 2) return null;

  let date: [number, number, number] | null = null;
  let time: [number, number, number] | null = null;
  for (const token of tokens) {
    const asTime = parseTime(token);
    const asDate = asTime ? null : parseDate(token);
    if (asTime && !time) time = asTime;
    else if (asDate && !date) date = asDate;
    else return null; // unreadable, or two dates, or two times
  }
  if (tokens.length === 2 && !(date && time && parseDate(tokens[0]!))) return null; // the date comes first
  // A time with no date means today.
  const [y, mo, d] = date ?? [now.getFullYear(), now.getMonth() + 1, now.getDate()];
  const [h, mi, s] = time ?? [0, 0, 0];
  const result = new Date(y, mo - 1, d, h, mi, s, 0);
  // new Date() rolls an impossible date over (Feb 30 becomes Mar 2); reject those instead.
  if (result.getFullYear() !== y || result.getMonth() !== mo - 1 || result.getDate() !== d) return null;
  return result;
}
