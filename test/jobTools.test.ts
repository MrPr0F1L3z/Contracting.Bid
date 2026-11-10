import { describe, expect, it } from "vitest";
import { MAX_CHANGE_ORDER_TRIES, kickoffTools, priceChangeOrderTool, problemBrief, resolveProblemTool, setScheduleTool, type JobState } from "../src/agents/jobTools.js";
import type { Approver } from "../src/agents/hiringTools.js";
import type { ApprovalRequest } from "../src/approvals/approvals.js";
import { ModelRouter } from "../src/models/router.js";
import { ScriptedProvider } from "../src/models/stub.js";
import { STUB_OPPORTUNITIES } from "../src/opportunities/stub.js";
import { Company } from "../src/sim/company.js";
import { PROBLEM_CATALOG } from "../src/sim/problems.js";
import { SeededRng } from "../src/sim/rng.js";
import { BidWorld } from "../src/world/market.js";
import { SiteWorld, type SiteProblem } from "../src/world/site.js";

const e02 = STUB_OPPORTUNITIES.find((o) => o.noticeId === "STUB-E02")!;

function setup(approver: Approver = async () => ({ approve: true }), problemIds: string[] = []) {
  const asked: ApprovalRequest[] = [];
  const c = new Company({
    runId: "r", seed: 1, router: new ModelRouter({ claude: new ScriptedProvider([]), local: new ScriptedProvider([]) }),
    approver: async (req) => (asked.push({ ...req }), approver(req)), runBudgetUsd: 5,
  });
  const agent = c.appointPresident();
  const bid = new BidWorld(e02, new SeededRng(1));
  for (const t of bid.requiredTrades) bid.select(bid.quotesFor(t)[0]!.quoteId);
  const problems = problemIds.map((id, i) => ({ problem: PROBLEM_CATALOG.find((p) => p.id === id)!, phaseProgress: i / 10 }));
  const site = new SiteWorld(bid, 100_000, new SeededRng(1), problems);
  const state: JobState = { changeOrderTries: {} };
  return { c, agent, site, state, asked, types: () => c.log.list().map((e) => e.type) };
}
const tool = (tools: ReturnType<typeof kickoffTools>, name: string) => tools.find((t) => t.definition.name === name)!;
const scheduled = (s: ReturnType<typeof setup>) => (s.site.setSchedule(["painting", "flooring"]), s.site.siteProblems());

describe("kickoff tools", () => {
  it("signs the prime contract, then the subcontracts, each once, through the owner", async () => {
    const { c, agent, site, state, asked, types } = setup();
    const tools = kickoffTools(c, agent, site, state);
    expect(await tool(tools, "issue_subcontracts").handle({})).toMatchObject({ isError: true, content: "Sign the prime contract first." });
    expect((await tool(tools, "sign_prime_contract").handle({})).content).toBe("The owner signed the prime contract: $100,000, 15 working days.");
    expect(asked[0]).toMatchObject({ gate: "sign_contract", amountUsd: 100_000, summary: "Sign the prime contract for STUB-E02 at $100,000, 15 working days, liquidated damages $250 per day late." });
    expect(await tool(tools, "sign_prime_contract").handle({})).toMatchObject({ isError: true, content: "The prime contract is already signed." });
    const total = [...site.subcontracts.values()].reduce((a, q) => a + q.priceUsd, 0);
    expect((await tool(tools, "issue_subcontracts").handle({})).content).toBe(`The owner signed 2 subcontracts totaling $${total.toLocaleString("en-US")}.`);
    expect(asked[1]).toMatchObject({ gate: "sign_commitment", amountUsd: total });
    expect(asked[1]!.summary).toMatch(/^Issue 2 subcontracts for STUB-E02 totaling/);
    expect(await tool(tools, "issue_subcontracts").handle({})).toMatchObject({ isError: true, content: "The subcontracts are already issued." });
    expect(state).toMatchObject({ contractSigned: true, subcontractsIssued: true });
    expect(types()).toEqual(expect.arrayContaining(["contract_signed", "subcontracts_issued"]));
  });

  it("reports the owner's refusals", async () => {
    let n = 0;
    const { c, agent, site, state } = setup(async () => (n++ === 0 ? { approve: false, reason: "price too low" } : { approve: n < 3, reason: "later" }));
    const tools = kickoffTools(c, agent, site, state);
    expect(await tool(tools, "sign_prime_contract").handle({})).toEqual({ isError: true, content: "The owner did not sign: price too low." });
    await tool(tools, "sign_prime_contract").handle({});
    expect(await tool(tools, "issue_subcontracts").handle({})).toEqual({ isError: true, content: "The owner did not sign the subcontracts: later." });
    expect(state.subcontractsIssued).toBeUndefined();
  });
});

describe("set_schedule", () => {
  it("validates the input and the sequence, then reports the plan", async () => {
    const { c, agent, site, types } = setup();
    const t = setScheduleTool(c, agent, site);
    expect(await t.handle({ sequence: "painting" })).toMatchObject({ isError: true, content: "sequence must be a list of trade names" });
    expect(await t.handle({ sequence: ["flooring", "painting"] })).toEqual({ isError: true, content: "painting must come before flooring" });
    const res = await t.handle({ sequence: ["painting", "flooring"] });
    const p = site.durationOf("painting");
    expect(res.content.split("\n")).toEqual([
      `painting: day 1 to ${p}`,
      `flooring: day ${p + 1} to ${site.plannedDays()}`,
      `Planned: ${site.plannedDays()} working days of 15 in the contract.`,
    ]);
    expect(types()).toContain("schedule_set");
  });
});

