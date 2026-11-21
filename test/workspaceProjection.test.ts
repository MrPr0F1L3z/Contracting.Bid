import { describe, expect, it } from "vitest";
import { GATE_STAGE, WORKSPACE_STAGES, laterStage, projectJob, projectJobs, stageForGate, workspaceStats } from "../src/workspace/projection.js";
import { GATES } from "../src/approvals/approvals.js";
import type { LoggedEvent } from "../src/events/eventLog.js";
import { runCloseoutChain } from "../src/sim/closeoutChain.js";
import type { JobChainOptions } from "../src/sim/jobChain.js";
import { stubJobProviders } from "../src/sim/stubJob.js";
import { STUB_BID_JOB } from "../src/sim/stubBid.js";
import { ModelRouter } from "../src/models/router.js";
import { STUB_OPPORTUNITIES } from "../src/opportunities/stub.js";

const opts = (seed: number, extra: Partial<JobChainOptions> = {}): JobChainOptions => ({
  runId: "ws-1", seed, router: new ModelRouter(stubJobProviders()), approver: async () => ({ approve: true }), runBudgetUsd: 5, noticeId: STUB_BID_JOB, forceAward: true, ...extra,
});
let seq = 0;
const ev = (type: string, payload: Record<string, unknown> = {}, runId = "r1", actor = "world"): LoggedEvent => ({ runId, type, actor, simTime: 0, payload, seq: ++seq });

describe("laterStage and stageForGate", () => {
  it("only moves forward", () => {
    expect(laterStage("bid", "award")).toBe("award");
    expect(laterStage("award", "bid")).toBe("award");
    expect(laterStage("find", "find")).toBe("find");
  });
  it("maps every gate but hiring to a stage, and hiring to the job's own", () => {
    expect(Object.keys(GATE_STAGE).sort()).toEqual(GATES.filter((g) => g !== "hire_agent").sort());
    for (const s of Object.values(GATE_STAGE)) expect(WORKSPACE_STAGES).toContain(s);
    expect(stageForGate("submit_bid", "find")).toBe("bid");
    expect(stageForGate("hire_agent", "schedule")).toBe("schedule");
  });
});

