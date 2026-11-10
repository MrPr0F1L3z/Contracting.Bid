import { describe, expect, it } from "vitest";
import { runJobChain, type JobChainOptions } from "../src/sim/jobChain.js";
import { STUB_CHANGE_ORDER_USD, stubJobMove, stubJobProviders } from "../src/sim/stubJob.js";
import { STUB_BID_JOB } from "../src/sim/stubBid.js";
import { ModelRouter } from "../src/models/router.js";
import { ReactiveProvider, textResponse, toolCallsResponse } from "../src/models/stub.js";
import type { ModelRequest, ModelResponse } from "../src/models/types.js";
import type { Approver } from "../src/agents/hiringTools.js";

const yes: Approver = async () => ({ approve: true });
const opts = (seed: number, extra: Partial<JobChainOptions> = {}): JobChainOptions => ({
  runId: "job-1", seed, router: new ModelRouter(stubJobProviders()), approver: yes, runBudgetUsd: 5, noticeId: STUB_BID_JOB, ...extra,
});
const has = (r: ModelRequest, tool: string) => (r.tools ?? []).some((t) => t.name === tool);

/** The scripted company, except where `override` returns a response. */
function patched(override: (r: ModelRequest) => ModelResponse | undefined) {
  const play = (model: string) => new ReactiveProvider((r) => override(r) ?? stubJobMove(r, model), model);
  return new ModelRouter({ claude: play("stub-claude"), local: play("stub-claude-worker") });
}

