import { describe, expect, it } from "vitest";
import { formatLocal, parseCutoff } from "../src/cli/cutoff.js";

// Sunday 15 Nov 2026, 16:45:30 local time. Every expectation is built in local time too, so the tests pass in any zone.
const now = new Date(2026, 10, 15, 16, 45, 30, 250);
const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s, 0);
const at = (...words: string[]) => parseCutoff(words, now);

describe("formatLocal", () => {
  it("writes a date and 24-hour time with leading zeros", () => {
    expect(formatLocal(local(2026, 1, 5, 4, 3, 9))).toBe("2026-01-05 04:03:09");
    expect(formatLocal(local(2026, 11, 15, 23, 59, 59))).toBe("2026-11-15 23:59:59");
  });
});

describe("parseCutoff", () => {
  it("reads now as this instant, with or without the dashes, in any case", () => {
    for (const w of ["now", "--now", "NOW", " now "]) expect(at(w)?.getTime()).toBe(now.getTime());
    expect(at("now")).not.toBe(now);
  });

  it("reads a time alone as that time today", () => {
    expect(at("14:30:00")).toEqual(local(2026, 11, 15, 14, 30, 0));
    expect(at("14:30")).toEqual(local(2026, 11, 15, 14, 30, 0));
    expect(at("9:5:7")).toEqual(local(2026, 11, 15, 9, 5, 7));
    expect(at("--09:00:00")).toEqual(local(2026, 11, 15, 9, 0, 0));
    expect(at("00:00:00")).toEqual(local(2026, 11, 15));
    expect(at("23:59:59")).toEqual(local(2026, 11, 15, 23, 59, 59));
  });

  it("reads a date alone as the start of that day, in each date form", () => {
    for (const w of ["261114", "--261114", "2026-11-14", "20261114", "2026-11-14"]) expect(at(w), w).toEqual(local(2026, 11, 14));
    expect(at("2026-1-5")).toEqual(local(2026, 1, 5));
  });

  it("reads a date with a time, as two words, one quoted word or an ISO string", () => {
    const want = local(2026, 11, 14, 8, 15, 30);
    expect(at("261114", "8:15:30")).toEqual(want);
    expect(at("--261114", "08:15:30")).toEqual(want);
    expect(at("261114 08:15:30")).toEqual(want);
    expect(at("2026-11-14T08:15:30")).toEqual(want);
    expect(at("2026-11-14", "08:15")).toEqual(local(2026, 11, 14, 8, 15, 0));
  });

  it("allows a cut-off in the future", () => {
    expect(at("2030-01-01")).toEqual(local(2030, 1, 1));
  });

  it("rejects times and dates that do not exist", () => {
    for (const w of ["24:00:00", "12:60", "12:00:60", "260230", "2026-02-30", "2026-13-01", "260000", "2026-11-31"]) expect(at(w), w).toBeNull();
    expect(at("260228")).toEqual(local(2026, 2, 28));
    expect(at("280229")).toEqual(local(2028, 2, 29));
    expect(at("270229")).toBeNull();
  });

  it("rejects anything else", () => {
    expect(at()).toBeNull();
    expect(at("")).toBeNull();
    for (const w of ["yesterday", "12", "1234567", "26-11-15", "14.30", "now now", "2026/11/15", "--", "--yes"]) expect(at(w), w).toBeNull();
    expect(at("now", "14:30")).toBeNull();
    expect(at("14:30", "15:30")).toBeNull();
    expect(at("261114", "261115")).toBeNull();
    expect(at("14:30:00", "261114")).toBeNull();
    expect(at("261114", "14:30", "extra")).toBeNull();
  });
});