describe("projectJob (unit, hand-written events)", () => {
  it("starts empty at find", () => {
    expect(projectJob("r1", [])).toMatchObject({ runId: "r1", stage: "find", status: "active", finished: false, noticeId: null, tasks: [], quotes: [], bidStatus: "none", profitUsd: null });
  });
  it("names the job and its agency, ignoring other runs", () => {
    const j = projectJob("r1", [ev("opportunity_found", { noticeId: "STUB-E02", title: "Paint" }), ev("opportunity_found", { noticeId: "X", title: "Other" }, "r2")], STUB_OPPORTUNITIES);
    expect(j).toMatchObject({ noticeId: "STUB-E02", title: "Paint", agency: STUB_OPPORTUNITIES.find((o) => o.noticeId === "STUB-E02")!.agency });
    expect(projectJob("r1", [ev("opportunity_found", { noticeId: "NOPE", title: "T" })]).agency).toBeNull();
    expect(projectJob("r1", [ev("opportunity_found", { noticeId: "NOPE", title: "T", agency: "From the event" })]).agency).toBe("From the event");
  });
  it("marks a job passed when the President or the owner declines", () => {
    expect(projectJob("r1", [ev("opportunity_decided", { decision: "pass" })]).status).toBe("passed");
    expect(projectJob("r1", [ev("opportunity_decided", { decision: "pursue", ownerApproved: false })]).status).toBe("passed");
    expect(projectJob("r1", [ev("opportunity_decided", { decision: "pursue", ownerApproved: true })])).toMatchObject({ status: "active", stage: "research" });
  });
  it("tracks quotes per trade, the selection and a re-quote", () => {
    const j = projectJob("r1", [
      ev("estimate_submitted", { totalUsd: 90, lines: [{ trade: "painting" }, { trade: "flooring" }, { nope: 1 }] }),
      ev("quotes_received", { trade: "painting", quotes: [{ quoteId: "a", trade: "painting", subcontractor: "A", priceUsd: 10 }, { quoteId: "b", trade: "painting", subcontractor: "B", priceUsd: 12 }, { trade: "painting" }] }),
      ev("quotes_received", { trade: "painting", quotes: [{ quoteId: "a", trade: "painting", subcontractor: "A", priceUsd: 99 }] }),
      ev("quote_selected", { quoteId: "a", trade: "painting", priceUsd: 10 }),
      ev("quote_selected", { quoteId: "b", trade: "painting", priceUsd: 13 }),
    ]);
    expect(j).toMatchObject({ stage: "bid", estimateUsd: 90, trades: ["painting", "flooring"] });
    expect(j.quotes).toEqual([
      { quoteId: "a", trade: "painting", subcontractor: "A", priceUsd: 10, selected: false },
      { quoteId: "b", trade: "painting", subcontractor: "B", priceUsd: 13, selected: true },
    ]);
    expect(workspaceStats([j])).toMatchObject({ quotesRequested: 2, quotesReceived: 1, quotesOutstanding: 1 });
  });
  it("follows a bid to a loss, and to a forced award", () => {
    const lost = [ev("bid_submitted", { priceUsd: 100 }), ev("award_decided", { awarded: false })];
    expect(projectJob("r1", [ev("bid_submitted", { priceUsd: 100 })])).toMatchObject({ stage: "award", bidStatus: "submitted", bidUsd: 100 });
    expect(projectJob("r1", lost)).toMatchObject({ status: "lost", bidStatus: "lost" });
    expect(projectJob("r1", [...lost, ev("award_forced")])).toMatchObject({ status: "active", bidStatus: "won" });
    expect(projectJob("r1", [ev("award_decided", { awarded: true })])).toMatchObject({ status: "active", bidStatus: "won" });
  });
  it("lists approvals the owner has not answered, under the right stage", () => {
    const asked = [
      ev("contract_signed", { priceUsd: 100, contractDays: 10 }),
      ev("approval_requested", { approvalId: 1, gate: "hire_agent", role: "project_manager", automatic: true }, "r1", "hr#2"),
      ev("approval_requested", { approvalId: 2, gate: "sign_commitment", summary: "Issue 2 subcontracts." }, "r1", "project_manager#3"),
      ev("approval_requested", { approvalId: 3, gate: "hire_agent", role: "scheduler", automatic: false }, "r1", "hr#2"),
      ev("approval_requested", { approvalId: 4, gate: "submit_bid", summary: "Old" }),
      ev("approval_decided", { approvalId: 4, status: "approved" }),
    ];
    const j = projectJob("r1", asked);
    expect(j.tasks).toEqual([
      { id: "r1:2", runId: "r1", approvalId: 2, gate: "sign_commitment", stage: "subs", summary: "Issue 2 subcontracts.", requestedBy: "project_manager#3" },
      { id: "r1:3", runId: "r1", approvalId: 3, gate: "hire_agent", stage: "award", summary: "Hire a scheduler.", requestedBy: "hr#2" },
    ]);
    expect(workspaceStats([j]).urgent).toBe(2);
    expect(projectJob("r1", [...asked, ev("agent_hired", { approvalId: 3 })]).tasks.map((t) => t.approvalId)).toEqual([2]);
    expect(projectJob("r1", [...asked, ev("run_finished")])).toMatchObject({ finished: true, tasks: [] });
  });
  it("records problems, change orders and disputes", () => {
    const j = projectJob("r1", [
      ev("problem_injected", { problem: "weather-delay", trade: "flooring" }),
      ev("problem_resolved", { problem: "weather-delay", trade: "flooring", choice: "accept_delay", costUsd: 0, days: 4 }),
      ev("problem_injected", { problem: "sub-no-show", trade: "flooring" }),
      ev("problem_unresolved", { problem: "sub-no-show", option: "wait", days: 6 }),
      ev("change_order_decided", { problem: "change-order", priceUsd: 12, accepted: false }),
      ev("change_order_decided", { problem: "change-order", priceUsd: 9, days: 2, accepted: true }),
      ev("change_disputed", { problem: "hidden-conditions" }),
      ev("problem_injected", {}),
    ]);
    expect(j.changeOrdersUsd).toBe(9);
    expect(j.problems).toEqual([
      { id: "weather-delay", trade: "flooring", resolved: true, choice: "accept_delay", costUsd: 0, days: 4 },
      { id: "sub-no-show", trade: "flooring", resolved: false, choice: "wait", costUsd: 0, days: 6 },
      { id: "change-order", trade: null, resolved: true, choice: "change_order", costUsd: 0, days: 2 },
      { id: "hidden-conditions", trade: null, resolved: true, choice: "disputed", costUsd: 0, days: 0 },
      { id: "unknown", trade: null, resolved: false, choice: null, costUsd: 0, days: 0 },
    ]);
  });
  it("ignores a returned invoice and tolerates malformed payloads", () => {
    expect(projectJob("r1", [ev("invoice_submitted", { amountUsd: 5, accepted: false })])).toMatchObject({ invoicedUsd: 0, stage: "find" });
    expect(projectJob("r1", [ev("estimate_submitted", { totalUsd: "x", lines: "y" }), ev("quotes_received", { quotes: null }), ev("schedule_set", {}), ev("unknown_type")])).toMatchObject({ estimateUsd: 0, trades: [], quotes: [], schedule: [] });
  });
});

