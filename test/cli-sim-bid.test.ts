import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoApprover, formatBidReport, main, parseSimArgs } from "../src/cli/sim.js";
import { stubBidProviders } from "../src/sim/stubBid.js";
import { ScriptedProvider, textResponse } from "../src/models/stub.js";
import type { BidReport } from "../src/sim/bidChain.js";
import type { ApprovalRequest } from "../src/approvals/approvals.js";

describe("parseSimArgs: bid", () => {
  it("defaults to cloud and reads the bid flags", () => {
    expect(parseSimArgs(["bid"])).toEqual({ command: "bid", profiles: ["cloud"], runs: 3, stub: false, out: "runs" });
    expect(parseSimArgs(["bid", "--job", "STUB-M01", "--auto-approve", "--seed", "4", "--models", "hybrid"])).toMatchObject({
      job: "STUB-M01", autoApprove: true, seed: 4, profiles: ["hybrid"],
    });
    expect(parseSimArgs(["bid", "--complexity", "moderate"])).toMatchObject({ complexity: "moderate" });
    expect(parseSimArgs(["bid", "--stub", "--job", "STUB-E02"])).toMatchObject({ stub: true, job: "STUB-E02" });
  });
  it("rejects bid flags elsewhere and bad combinations", () => {
    expect(() => parseSimArgs(["hiring", "--job", "X"])).toThrow("--job is only for bid");
    expect(() => parseSimArgs(["bench", "--complexity", "easy"])).toThrow("--complexity is only for bid");
    expect(() => parseSimArgs(["hiring", "--auto-approve"])).toThrow("--auto-approve is only for bid");
    expect(() => parseSimArgs(["bid", "--complexity", "hard"])).toThrow('Unknown complexity "hard"');
    expect(() => parseSimArgs(["bid", "--job", "A", "--complexity", "easy"])).toThrow("not both");
    expect(() => parseSimArgs(["bid", "--stub", "--job", "STUB-C01"])).toThrow("only bids STUB-E02");
    expect(() => parseSimArgs(["bid", "--stub", "--complexity", "complex"])).toThrow("only bids STUB-E02");
    expect(() => parseSimArgs(["bid", "--models", "hybrid,cloud"])).toThrow("bid takes one profile");
  });
});

describe("autoApprover", () => {
  it("approves every gate with a reason", async () => {
    expect(await autoApprover({ gate: "submit_bid" } as ApprovalRequest)).toEqual({ approve: true, reason: "Auto-approved by the owner (--auto-approve)" });
  });
});

describe("formatBidReport", () => {
  const base = {
    runId: "r", seed: 1, profile: "cloud", durationMs: 2_000, spentUsd: 0.5, eventCount: 3, approvals: [{ autoApproved: true }], agents: [], tasks: [],
  };
  it("summarises a full run, flagging a re-quote and a bid below cost", () => {
    const report = {
      ...base, outcome: "awarded", reason: "Lowest responsive bid",
      opportunity: { noticeId: "STUB-E02", title: "Paint", complexity: "easy" },
      problems: ["quote-expired", "late-payment"], injected: { id: "quote-expired", trade: "flooring" },
      estimate: { lines: [{ trade: "painting", costUsd: 1000 }, { trade: "flooring", costUsd: 2000 }], notes: "" },
      selected: [{ quoteId: "Q-painting-1", priceUsd: 1100 }, { quoteId: "Q-flooring-1", priceUsd: 2300, repricedFromUsd: 2000 }],
      bid: { priceUsd: 3000, ownerApproved: true }, quotedCostUsd: 3400, marginUsd: -400,
      award: { competitors: [3100, 3500] },
    } as unknown as BidReport;
    expect(formatBidReport(report)).toEqual([
      "Run r (cloud, seed 1): AWARDED in 2.0s. Lowest responsive bid",
      '  Job: STUB-E02 "Paint" (easy)',
      "  Problems drawn: quote-expired, late-payment; in bidding: quote-expired on flooring",
      "  Estimate: painting, flooring; $3,000",
      "  Quotes: Q-painting-1 $1,100; Q-flooring-1 $2,300 (re-quoted from $2,000)",
      "  Bid: $3,000, approved by owner; BELOW COST by $400 over selected quotes",
      "  Competitors: $3,100, $3,500",
      "  Claude spend: $0.5000; 1 approvals (1 automatic); 3 events",
    ]);
  });
  it("summarises a run that stopped early", () => {
    const report = { ...base, outcome: "no_bid", reason: "x", opportunity: null, problems: [], injected: null, estimate: null, selected: [], bid: null, quotedCostUsd: 0, marginUsd: null, award: null } as unknown as BidReport;
    expect(formatBidReport(report)).toEqual([
      "Run r (cloud, seed 1): NO BID in 2.0s. x",
      "  Job: none picked",
      "  Problems drawn: none",
      "  Claude spend: $0.5000; 1 approvals (1 automatic); 3 events",
    ]);
  });
  it("shows a positive margin and an unrated job", () => {
    const report = {
      ...base, outcome: "lost", reason: "x", opportunity: { noticeId: "N", title: "T", complexity: null }, problems: [], injected: null,
      estimate: null, selected: [], bid: { priceUsd: 10, ownerApproved: false }, quotedCostUsd: 4, marginUsd: 6, award: null,
    } as unknown as BidReport;
    expect(formatBidReport(report)).toContain("  Bid: $10, rejected by owner; margin $6 over selected quotes");
    expect(formatBidReport(report)).toContain('  Job: N "T" (unrated)');
  });
});