describe("runJobChain (functional, scripted models)", () => {
  it("bids, wins and runs the job to a final account (seed 1)", async () => {
    const asked: string[] = [];
    const r = await runJobChain(opts(1, { approver: async (q) => (asked.push(q.gate), { approve: true }) }));
    expect(r.outcome).toBe("completed");
    expect(r.awardForced).toBe(false);
    expect(r.award?.awarded).toBe(true);
    expect(r.agents.map((a) => a.role)).toEqual(["president", "hr", "project_manager", "estimator", "procurement", "scheduler"]);
    expect(asked.slice(0, 7)).toEqual(["pursue_opportunity", "hire_agent", "hire_agent", "submit_bid", "sign_contract", "sign_commitment", "hire_agent"]);
    expect(asked.slice(7).every((g) => g === "approve_change_order")).toBe(true);
    expect(r.schedule?.map((l) => l.trade)).toEqual(["painting", "flooring"]);
    // Every execution problem the seed drew comes up once and is resolved.
    const drawn = r.problems.filter((p) => !["quote-expired", "late-payment"].includes(p)).sort();
    expect(r.siteProblems.map((p) => p.id).sort()).toEqual(drawn);
    expect(r.resolutions.map((x) => x.problemId).sort()).toEqual(drawn);
    expect(r.siteProblems.map((p) => p.day)).toEqual([...r.siteProblems.map((p) => p.day)].sort((a, b) => a - b));
    const a = r.account!;
    expect(a.contractPriceUsd).toBe(r.bid!.priceUsd);
    expect(a.subcontractUsd).toBe(r.quotedCostUsd);
    expect(a.profitUsd).toBe(a.revenueUsd - a.costUsd);
    expect(r.reason).toMatch(/^Finished in \d+ of \d+ working days \((on time|\d+ days? late)\); profit -?\$[\d,]+\.$/);
    const types = r.events.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["contract_signed", "subcontracts_issued", "schedule_set", "problem_injected", "job_completed"]));
    expect(r.events.at(-1)).toMatchObject({ type: "run_finished", payload: { outcome: "completed" } });
  });

  it("replays the same job from the same seed", async () => {
    const strip = (r: Awaited<ReturnType<typeof runJobChain>>) => ({ ...r, durationMs: 0, tasks: r.tasks.map((t) => ({ ...t, durationMs: 0, modelMs: 0 })) });
    expect(strip(await runJobChain(opts(7, { forceAward: true })))).toEqual(strip(await runJobChain(opts(7, { forceAward: true }))));
  });

  it("stops at a lost bid unless the award is forced (seed 2)", async () => {
    const lost = await runJobChain(opts(2));
    expect(lost).toMatchObject({ outcome: "lost", awardForced: false, account: null, schedule: null, resolutions: [] });
    const forced = await runJobChain(opts(2, { forceAward: true }));
    expect(forced).toMatchObject({ outcome: "completed", awardForced: true });
    expect(forced.events.some((e) => e.type === "award_forced")).toBe(true);
  });

  it("does not force an award for a bid that was not responsive", async () => {
    // Procurement selects nothing, so the bid misses both trades.
    const router = patched((r) => (has(r, "request_quotes") ? textResponse("No quotes today.") : undefined));
    const r = await runJobChain(opts(1, { router, forceAward: true }));
    expect(r).toMatchObject({ outcome: "lost", awardForced: false });
    expect(r.reason).toMatch(/^Not responsive/);
  });

  it("settles a change order, retrying at a lower price after a rejection", async () => {
    // Seed 3 draws a government change order; the scripted PM asks $12,000, then 25% less each try.
    const r = await runJobChain(opts(3, { forceAward: true }));
    const co = r.resolutions.find((x) => x.problemId === "change-order")!;
    expect(co.changeOrder?.priceUsd).toBeLessThanOrEqual(STUB_CHANGE_ORDER_USD);
    const decided = r.events.filter((e) => e.type === "change_order_decided" && e.payload.problem === "change-order");
    expect(decided.at(-1)?.payload).toMatchObject({ accepted: true });
  });

  it("falls back to the slowest option, or a dispute, when the PM does not decide", async () => {
    const router = patched((r) => (has(r, "resolve_problem") || has(r, "price_change_order") ? textResponse("Let me think.") : undefined));
    const r = await runJobChain(opts(3, { router, forceAward: true }));
    expect(r.outcome).toBe("completed");
    for (const x of r.resolutions) {
      if (x.choice === "disputed") expect(x.changeOrder).toBeNull();
      else expect(x.choice).toMatch(/^none \(/);
    }
    expect(r.events.filter((e) => e.type === "problem_unresolved")).toHaveLength(r.siteProblems.length);
  });

  it("ends when the owner will not sign the contract or the subcontracts", async () => {
    const noContract: Approver = async (q) => ({ approve: q.gate !== "sign_contract", reason: "no" });
    expect(await runJobChain(opts(1, { approver: noContract }))).toMatchObject({ outcome: "owner_declined", reason: "The owner did not sign the prime contract.", account: null });
    const noSubs: Approver = async (q) => ({ approve: q.gate !== "sign_commitment", reason: "no" });
    expect(await runJobChain(opts(1, { approver: noSubs }))).toMatchObject({ outcome: "owner_declined", reason: "The owner did not sign the subcontracts." });
  });

  it("is incomplete when the PM skips kickoff steps", async () => {
    const skip = patched((r) => (has(r, "sign_prime_contract") ? textResponse("Later.") : undefined));
    expect(await runJobChain(opts(1, { router: skip }))).toMatchObject({ outcome: "incomplete", reason: "The PM did not get the prime contract signed (task stopped: done)." });
    const half = patched((r) => {
      if (!has(r, "sign_prime_contract")) return undefined;
      return r.messages.length > 1 ? textResponse("Later.") : toolCallsResponse([{ name: "sign_prime_contract", input: {}, id: "k" }]);
    });
    expect(await runJobChain(opts(1, { router: half }))).toMatchObject({ outcome: "incomplete", reason: "The PM did not issue the subcontracts (task stopped: done)." });
  });

  it("is incomplete without a Scheduler or a schedule", async () => {
    const noHire = patched((r) => {
      const first = r.messages[0]?.content[0];
      return has(r, "propose_hire") && first?.type === "text" && first.text.includes("Scheduler") ? textResponse("No.") : undefined;
    });
    expect(await runJobChain(opts(1, { router: noHire }))).toMatchObject({ outcome: "incomplete", reason: "HR did not hire a Scheduler (task stopped: done)." });
    const noPlan = patched((r) => (has(r, "set_schedule") ? textResponse("No.") : undefined));
    expect(await runJobChain(opts(1, { router: noPlan }))).toMatchObject({ outcome: "incomplete", reason: "The Scheduler set no schedule (task stopped: done)." });
  });

  it("carries a stopped bid stage through unchanged", async () => {
    const router = patched((r) => (has(r, "decide_opportunity") && r.messages.length === 1
      ? toolCallsResponse([{ name: "decide_opportunity", input: { decision: "no_bid", rationale: "Not for us this month." }, id: "d" }])
      : undefined));
    expect(await runJobChain(opts(1, { router, forceAward: true }))).toMatchObject({ outcome: "no_bid", awardForced: false });
  });
});
