import { describe, expect, it } from "vitest";
import { decideOpportunityTool, procurementTools, submitBidTool, submitEstimateTool, type BidState } from "../src/agents/bidTools.js";
import type { Approver } from "../src/agents/hiringTools.js";
import type { ApprovalRequest } from "../src/approvals/approvals.js";
import { ModelRouter } from "../src/models/router.js";
import { ScriptedProvider } from "../src/models/stub.js";
import { STUB_OPPORTUNITIES } from "../src/opportunities/stub.js";
import { Company } from "../src/sim/company.js";
import { PROBLEM_CATALOG } from "../src/sim/problems.js";
import { SeededRng } from "../src/sim/rng.js";
import { BidWorld } from "../src/world/market.js";

const e02 = STUB_OPPORTUNITIES.find((o) => o.noticeId === "STUB-E02")!;

function setup(approver: Approver = async () => ({ approve: true }), problems = false) {
  const asked: ApprovalRequest[] = [];
  const c = new Company({
    runId: "r",
    seed: 1,
    router: new ModelRouter({ claude: new ScriptedProvider([]), local: new ScriptedProvider([]) }),
    approver: async (req) => (asked.push({ ...req }), approver(req)),
    runBudgetUsd: 5,
  });
  const agent = c.appointPresident();
  const sched = problems ? [{ problem: PROBLEM_CATALOG.find((p) => p.id === "quote-expired")!, phaseProgress: 0 }] : [];
  const world = new BidWorld(e02, new SeededRng(5), sched);
  const state: BidState = {};
  const types = () => c.log.list().map((e) => e.type);
  return { c, agent, world, state, asked, types };
}

describe("decide_opportunity", () => {
  it("validates the decision and rationale", async () => {
    const { c, agent, world, state } = setup();
    const tool = decideOpportunityTool(c, agent, world, state);
    expect(await tool.handle({ decision: "maybe", rationale: "long enough reason" })).toMatchObject({ isError: true, content: 'decision must be "pursue" or "no_bid"' });
    expect(await tool.handle({ decision: "pursue", rationale: "short" })).toMatchObject({ isError: true, content: "rationale must explain the decision" });
    expect(state.decision).toBeUndefined();
  });

  it("records a no-bid without asking the owner", async () => {
    const { c, agent, world, state, asked, types } = setup();
    const res = await decideOpportunityTool(c, agent, world, state).handle({ decision: "no_bid", rationale: "Outside our capacity this month." });
    expect(res).toEqual({ content: "Recorded: no bid." });
    expect(state.decision).toEqual({ pursue: false, rationale: "Outside our capacity this month." });
    expect(asked).toEqual([]);
    expect(types()).toContain("opportunity_decided");
  });

  it("sends a pursue decision to the owner, and does not ask twice once approved", async () => {
    const { c, agent, world, state, asked } = setup();
    const tool = decideOpportunityTool(c, agent, world, state);
    expect(await tool.handle({ decision: "pursue", rationale: "Good fit for a small team." })).toEqual({ content: "The owner approved pursuing this job. Estimating starts next." });
    expect(asked[0]).toMatchObject({ gate: "pursue_opportunity", requestedBy: "president#1", summary: 'Pursue STUB-E02 "Interior paint and flooring refresh, visitor center". Good fit for a small team.' });
    expect(state.decision).toEqual({ pursue: true, rationale: "Good fit for a small team.", ownerApproved: true });
    expect(await tool.handle({ decision: "no_bid", rationale: "Changed my mind entirely." })).toMatchObject({ isError: true });
    expect(asked).toHaveLength(1);
  });

  it("reports the owner's refusal and reason", async () => {
    const { c, agent, world, state } = setup(async () => ({ approve: false, reason: "too far away" }));
    const res = await decideOpportunityTool(c, agent, world, state).handle({ decision: "pursue", rationale: "Good fit for a small team." });
    expect(res).toEqual({ content: "The owner declined to pursue: too far away.", isError: true });
    expect(state.decision).toMatchObject({ pursue: true, ownerApproved: false, ownerReason: "too far away" });
  });
});

describe("submit_estimate", () => {
  const line = (trade: string, cost: unknown = 1000) => ({ trade, scope: "s", cost_usd: cost });
  it("rejects empty, unknown, duplicate and non-positive lines", async () => {
    const { c, agent, state } = setup();
    const tool = submitEstimateTool(c, agent, state);
    expect(await tool.handle({ line_items: [], notes: "" })).toMatchObject({ isError: true, content: "line_items must list at least one trade" });
    expect((await tool.handle({ line_items: [line("carpentry")], notes: "" })).content).toMatch(/^Unknown trade "carpentry"; use one of: sitework/);
    expect(await tool.handle({ line_items: [line("painting"), line("painting")], notes: "" })).toMatchObject({ content: "painting is listed twice; combine it into one line" });
    expect(await tool.handle({ line_items: [line("painting", 0)], notes: "" })).toMatchObject({ content: "cost_usd for painting must be a positive number" });
    expect(await tool.handle({ line_items: [line("painting", "5")], notes: "" })).toMatchObject({ isError: true });
    expect(state.estimate).toBeUndefined();
  });

  it("records rounded lines and replaces an earlier estimate", async () => {
    const { c, agent, state, types } = setup();
    const tool = submitEstimateTool(c, agent, state);
    await tool.handle({ line_items: [line("painting", 10)], notes: "first" });
    const res = await tool.handle({ line_items: [line("painting", 40_000.4), { trade: "flooring", cost_usd: 50_000 }], notes: 7 });
    expect(res).toEqual({ content: "Estimate recorded: 2 trades, $90,000 in subcontract cost." });
    expect(state.estimate).toEqual({
      lines: [{ trade: "painting", scope: "s", costUsd: 40_000 }, { trade: "flooring", scope: "", costUsd: 50_000 }],
      notes: "",
    });
    expect(types().filter((t) => t === "estimate_submitted")).toHaveLength(2);
  });
});

