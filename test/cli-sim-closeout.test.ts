import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatCloseoutReport, main, parseSimArgs } from "../src/cli/sim.js";
import type { CloseoutReport } from "../src/sim/closeoutChain.js";
import { stubJobMove } from "../src/sim/stubJob.js";
import type { ModelRequest } from "../src/models/types.js";

describe("parseSimArgs: closeout", () => {
  it("takes the job flags", () => {
    expect(parseSimArgs(["closeout", "--force-award", "--stub"])).toMatchObject({ command: "closeout", forceAward: true, stub: true });
    expect(() => parseSimArgs(["bid", "--force-award"])).toThrow("--force-award is only for job and closeout");
  });
});

describe("stubJobMove: closeout", () => {
  const ask = (text: string, tools: string[], turns = 0): ModelRequest => ({
    system: "s",
    tools: tools.map((name) => ({ name, description: "", inputSchema: {} })),
    messages: [
      { role: "user", content: [{ type: "text", text }] },
      ...Array.from({ length: turns }, () => [
        { role: "assistant" as const, content: [{ type: "text" as const, text: "x" }] },
        { role: "user" as const, content: [{ type: "tool_result" as const, toolCallId: "t", content: "ok" }] },
      ]).flat(),
    ],
  });
  const brief = "Contract price: $100,000\nApproved change orders: $5,000\nLiquidated damages assessed: $750\nBills to pay:\n- B-1: A, $1\n- B-2: B, $2";
  it("invoices the computed amount, then pays every listed bill, then finishes", () => {
    expect(stubJobMove(ask(brief, ["submit_invoice"]), "m").toolCalls[0]?.input).toEqual({ amount_usd: 104_250 });
    expect(stubJobMove(ask(brief, ["submit_invoice"], 1), "m").toolCalls[0]?.input).toEqual({ bill_ids: ["B-1", "B-2"] });
    expect(stubJobMove(ask(brief, ["submit_invoice"], 2), "m").toolCalls).toEqual([]);
  });
  it("pursues each receivable issue listed, and closes the project once", () => {
    const calls = stubJobMove(ask("late-payment: late\n- claim_interest\nshort-payment: short", ["resolve_receivable"]), "m").toolCalls;
    expect(calls.map((c) => c.input)).toEqual([
      { issue_id: "late-payment", option_id: "claim_interest" },
      { issue_id: "short-payment", option_id: "submit_closeout_documents" },
    ]);
    expect(stubJobMove(ask("x", ["close_project"]), "m").toolCalls[0]?.name).toBe("close_project");
    expect(stubJobMove(ask("x", ["close_project"], 1), "m").toolCalls).toEqual([]);
    expect(stubJobMove(ask("Written request ... Hire a Bookkeeper now", ["propose_hire"]), "m").toolCalls[0]?.input.role).toBe("bookkeeper");
  });
});

describe("formatCloseoutReport", () => {
  const base = {
    runId: "r", seed: 1, profile: "cloud", durationMs: 1_000, spentUsd: 0, eventCount: 5, approvals: [], agents: [], tasks: [],
    opportunity: null, problems: [], injected: null, estimate: null, selected: [], bid: null, quotedCostUsd: 0, marginUsd: null, award: null,
    awardForced: false, schedule: null, siteProblems: [], resolutions: [], account: null,
  };
  it("adds billing, payables, collection and cash lines", () => {
    const report = {
      ...base, outcome: "closed", reason: "Closed.",
      invoice: { amountUsd: 104_250, rejections: 1 },
      bills: [{ billId: "B-1", amountUsd: 60_000, paid: true }, { billId: "B-2", amountUsd: 30_000, paid: true }],
      payment: { paidOnDay: 75, paidUsd: 101_000, withheldUsd: 3_250, daysLate: 35 },
      settlements: [{ issueId: "late-payment", option: "claim_interest", recoversUsd: 500, days: 14 }],
      closeout: { receivedUsd: 101_500, paidOutUsd: 90_000, cashProfitUsd: 11_500 },
    } as unknown as CloseoutReport;
    expect(formatCloseoutReport(report)).toEqual([
      "Run r (cloud, seed 1): CLOSED in 1.0s. Closed.",
      "  Job: none picked",
      "  Problems drawn: none",
      "  Invoice: $104,250 accepted after 1 returned invoice",
      "  Bills: 2 of 2 paid, $90,000",
      "  Payment: $101,000 on day 75 (35 days late), $3,250 withheld",
      "  Receivable late-payment: claim_interest, recovers $500",
      "  Cash: received $101,500, paid out $90,000, cash profit $11,500",
      "  Claude spend: $0.0000; 0 approvals (0 automatic); 5 events",
    ]);
  });
  it("shows an on-time payment and a run that stopped early", () => {
    const onTime = { ...base, outcome: "closed", reason: "ok", invoice: { amountUsd: 10, rejections: 0 }, bills: [], payment: { paidOnDay: 30, paidUsd: 10, withheldUsd: 0, daysLate: 0 }, settlements: [], closeout: { receivedUsd: 10, paidOutUsd: 20, cashProfitUsd: -10 } } as unknown as CloseoutReport;
    expect(formatCloseoutReport(onTime)).toEqual(expect.arrayContaining(["  Invoice: $10 accepted", "  Payment: $10 on day 30", "  Cash: received $10, paid out $20, cash profit -$10"]));
    const stopped = { ...base, outcome: "incomplete", reason: "x", invoice: null, bills: [], payment: null, settlements: [], closeout: null } as unknown as CloseoutReport;
    expect(formatCloseoutReport(stopped)[0]).toBe("Run r (cloud, seed 1): INCOMPLETE in 1.0s. x");
  });
});

describe("pnpm sim closeout (functional)", () => {
  let dir: string;
  let lines: string[];
  const out = (l: string) => lines.push(l);
  const now = () => new Date("2026-11-10T15:00:00.000Z");
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "simclose-"));
    lines = [];
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("runs a stub job through closeout and writes the report", async () => {
    const code = await main(["closeout", "--stub", "--seed", "3", "--force-award", "--out", dir], { out, env: {}, now });
    expect(code).toBe(0);
    const path = join(dir, "closeout-cloud-2026-11-10T15-00-00-000Z-3.json");
    const report = JSON.parse(await readFile(path, "utf8")) as CloseoutReport;
    expect(report).toMatchObject({ outcome: "closed", seed: 3 });
    expect(lines.some((l) => l.startsWith("  Cash: "))).toBe(true);
    expect(lines.at(-1)).toBe(`Report: ${path}`);
  });
});