describe("projectJob (functional, a scripted run from hiring to closeout)", () => {
  it("matches the run's own report at the end (seed 3)", async () => {
    const r = await runCloseoutChain(opts(3));
    const j = projectJob("ws-1", r.events, STUB_OPPORTUNITIES);
    expect(j).toMatchObject({
      noticeId: r.opportunity!.noticeId, title: r.opportunity!.title, stage: "closeout", status: "closed", finished: true, tasks: [],
      estimateUsd: r.estimate!.lines.reduce((a, l) => a + l.costUsd, 0), bidUsd: r.bid!.priceUsd, bidStatus: "won",
      contractUsd: r.account!.contractPriceUsd, changeOrdersUsd: r.account!.changeOrderRevenueUsd, costUsd: r.account!.costUsd,
      invoicedUsd: r.invoice!.amountUsd, receivedUsd: r.closeout!.receivedUsd, paidOutUsd: r.closeout!.paidOutUsd, profitUsd: r.closeout!.cashProfitUsd, daysLate: r.account!.daysLate,
    });
    expect(j.agency).not.toBeNull();
    expect(j.quotes.filter((q) => q.selected).map((q) => q.quoteId).sort()).toEqual(r.selected.map((q) => q.quoteId).sort());
    expect(j.schedule).toEqual(r.schedule);
    expect(j.problems.map((p) => p.id).sort()).toEqual([...new Set([...r.siteProblems.map((p) => p.id), "late-payment"])].sort());
    expect(workspaceStats([j])).toEqual({ quotesRequested: 0, quotesReceived: 0, quotesOutstanding: 0, bidsAwaiting: 0, bidsAwaitingUsd: 0, awardedJobs: 1, urgent: 0 });
  });

  it("shows the job moving through the stages as the events arrive, never backwards", async () => {
    const r = await runCloseoutChain(opts(1));
    const seen: string[] = [];
    let last = 0;
    for (let n = 1; n <= r.events.length; n++) {
      const j = projectJob("ws-1", r.events.slice(0, n));
      const at = WORKSPACE_STAGES.indexOf(j.stage);
      expect(at).toBeGreaterThanOrEqual(last);
      last = at;
      if (seen.at(-1) !== j.stage) seen.push(j.stage);
    }
    expect(seen).toEqual([...WORKSPACE_STAGES]);
  });

  it("holds a task while the owner has not answered, and clears it after", async () => {
    const r = await runCloseoutChain(opts(1));
    // What the workspace saw at the gate: everything up to and including the request.
    const at = r.events.findIndex((e) => e.type === "approval_requested" && e.payload.gate === "submit_bid");
    const waiting = projectJob("ws-1", r.events.slice(0, at + 1));
    expect(waiting.tasks).toHaveLength(1);
    expect(waiting.tasks[0]).toMatchObject({ gate: "submit_bid", stage: "bid" });
    expect(waiting.tasks[0]!.summary).toMatch(/^Submit a \$/);
    expect(workspaceStats([waiting])).toMatchObject({ urgent: 1, quotesRequested: 2, quotesReceived: 2, quotesOutstanding: 0 });
    expect(projectJob("ws-1", r.events.slice(0, at + 2)).tasks).toEqual([]);
  });

  it("stops at lost when the bid is not awarded", async () => {
    const r = await runCloseoutChain(opts(2, { forceAward: false }));
    const j = projectJob("ws-1", r.events);
    expect(j).toMatchObject({ status: "lost", bidStatus: "lost", stage: "award", contractUsd: null, finished: true });
    expect(workspaceStats([j])).toMatchObject({ awardedJobs: 0, bidsAwaiting: 0 });
  });
});

