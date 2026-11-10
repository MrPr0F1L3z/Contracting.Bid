import { describe, expect, it } from "vitest";
import { ApprovalQueue } from "../src/approvals/approvals.js";
import { INITIAL_HIRE_REASON, listStaffTool, parseHireInput, proposeHireTool, type Approver, type HiringContext } from "../src/agents/hiringTools.js";
import { AgentRegistry } from "../src/agents/registry.js";
import { InMemoryEventLog } from "../src/events/eventLog.js";

const INSTR = "Run the hiring pipeline for every office role.";

function setup(approver: Approver = async () => ({ approve: true })) {
  const registry = new AgentRegistry();
  const ctx: HiringContext = {
    runId: "r1", registry, approvals: new ApprovalQueue(), approver, log: new InMemoryEventLog(), maxAgentBudgetUsd: 2,
  };
  const president = registry.appointPresident("Lead.", 2);
  return { ctx, registry, president };
}

describe("parseHireInput", () => {
  it("accepts valid input", () => {
    expect(parseHireInput({ role: "hr", instructions: INSTR, budget_usd: 1, justification: "why" }, 2)).toEqual({
      role: "hr", instructions: INSTR, budgetUsd: 1, justification: "why",
    });
    expect(parseHireInput({ role: "hr", instructions: INSTR, budget_usd: 1 }, 2)).toMatchObject({ justification: "" });
  });
  it("rejects a bad role, short or long instructions, and an out-of-range budget", () => {
    expect(parseHireInput({ role: "ceo", instructions: INSTR, budget_usd: 1 }, 2)).toHaveProperty("error");
    expect(parseHireInput({ role: "hr", instructions: "too short", budget_usd: 1 }, 2)).toHaveProperty("error");
    expect(parseHireInput({ role: "hr", instructions: "x".repeat(4001), budget_usd: 1 }, 2)).toHaveProperty("error");
    expect(parseHireInput({ role: "hr", instructions: INSTR, budget_usd: 3 }, 2)).toHaveProperty("error");
    expect(parseHireInput({ role: "hr", instructions: INSTR, budget_usd: "1" }, 2)).toHaveProperty("error");
    expect(parseHireInput({ role: "hr", instructions: INSTR, budget_usd: 0 }, 2)).toHaveProperty("error");
  });
});

describe("proposeHireTool", () => {
  it("hires the initial roles automatically, without asking the owner", async () => {
    let asked = 0;
    const { ctx, registry, president } = setup(async () => { asked++; return { approve: false }; });
    const res = await proposeHireTool(president.id, ctx).handle({ role: "hr", instructions: INSTR, budget_usd: 0.5, justification: "HR" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toMatch(/hr is now active as agent #2 \(initial hire/);
    const hr = registry.byRole("hr")!;
    const pm = await proposeHireTool(hr.id, ctx).handle({ role: "project_manager", instructions: INSTR, budget_usd: 1 });
    expect(pm.content).toMatch(/project_manager is now active/);
    expect(asked).toBe(0);
    expect(ctx.approvals.all().map((a) => [a.status, a.autoApproved, a.reason])).toEqual([
      ["approved", true, INITIAL_HIRE_REASON],
      ["approved", true, INITIAL_HIRE_REASON],
    ]);
    expect(ctx.log.list({ type: "agent_hired" }).map((e) => e.payload.role)).toEqual(["hr", "project_manager"]);
  });

  it("asks the owner about later hires and applies the answer", async () => {
    const answers = [{ approve: false, reason: "Not yet" }, { approve: true }];
    const { ctx, registry, president } = setup(async () => answers.shift()!);
    await proposeHireTool(president.id, ctx).handle({ role: "hr", instructions: INSTR, budget_usd: 0.5 });
    const hr = registry.byRole("hr")!;
    await proposeHireTool(hr.id, ctx).handle({ role: "project_manager", instructions: INSTR, budget_usd: 1 });
    const tool = proposeHireTool(hr.id, ctx);
    const rejected = await tool.handle({ role: "bookkeeper", instructions: INSTR, budget_usd: 1 });
    expect(rejected).toEqual({ content: "The owner rejected this hire: Not yet. You may revise the proposal and try again.", isError: true });
    const approved = await tool.handle({ role: "bookkeeper", instructions: INSTR, budget_usd: 1 });
    expect(approved.content).toBe("Hired: bookkeeper is now active as agent #5.");
    const [, , first, second] = ctx.approvals.all();
    expect(first).toMatchObject({ status: "rejected", decidedBy: "owner", reason: "Not yet", autoApproved: false });
    expect(second).toMatchObject({ status: "approved", decidedBy: "owner" });
    expect(ctx.log.list({ type: "hire_rejected" })).toHaveLength(1);
  });

  it("returns an error result for bad input or a hire the policy forbids", async () => {
    const { ctx, president } = setup();
    const tool = proposeHireTool(president.id, ctx);
    expect(await tool.handle({ role: "hr", instructions: "short", budget_usd: 1 })).toMatchObject({ isError: true });
    expect(await tool.handle({ role: "estimator", instructions: INSTR, budget_usd: 1 })).toMatchObject({ isError: true, content: expect.stringMatching(/HR runs hiring/) });
    expect(await proposeHireTool(42, ctx).handle({ role: "hr", instructions: INSTR, budget_usd: 1 })).toEqual({ content: "Agent 42 not found", isError: true });
    expect(ctx.approvals.all()).toHaveLength(0);
  });

  it("describes its input with a strict schema", () => {
    const { ctx, president } = setup();
    const def = proposeHireTool(president.id, ctx).definition;
    expect(def.name).toBe("propose_hire");
    expect(def.inputSchema).toMatchObject({ required: ["role", "instructions", "budget_usd", "justification"], additionalProperties: false });
  });
});

describe("listStaffTool", () => {
  it("lists agents, or says there are none", async () => {
    expect((await listStaffTool(new AgentRegistry()).handle({})).content).toBe("No agents yet.");
    const { ctx, registry, president } = setup();
    await proposeHireTool(president.id, ctx).handle({ role: "hr", instructions: INSTR, budget_usd: 0.5 });
    expect((await listStaffTool(registry).handle({})).content).toBe(
      "#1 president: active, reports to owner, budget $2\n#2 hr: active, reports to #1, budget $0.5",
    );
  });
});
