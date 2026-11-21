import { describe, expect, it } from "vitest";
import { checkTimeZone, currentWindow, formatIn, inWindow, nextWindowStart, parseWindows, wallClock } from "../src/deploy/window.js";

// Local times: Sunday 2026-11-22 and the days around it.
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m);

describe("maintenance windows", () => {
  it("parses days, daily, and several windows", () => {
    expect(parseWindows("Sun 02:00-04:00")).toEqual([{ day: 0, start: 120, end: 240, text: "Sun 02:00-04:00" }]);
    expect(parseWindows("saturday 23:30 - 00:30, daily 3:00-3:15")).toEqual([
      { day: 6, start: 1410, end: 30, text: "saturday 23:30 - 00:30" },
      { day: null, start: 180, end: 195, text: "daily 3:00-3:15" },
    ]);
  });

  it("refuses what it cannot read", () => {
    expect(() => parseWindows(undefined)).toThrow("Set PROD_MAINTENANCE_WINDOW");
    expect(() => parseWindows("  ")).toThrow("Set PROD_MAINTENANCE_WINDOW");
    for (const bad of ["Sunday", "Funday 02:00-04:00", "Sun 25:00-26:00", "Sun 02:60-03:00", "Sun 2-4"]) {
      expect(() => parseWindows(bad)).toThrow(/Cannot read maintenance window/);
    }
  });

  it("is open from its start up to (not at) its end, on its day", () => {
    const [w] = parseWindows("Sun 02:00-04:00");
    expect(inWindow(w!, at(22, 1, 59))).toBe(false);
    expect(inWindow(w!, at(22, 2, 0))).toBe(true);
    expect(inWindow(w!, at(22, 3, 59))).toBe(true);
    expect(inWindow(w!, at(22, 4, 0))).toBe(false);
    expect(inWindow(w!, at(23, 3, 0))).toBe(false);
  });

  it("runs past midnight into the next day", () => {
    const [w] = parseWindows("Sat 23:30-00:30");
    expect(inWindow(w!, at(21, 23, 45))).toBe(true);
    expect(inWindow(w!, at(22, 0, 15))).toBe(true);
    expect(inWindow(w!, at(22, 0, 30))).toBe(false);
    expect(inWindow(w!, at(22, 23, 45))).toBe(false);
    const [daily] = parseWindows("daily 23:00-01:00");
    expect(inWindow(daily!, at(24, 0, 30))).toBe(true);
  });

  it("finds the current window and when the next one opens", () => {
    const ws = parseWindows("Sun 02:00-04:00, Wed 22:00-23:00");
    expect(currentWindow(ws, at(22, 3))?.text).toBe("Sun 02:00-04:00");
    expect(currentWindow(ws, at(22, 5))).toBeNull();
    expect(nextWindowStart(ws, at(22, 5))).toEqual(at(25, 22));
    expect(nextWindowStart(ws, at(26, 0))).toEqual(at(29, 2));
  });

  it("reads the wall clock in a time zone, following daylight saving time", () => {
    // 2026-11-22 06:30 UTC is Saturday 22:30 in Los Angeles (PST, UTC-8).
    expect(wallClock(new Date("2026-11-22T06:30:00Z"), "America/Los_Angeles")).toEqual({ day: 6, minutes: 22 * 60 + 30 });
    // 2026-07-01 05:00 UTC is Tuesday 22:00 in Los Angeles (PDT, UTC-7).
    expect(wallClock(new Date("2026-07-01T05:00:00Z"), "America/Los_Angeles")).toEqual({ day: 2, minutes: 22 * 60 });
    expect(wallClock(new Date(2026, 10, 22, 3, 5))).toEqual({ day: 0, minutes: 185 });
  });

  it("checks the time zone name", () => {
    expect(checkTimeZone(undefined)).toBeUndefined();
    expect(checkTimeZone(" ")).toBeUndefined();
    expect(checkTimeZone(" America/Los_Angeles ")).toBe("America/Los_Angeles");
    expect(() => checkTimeZone("PST-ish")).toThrow('PROD_MAINTENANCE_TZ must be a time zone name such as America/Los_Angeles, not "PST-ish"');
  });

  it("handles the owner's window: every day 10 pm to 6 am Pacific", () => {
    const ws = parseWindows("daily 22:00-06:00");
    const tz = "America/Los_Angeles";
    const pacific = (iso: string) => currentWindow(ws, new Date(iso), tz) !== null;
    expect(pacific("2026-11-22T05:59:00Z")).toBe(false); // 21:59 PST
    expect(pacific("2026-11-22T06:00:00Z")).toBe(true); // 22:00 PST
    expect(pacific("2026-11-22T13:59:00Z")).toBe(true); // 05:59 PST
    expect(pacific("2026-11-22T14:00:00Z")).toBe(false); // 06:00 PST
    expect(pacific("2026-07-01T05:00:00Z")).toBe(true); // 22:00 PDT in summer
    expect(pacific("2026-07-01T04:59:00Z")).toBe(false);
    expect(nextWindowStart(ws, new Date("2026-11-21T20:00:00Z"), tz)).toEqual(new Date("2026-11-22T06:00:00Z"));
    expect(formatIn(new Date("2026-11-22T06:00:00Z"), tz)).toBe("Sat, Nov 21, 2026, 22:00 PST (America/Los_Angeles)");
  });
});