describe("problemBrief", () => {
  it("lists the options and the liquidated damages for a fixed-option problem", () => {
    const s = setup(undefined, ["late-delivery"]);
    const [p] = scheduled(s);
    const lines = problemBrief(s.site, p!).split("\n");
    expect(lines[0]).toBe(`Day ${p!.day + 1} of 15 on STUB-E02: ${p!.description}`);
    expect(lines[1]).toBe("Options (choose one with resolve_problem):");
    expect(lines[2]).toMatch(/^- expedite: .*Cost \$[\d,]+, delay 0 working days\.$/);
    expect(lines.at(-1)).toBe("Liquidated damages are $250 per working day past the contract time.");
  });
  it("asks for a priced change order without showing its true cost", () => {
    const s = setup(undefined, ["change-order", "hidden-conditions"]);
    const ps = scheduled(s);
    const hidden = ps.find((p) => p.id === "hidden-conditions") as SiteProblem;
    const co = ps.find((p) => p.id === "change-order") as SiteProblem;
    expect(problemBrief(s.site, co)).toContain("The government must pay for directed changes.");
    expect(problemBrief(s.site, hidden)).toContain("This is a differing site condition.");
    expect(problemBrief(s.site, co)).not.toContain(co.change!.costUsd.toLocaleString("en-US"));
  });
});

describe("resolve_problem", () => {
  it("records one valid option, once", async () => {
    const s = setup(undefined, ["double-booked"]);
    const [p] = scheduled(s);
    const t = resolveProblemTool(s.c, s.agent, s.site, p!);
    expect(t.definition.inputSchema).toMatchObject({ properties: { option_id: { enum: ["pay_overtime", "resequence"] } } });
    expect(await t.handle({ option_id: "pray", note: "" })).toEqual({ isError: true, content: 'Unknown option "pray"; use pay_overtime or resequence' });
    expect(await t.handle({ option_id: "resequence", note: "cheap" })).toEqual({ content: "Resolved: Wait for the crew." });
    expect(s.site.resolved()).toEqual([{ problemId: "double-booked", trade: p!.trade, choice: "resequence", costUsd: 0, days: 2 }]);
    expect(await t.handle({ option_id: "pay_overtime", note: "" })).toMatchObject({ isError: true, content: "This problem is already resolved." });
    expect(s.c.log.list({ type: "problem_resolved" })[0]?.payload).toMatchObject({ note: "cheap" });
  });
});

describe("price_change_order", () => {
  it("is only for scope changes", () => {
    const s = setup(undefined, ["double-booked"]);
    const [p] = scheduled(s);
    expect(() => priceChangeOrderTool(s.c, s.agent, s.site, p!, s.state)).toThrow("double-booked is not a scope change");
  });

  it("validates input, goes through the owner, and records an accepted change order", async () => {
    const s = setup(undefined, ["change-order"]);
    const [p] = scheduled(s);
    const t = priceChangeOrderTool(s.c, s.agent, s.site, p!, s.state);
    expect(await t.handle({ price_usd: 0, days: 1 })).toMatchObject({ isError: true, content: "price_usd must be a positive number" });
    expect(await t.handle({ price_usd: 10, days: 1.5 })).toMatchObject({ isError: true, content: "days must be a whole number of 0 or more" });
    const fair = Math.floor(p!.change!.costUsd * 1.15);
    const res = await t.handle({ price_usd: fair, days: p!.change!.days, justification: "cost plus 15%" });
    expect(res.content).toBe(`The contracting officer accepted the change order: $${fair.toLocaleString("en-US")} and ${p!.change!.days} days.`);
    expect(s.asked[0]).toMatchObject({ gate: "approve_change_order", amountUsd: fair });
    expect(s.site.resolved()[0]).toMatchObject({ choice: "change_order", costUsd: p!.change!.costUsd, changeOrder: { priceUsd: fair, days: p!.change!.days } });
    expect(await t.handle({ price_usd: 1, days: 0 })).toMatchObject({ isError: true, content: "This change is already settled." });
  });

  it("lets the owner reject a price without using up a try", async () => {
    const s = setup(async () => ({ approve: false, reason: "ask more" }), ["change-order"]);
    const [p] = scheduled(s);
    const t = priceChangeOrderTool(s.c, s.agent, s.site, p!, s.state);
    expect(await t.handle({ price_usd: 1, days: 0 })).toEqual({ isError: true, content: "The owner rejected this change order: ask more. You may revise it." });
    expect(s.state.changeOrderTries).toEqual({});
  });

  it(`puts the change under dispute after ${MAX_CHANGE_ORDER_TRIES} rejected prices`, async () => {
    const s = setup(undefined, ["hidden-conditions"]);
    const [p] = scheduled(s);
    const t = priceChangeOrderTool(s.c, s.agent, s.site, p!, s.state);
    const high = p!.change!.costUsd * 3;
    expect((await t.handle({ price_usd: high, days: 1 })).content).toMatch(/above the government's estimate.* You have 2 tries left\.$/);
    await t.handle({ price_usd: high, days: 1 });
    const last = await t.handle({ price_usd: high, days: 1 });
    expect(last).toMatchObject({ isError: true });
    expect(last.content).toMatch(/That was the last try/);
    expect(s.site.resolved()).toEqual([{ problemId: "hidden-conditions", trade: p!.trade, choice: "disputed", costUsd: p!.change!.costUsd, days: p!.change!.days, changeOrder: null }]);
    expect(s.types()).toContain("change_disputed");
  });
});
