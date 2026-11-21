import { describe, expect, it } from "vitest";
import { currentWindow, inWindow, nextWindowStart, parseWindows } from "../src/deploy/window.js";

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
});
