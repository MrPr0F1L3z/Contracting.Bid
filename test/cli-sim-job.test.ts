import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatJobReport, main, parseSimArgs } from "../src/cli/sim.js";
import type { JobReport } from "../src/sim/jobChain.js";

describe("parseSimArgs: job", () => {
  it("takes the bid flags plus --force-award", () => {
    expect(parseSimArgs(["job", "--force-award", "--auto-approve", "--complexity", "complex"])).toMatchObject({
      command: "job", forceAward: true, autoApprove: true, complexity: "complex", profiles: ["cloud"],
    });
  });
  it("keeps --force-award to job", () => {
    expect(() => parseSimArgs(["bid", "--force-award"])).toThrow("--force-award is only for job");
    expect(() => parseSimArgs(["hiring", "--auto-approve"])).toThrow("only for bid and job");
    expect(() => parseSimArgs(["job", "--stub", "--job", "STUB-M01"])).toThrow("only bids STUB-E02");
  });
});

describe("formatJobReport", () => {
  const base = {
    runId: "r", seed: 1, profile: "cloud", durationMs: 1_000, spentUsd: 0, eventCount: 5, approvals: [], agents: [], tasks: [],
    opportunity: { noticeId: "STUB-E02", title: "Paint", complexity: "easy" }, problems: ["weather-delay"], injected: null,
    estimate: null, selected: [], bid: { priceUsd: 100, ownerApproved: true }, quotedCostUsd: 80, marginUsd: 20, award: { competitors: [120] },
  };
  it("shows the schedule, each problem and the final account", () => {
    const report = {
      ...base, outcome: "completed", reason: "Finished.", awardForced: true,
      schedule: [{ trade: "painting", startDay: 0, days: 1 }, { trade: "flooring", startDay: 1, days: 6 }],
      siteProblems: [],
      resolutions: [
        { problemId: "weather-delay", trade: "painting", choice: "accept_delay", costUsd: 0, days: 1 },
        { problemId: "change-order", trade: "flooring", choice: "change_order", costUsd: 5_000, days: 2, changeOrder: { priceUsd: 6_000, days: 1 } },
        { problemId: "hidden-conditions", trade: "painting", choice: "disputed", costUsd: 3_000, days: 2, changeOrder: null },
      ],
      account: { actualDays: 12, contractDays: 10, daysLate: 2, liquidatedDamagesUsd: 500, revenueUsd: 105_500, costUsd: 108_000, profitUsd: -2_500 },
    } as unknown as JobReport;
    expect(formatJobReport(report)).toEqual([
      "Run r (cloud, seed 1): COMPLETED in 1.0s. Finished.",
      '  Job: STUB-E02 "Paint" (easy)',
      "  Problems drawn: weather-delay",
      "  Bid: $100, approved by owner; margin $20 over selected quotes",
      "  Competitors: $120",
      "  Award FORCED for simulation: the bid lost on price",
      "  Schedule: painting 1 day, flooring 6 days",
      "  Problem weather-delay (painting): accept_delay, cost $0, 1 day",
      "  Problem change-order (flooring): change_order, cost $5,000, 2 days; change order $6,000 and 1 day",
      "  Problem hidden-conditions (painting): disputed, cost $3,000, 2 days; no change order",
      "  Time: 12 of 10 working days, 2 days late ($500 liquidated damages)",
      "  Money: revenue $105,500, cost $108,000, profit -$2,500",
      "  Claude spend: $0.0000; 0 approvals (0 automatic); 5 events",
    ]);
  });
  it("shows an on-time job and a run that stopped at the bid", () => {
    const onTime = { ...base, outcome: "completed", reason: "ok", awardForced: false, schedule: null, siteProblems: [], resolutions: [],
      account: { actualDays: 9, contractDays: 10, daysLate: 0, liquidatedDamagesUsd: 0, revenueUsd: 100, costUsd: 80, profitUsd: 20 } } as unknown as JobReport;
    expect(formatJobReport(onTime)).toContain("  Time: 9 of 10 working days, on time");
    expect(formatJobReport(onTime)).toContain("  Money: revenue $100, cost $80, profit $20");
    const lost = { ...base, outcome: "lost", reason: "Bid ranked 2", awardForced: false, schedule: null, siteProblems: [], resolutions: [], account: null } as unknown as JobReport;
    expect(formatJobReport(lost)[0]).toBe("Run r (cloud, seed 1): LOST in 1.0s. Bid ranked 2");
  });
});

describe("pnpm sim job (functional)", () => {
  let dir: string;
  let lines: string[];
  const out = (l: string) => lines.push(l);
  const now = () => new Date("2026-11-10T15:00:00.000Z");
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "simjob-"));
    lines = [];
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("runs a stub job from bid to final account and writes the report", async () => {
    const code = await main(["job", "--stub", "--seed", "3", "--force-award", "--out", dir], { out, env: {}, now });
    expect(code).toBe(0);
    const path = join(dir, "job-cloud-2026-11-10T15-00-00-000Z-3.json");
    const report = JSON.parse(await readFile(path, "utf8")) as JobReport;
    expect(report).toMatchObject({ outcome: "completed", awardForced: true, seed: 3 });
    expect(report.account).not.toBeNull();
    expect(lines[0]).toBe("Starting a cloud job run with scripted models, seed 3. Claude budget: $5.");
    expect(lines.some((l) => l.startsWith("  Money: "))).toBe(true);
    expect(lines.at(-1)).toBe(`Report: ${path}`);
  });

  it("exits 0 for a lost bid without --force-award", async () => {
    expect(await main(["job", "--stub", "--seed", "2"], { out, env: {}, now, writeReport: async () => undefined })).toBe(0);
    expect(lines.find((l) => l.startsWith("Run "))).toMatch(/LOST/);
  });
});
