import { describe, expect, it } from "vitest";
import { HR_SYSTEM, pmRequestFromPresident, runHiringChain, systemFor } from "../src/sim/hiringChain.js";
import { STUB_HR_INSTRUCTIONS, stubHiringProviders } from "../src/sim/stubHiring.js";
import { ModelRouter } from "../src/models/router.js";
import { ScriptedProvider, textResponse, toolCallResponse } from "../src/models/stub.js";
import { InMemoryEventLog } from "../src/events/eventLog.js";
import type { AgentRecord } from "../src/agents/registry.js";

const never = async () => {
  throw new Error("the initial hires must not ask the owner");
};

describe("runHiringChain (functional, scripted models)", () => {
  it("President hires HR, HR hires the PM, with no owner approval", async () => {
    const providers = stubHiringProviders();
    const log = new InMemoryEventLog();
    const report = await runHiringChain({ runId: "run-1", seed: 42, router: new ModelRouter(providers), approver: never, runBudgetUsd: 5, log });

    expect(report.outcome).toBe("complete");
    expect(report.agents.map((a) => [a.id, a.role, a.status, a.managerId, a.hiredById])).toEqual([
      [1, "president", "active", null, null],
      [2, "hr", "active", 1, 1],
      [3, "project_manager", "active", 1, 2],
    ]);
    expect(report.approvals.every((a) => a.autoApproved && a.status === "approved")).toBe(true);
    expect(report.tasks.map((t) => [t.actor, t.model, t.stop, t.steps])).toEqual([
      ["president#1", "stub-claude", "done", 2],
      ["hr#2", "stub-local", "done", 2],
    ]);
    expect(report.seed).toBe(42);
    expect(report.profile).toBe("custom");
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(report.spentUsd).toBe(0);
    expect(report.eventCount).toBe(log.list().length);
    expect(report.events).toEqual(log.list());
    // HR works from a real written request, not one it has to assume.
    expect(providers.local.requests[0]?.messages[0]?.content[0]).toEqual({ type: "text", text: pmRequestFromPresident(1, 2) });
    expect(log.list()[0]?.type).toBe("run_started");
    expect(log.list().at(-1)).toMatchObject({ type: "run_finished", payload: { outcome: "complete" } });
    // HR works from the instructions the President wrote.
    expect(providers.local.requests[0]?.system).toContain(STUB_HR_INSTRUCTIONS);
    expect(providers.claude.remaining()).toBe(0);
    expect(providers.local.remaining()).toBe(0);
  });

  it("is incomplete when the President never hires HR", async () => {
    const claude = new ScriptedProvider([textResponse("I will think about it.")]);
    const report = await runHiringChain({
      runId: "r", seed: 1, router: new ModelRouter({ claude, local: new ScriptedProvider([]) }), approver: never, runBudgetUsd: 5,
    });
    expect(report).toMatchObject({ outcome: "incomplete", reason: "The President did not hire HR (task stopped: done)." });
    expect(report.agents).toHaveLength(1);
  });

  it("is incomplete when HR does not hire a PM, and lets the President recover from a bad proposal", async () => {
    const claude = new ScriptedProvider([
      toolCallResponse("propose_hire", { role: "estimator", instructions: "Estimate every job we bid on.", budget_usd: 1 }, "a"),
      toolCallResponse("propose_hire", { role: "hr", instructions: "Run the hiring pipeline for the company.", budget_usd: 1 }, "b"),
      textResponse("done"),
    ]);
    const local = new ScriptedProvider([toolCallResponse("list_staff", {}, "c"), toolCallResponse("list_staff", {}, "d")]);
    const report = await runHiringChain({
      runId: "r", seed: 1, router: new ModelRouter({ claude, local }), approver: never, runBudgetUsd: 5, maxStepsPerTask: 2,
    });
    expect(report.agents.map((a) => a.role)).toEqual(["president", "hr"]);
    expect(report).toMatchObject({ outcome: "incomplete", reason: "HR did not hire a Project Manager (task stopped: max_steps)." });
    // The first proposal broke the policy and came back as a tool error.
    expect(claude.requests[1]?.messages.at(-1)?.content[0]).toMatchObject({ type: "tool_result", isError: true });
  });
});

describe("systemFor", () => {
  it("appends the hiring manager's instructions to the role brief", () => {
    const agent = { instructions: "Be brief." } as AgentRecord;
    expect(systemFor(HR_SYSTEM, agent)).toBe(`${HR_SYSTEM}\n\nStanding instructions from your hiring manager:\nBe brief.`);
  });
});

describe("pmRequestFromPresident", () => {
  it("names the President, the need and the approved budget", () => {
    expect(pmRequestFromPresident(1, 2).split("\n")).toEqual([
      "Written request from the President (agent #1):",
      "Hire a Project Manager now, and no other roles.",
      "Business need: before we bid, someone must be ready to run each awarded job from kickoff to closeout.",
      "Approved budget: up to $2 per hire.",
      "This request is my approval of these hires and their plan. Submit them now with propose_hire; do not send me a plan to approve first.",
    ]);
  });
});
