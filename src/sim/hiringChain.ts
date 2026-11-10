import { ApprovalQueue, type ApprovalRequest } from "../approvals/approvals.js";
import { listStaffTool, proposeHireTool, type Approver, type HiringContext } from "../agents/hiringTools.js";
import { runAgentTask, type TaskResult } from "../agents/loop.js";
import { AgentRegistry, type AgentRecord } from "../agents/registry.js";
import { Budget } from "../budget/budget.js";
import type { Role } from "../config/roles.js";
import { InMemoryEventLog, type EventLog } from "../events/eventLog.js";
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
}

export interface HiringReport {
  runId: string;
  seed: number;
  outcome: "complete" | "incomplete";
  reason: string;
  agents: AgentRecord[];
  approvals: ApprovalRequest[];
  tasks: Array<{ actor: string; role: Role; model: string } & TaskResult>;
  spentUsd: number;
  eventCount: number;
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
      outcome,
      reason,
      agents: registry.all(),
      approvals: approvals.all(),
      tasks,
      spentUsd: runBudget.spentUsd(),
      eventCount: log.list({ runId: o.runId }).length,
    };
  };

  const presidentResult = await step(president, PRESIDENT_SYSTEM, "Hire the company's HR representative now.");
  const hr = registry.byRole("hr");
  if (!hr) return finish("incomplete", `The President did not hire HR (task stopped: ${presidentResult.stop}).`);

  const hrResult = await step(hr, systemFor(HR_SYSTEM, hr), "Hire the company's Project Manager now.");
  if (!registry.byRole("project_manager")) {
    return finish("incomplete", `HR did not hire a Project Manager (task stopped: ${hrResult.stop}).`);
  }
  return finish("complete", "The President hired HR and HR hired the Project Manager.");
}