describe("pnpm sim bid (functional)", () => {
  let dir: string;
  let lines: string[];
  const out = (l: string) => lines.push(l);
  const now = () => new Date("2026-11-10T15:00:00.000Z");
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "simbid-"));
    lines = [];
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  for (const profile of ["cloud", "hybrid"] as const) {
    it(`runs a ${profile} stub bid on STUB-E02 with every gate approved, and writes the report`, async () => {
      const code = await main(["bid", "--stub", "--models", profile, "--seed", "1", "--out", dir], { out, env: {}, now });
      expect(code).toBe(0);
      const path = join(dir, `bid-${profile}-2026-11-10T15-00-00-000Z-1.json`);
      const report = JSON.parse(await readFile(path, "utf8")) as BidReport;
      expect(report).toMatchObject({ outcome: "awarded", seed: 1, profile, opportunity: { noticeId: "STUB-E02" } });
      expect(report.approvals.filter((a) => !a.autoApproved).every((a) => a.reason === "Auto-approved by the owner (--auto-approve)")).toBe(true);
      expect(lines[0]).toBe(`Starting a ${profile} bid run with scripted models, seed 1. Claude budget: $5.`);
      expect(lines.at(-1)).toBe(`Report: ${path}`);
    });
  }

  it("asks the owner through the injected approver unless --auto-approve is given", async () => {
    const asked: string[] = [];
    const approver = async (r: ApprovalRequest) => (asked.push(r.gate), { approve: true });
    const deps = { out, env: {}, now, writeReport: async () => undefined, approver };
    expect(await main(["bid", "--job", "STUB-E02", "--seed", "2"], { ...deps, providers: stubBidProviders("cloud") })).toBe(0);
    expect(asked).toEqual(["pursue_opportunity", "hire_agent", "hire_agent", "submit_bid"]);
    expect(lines.find((l) => l.startsWith("Run "))).toMatch(/LOST/);
    asked.length = 0;
    expect(await main(["bid", "--job", "STUB-E02", "--auto-approve"], { ...deps, providers: stubBidProviders("cloud") })).toBe(0);
    expect(asked).toEqual([]);
  });

  it("exits 1 when the run is incomplete", async () => {
    const providers = stubBidProviders("cloud");
    providers.claude = new ScriptedProvider([textResponse("No.")]);
    const code = await main(["bid", "--auto-approve"], { out, env: {}, now, providers, writeReport: async () => undefined });
    expect(code).toBe(1);
    expect(lines.find((l) => l.includes("INCOMPLETE"))).toMatch(/did not hire HR/);
  });
});