describe("projectJobs and workspaceStats", () => {
  it("returns one job per run, in first-seen order, and adds their counts", () => {
    const jobs = projectJobs([
      ev("bid_submitted", { priceUsd: 100 }, "b"),
      ev("contract_signed", { priceUsd: 50, contractDays: 5 }, "a"),
      ev("bid_submitted", { priceUsd: 30 }, "c"),
      ev("approval_requested", { approvalId: 1, gate: "close_project", summary: "Close" }, "a"),
    ]);
    expect(jobs.map((j) => j.runId)).toEqual(["b", "a", "c"]);
    expect(workspaceStats(jobs)).toEqual({ quotesRequested: 0, quotesReceived: 0, quotesOutstanding: 0, bidsAwaiting: 2, bidsAwaitingUsd: 130, awardedJobs: 1, urgent: 1 });
    expect(projectJobs([])).toEqual([]);
    expect(workspaceStats([])).toEqual({ quotesRequested: 0, quotesReceived: 0, quotesOutstanding: 0, bidsAwaiting: 0, bidsAwaitingUsd: 0, awardedJobs: 0, urgent: 0 });
  });
});

describe("projectJob team, decisions and run facts", () => {
  it("records the seed and the injected problems", () => {
    const j = projectJob("r1", [ev("run_started", { seed: 42, problems: ["change-order", 7, "late-delivery"] })]);
    expect(j.seed).toBe(42);
    expect(j.injected).toEqual(["change-order", "late-delivery"]);
    expect(projectJob("r1", [ev("run_started", { seed: "x" })])).toMatchObject({ seed: null, injected: [] });
  });

  it("lists each hired agent once, in hiring order, with who hired it", () => {
    const j = projectJob("r1", [
      ev("agent_hired", { agentId: 1, role: "president", managerId: null }, "r1", "owner"),
      ev("agent_hired", { approvalId: 1, agentId: 2, role: "hr", managerId: 1, budgetUsd: 2 }, "r1", "president#1"),
      ev("agent_hired", { agentId: 2, role: "hr" }, "r1", "president#1"),
    ]);
    expect(j.team).toEqual([
      { agentId: 1, role: "president", managerId: null, budgetUsd: null, hiredBy: "owner" },
      { agentId: 2, role: "hr", managerId: 1, budgetUsd: 2, hiredBy: "president#1" },
    ]);
  });

  it("keeps answered approvals as decisions", () => {
    const j = projectJob("r1", [
      ev("approval_requested", { approvalId: 6, gate: "submit_bid", summary: "Bid" }, "r1", "president#1"),
      ev("approval_decided", { approvalId: 6, gate: "submit_bid", status: "approved", reason: "ok" }, "r1", "owner"),
      ev("approval_decided", { approvalId: 7, gate: "sign_contract" }, "r1", "owner"),
    ]);
    expect(j.tasks).toEqual([]);
    expect(j.decisions).toEqual([
      { approvalId: 6, gate: "submit_bid", status: "approved", reason: "ok" },
      { approvalId: 7, gate: "sign_contract", status: "decided", reason: null },
    ]);
  });
});