describe("procurement tools", () => {
  const byName = (tools: ReturnType<typeof procurementTools>) => Object.fromEntries(tools.map((t) => [t.definition.name, t]));

  it("requests quotes for a known trade only", async () => {
    const { c, agent, world, state, types } = setup();
    const t = byName(procurementTools(c, agent, world, state));
    expect(await t.request_quotes!.handle({ trade: "nope" })).toMatchObject({ isError: true, content: 'Unknown trade "nope"' });
    const res = await t.request_quotes!.handle({ trade: "painting" });
    const first = world.quotesFor("painting")[0]!;
    expect(res.content.split("\n")[0]).toBe(`Q-painting-1: ${first.subcontractor}, $${first.priceUsd.toLocaleString("en-US")}, valid 30 days`);
    expect(types()).toContain("quotes_received");
  });

  it("selects quotes, reports errors, and shows status against the estimate", async () => {
    const { c, agent, world, state } = setup();
    state.estimate = { lines: [{ trade: "painting", scope: "", costUsd: 1 }, { trade: "flooring", scope: "", costUsd: 1 }], notes: "" };
    const t = byName(procurementTools(c, agent, world, state));
    expect(await t.select_quote!.handle({})).toMatchObject({ isError: true, content: "quote_id is required" });
    expect(await t.select_quote!.handle({ quote_id: "Q-painting-1" })).toMatchObject({ isError: true, content: expect.stringContaining("request quotes for painting first") });
    expect((await t.procurement_status!.handle({})).content).toBe("Selected: none\nStill open: painting, flooring");
    await t.request_quotes!.handle({ trade: "painting" });
    const q = world.quotesFor("painting")[0]!;
    expect((await t.select_quote!.handle({ quote_id: "Q-painting-1" })).content).toBe(`Selected Q-painting-1: ${q.subcontractor} at $${q.priceUsd.toLocaleString("en-US")}.`);
    expect((await t.procurement_status!.handle({})).content).toBe(`Selected: painting: Q-painting-1 $${q.priceUsd.toLocaleString("en-US")}\nStill open: flooring`);
  });

  it("tells Procurement when a quote expired and logs the injected problem", async () => {
    const { c, agent, world, state, types } = setup(undefined, true);
    const trade = world.injectedProblem()!.trade;
    const t = byName(procurementTools(c, agent, world, state));
    await t.request_quotes!.handle({ trade });
    const before = world.quotesFor(trade)[0]!.priceUsd;
    const res = await t.select_quote!.handle({ quote_id: `Q-${trade}-1` });
    expect(res.content).toMatch(new RegExp(`^Q-${trade}-1 had expired\\. .* re-quoted at \\$[\\d,]+ \\(was \\$${before.toLocaleString("en-US")}\\)\\. The new price is selected`));
    expect(types()).toContain("problem_injected");
    expect(c.log.list({ type: "problem_injected" })[0]?.payload).toMatchObject({ problem: "quote-expired", trade, fromUsd: before });
  });
});

describe("submit_bid", () => {
  it("validates the price", async () => {
    const { c, agent, world, state, asked } = setup();
    const tool = submitBidTool(c, agent, world, state);
    expect(await tool.handle({ price_usd: -1, assumptions: "" })).toMatchObject({ isError: true, content: "price_usd must be a positive number" });
    expect(asked).toEqual([]);
  });

  it("asks the owner with the amount, and blocks a second bid once approved", async () => {
    const { c, agent, world, state, asked } = setup();
    const tool = submitBidTool(c, agent, world, state);
    expect(await tool.handle({ price_usd: 99_999.6, assumptions: "12% markup" })).toEqual({ content: "The owner approved the $100,000 bid. It has been submitted to the contracting officer." });
    expect(asked[0]).toMatchObject({ gate: "submit_bid", amountUsd: 100_000, summary: "Submit a $100,000 bid on STUB-E02. 12% markup" });
    expect(state.bid).toEqual({ priceUsd: 100_000, assumptions: "12% markup", ownerApproved: true });
    expect(await tool.handle({ price_usd: 1, assumptions: "" })).toMatchObject({ isError: true, content: "A bid was already approved and submitted." });
  });

  it("lets the PM revise after the owner rejects a bid", async () => {
    let n = 0;
    const { c, agent, world, state } = setup(async () => (n++ === 0 ? { approve: false, reason: "too high" } : { approve: true }));
    const tool = submitBidTool(c, agent, world, state);
    expect(await tool.handle({ price_usd: 200_000 })).toEqual({ content: "The owner rejected this bid: too high. You may revise and propose again.", isError: true });
    expect(state.bid).toMatchObject({ priceUsd: 200_000, assumptions: "", ownerApproved: false, ownerReason: "too high" });
    await tool.handle({ price_usd: 150_000, assumptions: "lower" });
    expect(state.bid).toMatchObject({ priceUsd: 150_000, ownerApproved: true });
  });
});
