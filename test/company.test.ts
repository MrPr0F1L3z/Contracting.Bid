import { describe, expect, it } from "vitest";
import { Company, hireRequestFromPresident } from "../src/sim/company.js";
import { ModelRouter } from "../src/models/router.js";
import { ScriptedProvider, textResponse } from "../src/models/stub.js";

const company = (approver = async () => ({ approve: true }), claude = new ScriptedProvider([])) => {
  let t = 0;
  return new Company({
    runId: "run-x",
    seed: 3,
    router: new ModelRouter({ claude, local: new ScriptedProvider([]) }),
    approver,
    runBudgetUsd: 1.5,
    wallClock: () => (t += 10),
  });
};

describe("hireRequestFromPresident", () => {
  it("joins several roles and names the need and budget", () => {
    expect(hireRequestFromPresident(4, ["an Estimator", "a Procurement agent"], "bidding.", 1)).toBe(
      "Written request from the President (agent #4):\nHire an Estimator and a Procurement agent now, and no other roles.\nBusiness need: bidding.\nApproved budget: up to $1 per hire.\nThis request is my approval of these hires and their plan. Submit them now with propose_hire; do not send me a plan to approve first.",
    );
  });
});

describe("Company", () => {
  it("logs events under its run id", () => {
    const c = company();
    c.event("thing", "owner", { a: 1 });
    c.event("other", "world");
    expect(c.log.list().map((e) => [e.runId, e.type, e.actor, e.payload])).toEqual([
      ["run-x", "thing", "owner", { a: 1 }],
      ["run-x", "other", "world", {}],
    ]);
  });

  it("appoints the President with a budget capped by the run budget, and staff() finds active roles", () => {
    const c = company();
    const p = c.appointPresident();
    expect(p).toMatchObject({ role: "president", status: "active", budgetUsd: 1.5 });
    expect(c.staff("president").id).toBe(p.id);
    expect(() => c.staff("hr")).toThrow("No active hr");
    expect(c.log.list()[0]).toMatchObject({ type: "agent_hired", payload: { role: "president" } });
  });

  it("asks the owner through a gate and records the decision", async () => {
    const c = company(async () => ({ approve: false, reason: "no" }));
    const req = await c.askOwner({ gate: "submit_bid", requestedBy: "project_manager#3", summary: "Bid", amountUsd: 10 });
    expect(req).toMatchObject({ gate: "submit_bid", status: "rejected", decidedBy: "owner", reason: "no", amountUsd: 10 });
    expect(c.log.list().map((e) => e.type)).toEqual(["approval_requested", "approval_decided"]);
    expect(c.log.list()[1]?.payload).toMatchObject({ status: "rejected", reason: "no" });
  });

  it("records which dashboard user decided", async () => {
    const c = company(async () => ({ approve: true, by: "partner" }));
    const req = await c.askOwner({ gate: "submit_bid", requestedBy: "project_manager#3", summary: "Bid", amountUsd: 10 });
    expect(req).toMatchObject({ status: "approved", decidedBy: "owner:partner" });
    expect(c.log.list()[1]).toMatchObject({ type: "approval_decided", actor: "owner:partner" });
  });

  it("runs a task on the role's model and records it", async () => {
    const c = company(undefined, new ScriptedProvider([textResponse("hi", "m")], "m"));
    const p = c.appointPresident();
    const r = await c.runTask(p, "sys", "task", []);
    expect(r.stop).toBe("done");
    expect(c.tasks).toEqual([expect.objectContaining({ actor: "president#1", role: "president", model: "m", stop: "done", steps: 1 })]);
  });

  it("builds the shared report fields", () => {
    const c = company();
    c.appointPresident();
    const r = c.baseReport();
    expect(r).toMatchObject({ runId: "run-x", seed: 3, profile: "custom", spentUsd: 0, eventCount: 1, durationMs: 10 });
    expect(r.agents).toHaveLength(1);
    expect(r.events).toEqual(c.log.list());
  });
});
