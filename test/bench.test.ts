import { describe, expect, it } from "vitest";
import { formatBench, summarizeBench } from "../src/sim/bench.js";
import { PROFILES, isProfile, roleModelsFor, usesGpu } from "../src/config/profiles.js";
import { DEFAULT_ROLE_MODELS } from "../src/config/roles.js";
import type { HiringReport } from "../src/sim/hiringChain.js";

const report = (profile: string, sec: number, usd: number, outcome = "complete", tasks: Array<[string, number, number]> = []) =>
  ({
    profile, durationMs: sec * 1000, spentUsd: usd, outcome,
    tasks: tasks.map(([role, s, steps]) => ({ role, durationMs: s * 1000, steps })),
  }) as unknown as HiringReport;

describe("profiles", () => {
  it("both profiles keep executives on the claude target and the rest on the worker target", () => {
    expect(PROFILES).toEqual(["hybrid", "cloud"]);
    expect(roleModelsFor("hybrid")).toEqual(DEFAULT_ROLE_MODELS);
    expect(roleModelsFor("cloud")).toEqual(DEFAULT_ROLE_MODELS);
    expect(roleModelsFor("cloud").president).toBe("claude");
    expect(roleModelsFor("cloud").hr).toBe("local");
  });
  it("usesGpu and isProfile", () => {
    expect(usesGpu("hybrid")).toBe(true);
    expect(usesGpu("cloud")).toBe(false);
    expect(isProfile("cloud")).toBe(true);
    expect(isProfile("gpu")).toBe(false);
  });
  it("returns a fresh map each time", () => {
    roleModelsFor("hybrid").president = "local";
    expect(DEFAULT_ROLE_MODELS.president).toBe("claude");
  });
});

describe("summarizeBench", () => {
  it("summarises each profile in first-seen order", () => {
    const s = summarizeBench([
      report("hybrid", 60, 0.04, "complete", [["president", 10, 2], ["hr", 50, 4]]),
      report("cloud", 20, 0.1, "complete", [["president", 10, 2], ["hr", 10, 2]]),
      report("hybrid", 40, 0.06, "incomplete", [["president", 10, 2], ["hr", 30, 2]]),
    ]);
    expect(s.map((x) => x.profile)).toEqual(["hybrid", "cloud"]);
    expect(s[0]).toEqual({
      profile: "hybrid", runs: 2, complete: 1, meanSec: 50, minSec: 40, maxSec: 60,
      meanTaskSec: { president: 10, hr: 40 }, meanModelCalls: 5, meanClaudeUsd: 0.05,
    });
    expect(s[1]).toMatchObject({ runs: 1, complete: 1, meanSec: 20, meanModelCalls: 4 });
  });
  it("is empty with no runs", () => {
    expect(summarizeBench([])).toEqual([]);
  });
});

describe("formatBench", () => {
  it("prints a header, one row per profile and the comparison", () => {
    const lines = formatBench(summarizeBench([report("hybrid", 60, 0.04, "complete", [["hr", 50, 4]]), report("cloud", 20, 0.1)]));
    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatch(/^hybrid\s+1\s+1\/1\s+60\.0\s+60\.0\s+60\.0\s+4\.0\s+\$0\.0400\s+hr 50\.0$/);
    expect(lines[3]).toBe("cloud is 3.0x faster than hybrid, at $0.0600 more Claude spend per run");
  });
  it("says slower when cloud is slower, and skips the comparison with one profile", () => {
    expect(formatBench(summarizeBench([report("hybrid", 10, 0), report("cloud", 20, 0)])).at(-1)).toMatch(/2\.0x slower/);
    expect(formatBench(summarizeBench([report("cloud", 20, 0)]))).toHaveLength(2);
  });
});
