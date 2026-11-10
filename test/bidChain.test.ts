import { describe, expect, it } from "vitest";
import { bidPackage, opportunityBrief, runBidChain, type BidChainOptions } from "../src/sim/bidChain.js";
import { STUB_BID_JOB, STUB_BID_PRICE_USD, stubBidProviders } from "../src/sim/stubBid.js";
import { STUB_HR_INSTRUCTIONS, STUB_PM_INSTRUCTIONS } from "../src/sim/stubHiring.js";
import { ModelRouter } from "../src/models/router.js";
import { ScriptedProvider, textResponse, toolCallResponse } from "../src/models/stub.js";
import { STUB_OPPORTUNITIES } from "../src/opportunities/stub.js";
import { SeededRng } from "../src/sim/rng.js";
import { BidWorld } from "../src/world/market.js";
import type { Approver } from "../src/agents/hiringTools.js";

const e02 = STUB_OPPORTUNITIES.find((o) => o.noticeId === STUB_BID_JOB)!;
const yes: Approver = async () => ({ approve: true });
const opts = (seed: number, extra: Partial<BidChainOptions> = {}): BidChainOptions => ({
  runId: "bid-1", seed, router: new ModelRouter(stubBidProviders()), approver: yes, runBudgetUsd: 5, noticeId: STUB_BID_JOB, ...extra,
});

// Slice 1 replies, reused by hand-written scripts.
const hireHr = toolCallResponse("propose_hire", { role: "hr", instructions: STUB_HR_INSTRUCTIONS, budget_usd: 0.5, justification: "x" }, "a");
const hirePm = toolCallResponse("propose_hire", { role: "project_manager", instructions: STUB_PM_INSTRUCTIONS, budget_usd: 1, justification: "x" }, "b");

describe("opportunityBrief", () => {
  it("shows the solicitation, not the world's hidden costs", () => {
    const brief = opportunityBrief(e02);
    expect(brief.split("\n")).toEqual([
      "Solicitation STUB-E02: Interior paint and flooring refresh, visitor center",
      "Agency: Example Federal Agency, Region 6",
      "Place of performance: Austin, TX",
      "NAICS: 238320. Set-aside: Total Small Business Set-Aside. Responses due 2026-12-08T17:00:00-06:00.",
      "Government estimate: $60,000 to $150,000",
      `Scope: ${e02.scopeSummary}`,
    ]);
    expect(opportunityBrief({ ...e02, estimatedValueUsd: null, setAside: null })).toMatch(/Set-aside: none\..*\nGovernment estimate: not stated/s);
  });
});

describe("bidPackage", () => {
  it("lines up the estimate with the selected quotes and flags gaps and extras", () => {
    const w = new BidWorld(e02, new SeededRng(1));
    const paint = w.quotesFor("painting")[0]!;
    w.select(paint.quoteId);
    const roof = w.quotesFor("roofing")[0]!;
    w.select(roof.quoteId);
    const text = bidPackage(e02, [{ trade: "painting", scope: "", costUsd: 40_000 }, { trade: "flooring", scope: "", costUsd: 50_000 }], "", w);
    expect(text).toContain(`- painting: estimate $40,000; quote ${paint.quoteId} from ${paint.subcontractor} at $${paint.priceUsd.toLocaleString("en-US")}`);
    expect(text).toContain("- flooring: estimate $50,000; NO QUOTE SELECTED");
    expect(text).toContain(`- roofing: not in the estimate; quote ${roof.quoteId}`);
    expect(text).toContain(`Total of selected quotes: $${(paint.priceUsd + roof.priceUsd).toLocaleString("en-US")}`);
    expect(text).toContain("Estimator's notes: none");
  });
});

