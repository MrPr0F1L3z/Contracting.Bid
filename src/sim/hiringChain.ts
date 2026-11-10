import { ApprovalQueue, type ApprovalRequest } from "../approvals/approvals.js";
import { listStaffTool, proposeHireTool, type Approver, type HiringContext } from "../agents/hiringTools.js";
import { runAgentTask, type TaskResult } from "../agents/loop.js";
import { AgentRegistry, type AgentRecord } from "../agents/registry.js";
import { Budget } from "../budget/budget.js";
import type { Role } from "../config/roles.js";
import { InMemoryEventLog, type EventLog, type LoggedEvent } from "../events/eventLog.js";
import type { ModelRouter } from "../models/router.js";

export const PRESIDENT_SYSTEM = `You are the President of a general contracting company run entirely by AI agents. \
The company bids on federal construction jobs and subcontracts all field work. You report to the human owner, \
who is legally accountable for the company. You have no staff yet.

Your first task is to hire an HR representative, who will run the hiring pipeline for every other role. \
Use the propose_hire tool once, with clear standing instructions for HR. When the hire is active, reply with a \
one-paragraph summary of what you asked HR to do.`;

export const HR_SYSTEM = `You are the HR representative of a general contracting company run entirely by AI agents. \
You run the hiring pipeline: for each role the company needs, you write the role's standing instructions and \
propose the hire with the propose_hire tool. The company subcontracts all field work, so roles are office roles: \
project manager, estimator, procurement, scheduler and bookkeeper.

Your first hire is a Project Manager, who reports to the President and runs awarded jobs from kickoff to closeout. \
Hire only the Project Manager in this task. When the hire is active, reply with a one-paragraph summary.`;

export interface HiringChainOptions {
  runId: string;
  seed: number;
  router: ModelRouter;
  /** Decides any hire that is not one of the automatic initial hires. */
  approver: Approver;
  runBudgetUsd: number;
  maxAgentBudgetUsd?: number;
  log?: EventLog;
  maxStepsPerTask?: number;
  /** Which model profile the router uses, recorded in the report. */
  profile?: string;
  wallClock?: () => number;
}

export interface HiringReport {
  runId: string;
  seed: number;
  profile: string;
  /** Wall-clock time for the whole run, in milliseconds. */
  durationMs: number;
  outcome: "complete" | "incomplete";
  reason: string;
  agents: AgentRecord[];
  approvals: ApprovalRequest[];
  tasks: Array<{ actor: string; role: Role; model: string } & TaskResult>;
  spentUsd: number;
  eventCount: number;
  /** Every event in the run, so a report shows each model and tool call. */
  events: LoggedEvent[];
}

/**
 * The President's written request to HR. HR's instructions require one before
 * any hire; without it, the local model claimed in its first real run
 * (2026-11-10) that a written approval existed when none had been given.
 */
export function pmRequestFromPresident(presidentId: number, budgetUsd: number): string {
  return [
    `Written request from the President (agent #${presidentId}):`,
    "Hire a Project Manager now.",
    "Business need: before we bid, someone must be ready to run each awarded job from kickoff to closeout.",
    `Approved budget: up to $${budgetUsd}.`,
  ].join("\n");
}

/** Builds an agent's system prompt: its role brief plus the instructions its hiring manager wrote. */
export function systemFor(base: string, agent: AgentRecord): string {
  return `${base}\n\nStanding instructions from your hiring manager:\n${agent.instructions}`;
}

/**
 * Slice 1 of the POC: the owner appoints the President, the President hires
 * HR, and HR hires the Project Manager. Both hires are automatic by the
 * owner's rule; any other hire an agent proposes goes to `approver`.
 */
export async function runHiringChain(o: HiringChainOptions): Promise<HiringReport> {
  const log = o.log ?? new InMemoryEventLog();
  const registry = new AgentRegistry();
  const approvals = new ApprovalQueue();
  const runBudget = new Budget(o.runBudgetUsd);
  const ctx: HiringContext = {
    runId: o.runId,
    registry,
    approvals,
    approver: o.approver,
    log,
    maxAgentBudgetUsd: o.maxAgentBudgetUsd ?? 2,
  };
  const tasks: HiringReport["tasks"] = [];
  const wall = o.wallClock ?? (() => performance.now());
  const started = wall();
  log.append({ runId: o.runId, type: "run_started", actor: "owner", simTime: 0, payload: { seed: o.seed, slice: "hiring" } });

  const president = registry.appointPresident(
    "Lead the company toward winning and delivering its first federal construction job.",
    Math.min(ctx.maxAgentBudgetUsd, o.runBudgetUsd),
  );
  log.append({ runId: o.runId, type: "agent_hired", actor: "owner", simTime: 0, payload: { agentId: president.id, role: "president", managerId: null } });

  const step = async (agent: AgentRecord, system: string, task: string) => {
    const provider = o.router.providerFor(agent.role);
    const actor = `${agent.role}#${agent.id}`;
    const result = await runAgentTask({
      runId: o.runId,
      actor,
      provider,
      system,
      task,
      tools: [proposeHireTool(agent.id, ctx), listStaffTool(registry)],
      runBudget,
      agentBudget: new Budget(agent.budgetUsd),
      log,
      wallClock: wall,
      ...(o.maxStepsPerTask !== undefined ? { maxSteps: o.maxStepsPerTask } : {}),
    });
    tasks.push({ actor, role: agent.role, model: provider.model, ...result });
    return result;
  };

  const finish = (outcome: HiringReport["outcome"], reason: string): HiringReport => {
    log.append({ runId: o.runId, type: "run_finished", actor: "owner", simTime: 0, payload: { outcome, reason, spentUsd: runBudget.spentUsd() } });
    return {
      runId: o.runId,
      seed: o.seed,
      profile: o.profile ?? "custom",
      durationMs: wall() - started,
      outcome,
      reason,
      agents: registry.all(),
      approvals: approvals.all(),
      tasks,
      spentUsd: runBudget.spentUsd(),
      eventCount: log.list({ runId: o.runId }).length,
      events: log.list({ runId: o.runId }),
    };
  };

  const presidentResult = await step(president, PRESIDENT_SYSTEM, "Hire the company's HR representative now.");
  const hr = registry.byRole("hr");
  if (!hr) return finish("incomplete", `The President did not hire HR (task stopped: ${presidentResult.stop}).`);

  const hrResult = await step(hr, systemFor(HR_SYSTEM, hr), pmRequestFromPresident(president.id, ctx.maxAgentBudgetUsd));
  if (!registry.byRole("project_manager")) {
    return finish("incomplete", `HR did not hire a Project Manager (task stopped: ${hrResult.stop}).`);
  }
  return finish("complete", "The President hired HR and HR hired the Project Manager.");
}