describe("runBidChain (functional, scripted models)", () => {
  it("staffs the bid team, prices the job and wins it (seed 1)", async () => {
    const asked: string[] = [];
    const providers = stubBidProviders();
    const r = await runBidChain(opts(1, { router: new ModelRouter(providers), approver: async (q) => (asked.push(q.gate), { approve: true }) }));
    expect(r).toMatchObject({ outcome: "awarded", reason: "Lowest responsive bid", seed: 1 });
    expect(r.opportunity).toEqual({ noticeId: "STUB-E02", title: e02.title, complexity: "easy" });
    expect(r.agents.map((a) => [a.role, a.status, a.managerId])).toEqual([
      ["president", "active", null], ["hr", "active", 1], ["project_manager", "active", 1], ["estimator", "active", 3], ["procurement", "active", 3],
    ]);
    // The initial hires are automatic; pursuing, the two later hires and the bid go to the owner.
    expect(asked).toEqual(["pursue_opportunity", "hire_agent", "hire_agent", "submit_bid"]);
    expect(r.estimate?.lines.map((l) => l.trade)).toEqual(["painting", "flooring"]);
    expect(r.selected.map((q) => q.quoteId)).toEqual(["Q-painting-1", "Q-flooring-1"]);
    expect(r.bid).toMatchObject({ priceUsd: STUB_BID_PRICE_USD, ownerApproved: true });
    expect(r.quotedCostUsd).toBe(r.selected.reduce((a, q) => a + q.priceUsd, 0));
    expect(r.marginUsd).toBe(STUB_BID_PRICE_USD - r.quotedCostUsd);
    expect(r.award).toMatchObject({ awarded: true, rank: 1 });
    expect(r.tasks.map((t) => [t.actor, t.model])).toEqual([
      ["president#1", "stub-claude"], ["hr#2", "stub-claude-worker"], ["president#1", "stub-claude"], ["hr#2", "stub-claude-worker"],
      ["estimator#4", "stub-claude-worker"], ["procurement#5", "stub-claude-worker"], ["project_manager#3", "stub-claude"],
    ]);
    const types = r.events.map((e) => e.type);
    expect(types[0]).toBe("run_started");
    expect(types).toEqual(expect.arrayContaining(["opportunity_found", "opportunity_decided", "estimate_submitted", "quotes_received", "quote_selected", "bid_submitted", "award_decided"]));
    expect(r.events.at(-1)).toMatchObject({ type: "run_finished", payload: { outcome: "awarded" } });
    expect(providers.claude.remaining()).toBe(0);
    expect(providers.local.remaining()).toBe(0);
    // The PM sees the bid package; the Estimator never sees the hidden costs.
    expect(providers.claude.requests.at(-2)?.messages[0]?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Bid package:") });
  });

  it("replays the same run from the same seed", async () => {
    const strip = (r: Awaited<ReturnType<typeof runBidChain>>) => ({ ...r, durationMs: 0, tasks: r.tasks.map((t) => ({ ...t, durationMs: 0, modelMs: 0 })) });
    expect(strip(await runBidChain(opts(9)))).toEqual(strip(await runBidChain(opts(9))));
  });

  it("loses when a competitor bids lower (seed 2)", async () => {
    const r = await runBidChain(opts(2));
    expect(r.outcome).toBe("lost");
    expect(r.reason).toMatch(/^Bid ranked 2 of 3; lowest was \$/);
  });

  it("injects the quote-expired problem when the seed draws it (seed 9)", async () => {
    const r = await runBidChain(opts(9));
    expect(r.problems).toContain("quote-expired");
    expect(r.injected).toEqual({ id: "quote-expired", trade: "flooring" });
    const flooring = r.selected.find((q) => q.trade === "flooring")!;
    expect(flooring.repricedFromUsd).toBeLessThan(flooring.priceUsd);
    expect(r.events.some((e) => e.type === "problem_injected")).toBe(true);
  });

  it("stops at no-bid when the President declines", async () => {
    const claude = new ScriptedProvider([hireHr, textResponse("ok"), toolCallResponse("decide_opportunity", { decision: "no_bid", rationale: "Too far from our base." }), textResponse("no")]);
    const local = new ScriptedProvider([hirePm, textResponse("ok")]);
    const r = await runBidChain(opts(1, { router: new ModelRouter({ claude, local }) }));
    expect(r).toMatchObject({ outcome: "no_bid", reason: "The President chose not to bid: Too far from our base.", bid: null, award: null });
    expect(r.agents).toHaveLength(3);
  });

  it("stops when the owner declines to pursue", async () => {
    const claude = new ScriptedProvider([hireHr, textResponse("ok"), toolCallResponse("decide_opportunity", { decision: "pursue", rationale: "Good fit for us." }), textResponse("waiting")]);
    const local = new ScriptedProvider([hirePm, textResponse("ok")]);
    const r = await runBidChain(opts(1, { router: new ModelRouter({ claude, local }), approver: async () => ({ approve: false, reason: "not now" }) }));
    expect(r).toMatchObject({ outcome: "owner_declined", reason: "The owner declined to pursue: not now" });
  });

  it("is incomplete when the President never decides", async () => {
    const claude = new ScriptedProvider([hireHr, textResponse("ok"), textResponse("thinking")]);
    const local = new ScriptedProvider([hirePm, textResponse("ok")]);
    const r = await runBidChain(opts(1, { router: new ModelRouter({ claude, local }) }));
    expect(r).toMatchObject({ outcome: "incomplete", reason: "The President made no decision (task stopped: done)." });
    expect(r.opportunity?.noticeId).toBe("STUB-E02");
  });

  it("is incomplete when slice 1 fails, before any job is picked", async () => {
    const r = await runBidChain(opts(1, { router: new ModelRouter({ claude: new ScriptedProvider([textResponse("no")]), local: new ScriptedProvider([]) }) }));
    expect(r).toMatchObject({ outcome: "incomplete", opportunity: null, selected: [], quotedCostUsd: 0, marginUsd: null });
  });

  it("is incomplete when the owner rejects the bid-team hires", async () => {
    const approver: Approver = async (req) => ({ approve: req.gate !== "hire_agent", reason: "no hires" });
    const r = await runBidChain(opts(1, { approver, router: new ModelRouter(stubBidProviders()) }));
    expect(r).toMatchObject({ outcome: "incomplete", reason: "HR did not hire an Estimator or a Procurement agent (task stopped: done)." });
  });

  it("is incomplete with no estimate, and reports a bid the owner rejected", async () => {
    const claude = () => new ScriptedProvider([hireHr, textResponse("ok"), toolCallResponse("decide_opportunity", { decision: "pursue", rationale: "Good fit for us." }), textResponse("ok"),
      toolCallResponse("submit_bid", { price_usd: 1_000_000, assumptions: "" }), textResponse("done")]);
    const team = [hirePm, textResponse("ok"),
      toolCallResponse("propose_hire", { role: "estimator", instructions: "Estimate every job carefully.", budget_usd: 0.5, justification: "x" }, "e"),
      toolCallResponse("propose_hire", { role: "procurement", instructions: "Get quotes for every trade.", budget_usd: 0.5, justification: "x" }, "p"),
      textResponse("ok")];
    const none = await runBidChain(opts(1, { router: new ModelRouter({ claude: claude(), local: new ScriptedProvider([...team, textResponse("no estimate")]) }) }));
    expect(none).toMatchObject({ outcome: "incomplete", reason: "The Estimator submitted no estimate (task stopped: done)." });

    const est = toolCallResponse("submit_estimate", { line_items: [{ trade: "painting", scope: "", cost_usd: 1 }], notes: "" });
    const local = new ScriptedProvider([...team, est, textResponse("ok"),
      toolCallResponse("request_quotes", { trade: "painting" }, "q1"), toolCallResponse("select_quote", { quote_id: "Q-painting-1" }, "q2"), textResponse("done")]);
    const approver: Approver = async (req) => ({ approve: req.gate !== "submit_bid", reason: "too high" });
    const rejected = await runBidChain(opts(1, { approver, router: new ModelRouter({ claude: claude(), local }) }));
    expect(rejected).toMatchObject({ outcome: "owner_declined", reason: "The owner rejected the bid: too high", award: null });
    expect(rejected.selected.map((q) => q.quoteId)).toEqual(["Q-painting-1"]);
  });

  it("refuses a bid below the cost of the selected quotes", async () => {
    const claude = new ScriptedProvider([hireHr, textResponse("ok"), toolCallResponse("decide_opportunity", { decision: "pursue", rationale: "Good fit for us." }), textResponse("ok"),
      toolCallResponse("submit_bid", { price_usd: 1_000, assumptions: "" }), textResponse("I could not bid.")]);
    const local = new ScriptedProvider([hirePm, textResponse("ok"),
      toolCallResponse("propose_hire", { role: "estimator", instructions: "Estimate every job carefully.", budget_usd: 0.5, justification: "x" }, "e"),
      toolCallResponse("propose_hire", { role: "procurement", instructions: "Get quotes for every trade.", budget_usd: 0.5, justification: "x" }, "p"),
      textResponse("ok"), toolCallResponse("submit_estimate", { line_items: [{ trade: "painting", scope: "", cost_usd: 1 }], notes: "" }), textResponse("ok"),
      toolCallResponse("request_quotes", { trade: "painting" }, "q1"), toolCallResponse("select_quote", { quote_id: "Q-painting-1" }, "q2"), textResponse("done")]);
    const asked: string[] = [];
    const r = await runBidChain(opts(1, { router: new ModelRouter({ claude, local }), approver: async (q) => (asked.push(q.gate), { approve: true }) }));
    expect(r).toMatchObject({ outcome: "incomplete", reason: "The PM proposed no bid (task stopped: done).", bid: null });
    expect(asked).not.toContain("submit_bid");
    expect(r.events.some((e) => e.type === "bid_refused")).toBe(true);
  });

  it("is incomplete when the PM never bids", async () => {
    const providers = stubBidProviders();
    const script = (providers.claude as unknown as { script: unknown[] }).script;
    script.splice(4, 2, textResponse("I will not bid."));
    const r = await runBidChain(opts(1, { router: new ModelRouter(providers) }));
    expect(r).toMatchObject({ outcome: "incomplete", reason: "The PM proposed no bid (task stopped: done)." });
  });

  it("picks a job by seed and complexity, and rejects an unknown job", async () => {
    const claude = new ScriptedProvider([hireHr, textResponse("ok"), textResponse("hmm")]);
    const local = new ScriptedProvider([hirePm, textResponse("ok")]);
    const r = await runBidChain(opts(4, { noticeId: undefined, complexity: "complex", router: new ModelRouter({ claude, local }) }));
    expect(r.opportunity?.complexity).toBe("complex");
    const bad = new ModelRouter({ claude: new ScriptedProvider([hireHr, textResponse("ok")]), local: new ScriptedProvider([hirePm, textResponse("ok")]) });
    await expect(runBidChain(opts(1, { noticeId: "STUB-ZZZ", router: bad }))).rejects.toThrow("No solicitation STUB-ZZZ");
  });
});
