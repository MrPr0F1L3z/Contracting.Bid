import { ApprovalQueue, type ApprovalRequest, type Gate } from "../approvals/approvals.js";
import { listStaffTool, proposeHireTool, type ApprovalDecision, type Approver, type HiringContext } from "../agents/hiringTools.js";
import { runAgentTask, type TaskResult, type ToolHandler } from "../agents/loop.js";
import { AgentRegistry, type AgentRecord } from "../agents/registry.js";
import { Budget } from "../budget/budget.js";
import type { Role } from "../config/roles.js";
import { InMemoryEventLog, type EventLog, type LoggedEvent } from "../events/eventLog.js";
import type { ModelRouter } from "../models/router.js";

export const PRESIDENT_SYSTEM = `You are the President of a general contracting company run entirely by AI agents. \
The company bids on federal construction jobs and subcontracts all field work. You report to the human owner, \
who is legally accountable for the company and approves anything that commits money or a legal obligation.`;

export const HR_SYSTEM = `You are the HR representative of a general contracting company run entirely by AI agents. \
You run the hiring pipeline: for each role the company needs, you write the role's standing instructions and \
propose the hire with the propose_hire tool. The company subcontracts all field work, so roles are office roles: \
project manager, estimator, procurement, scheduler and bookkeeper. Hire only the roles a written request asks for.`;

export interface CompanyOptions {
  runId: string;
  seed: number;
  router: ModelRouter;
  /** Decides every owner gate that is not automatic (hires after the first two, pursue, bids...). */
  approver: Approver;
  runBudgetUsd: number;
  maxAgentBudgetUsd?: number;
  log?: EventLog;
  maxStepsPerTask?: number;
  /** Which model profile the router uses, recorded in the report. */
  profile?: string;
  wallClock?: () => number;
}

export type TaskRecord = { actor: string; role: Role; model: string } & TaskResult;

/** The parts of a run report every slice shares. */
export interface BaseReport {
  runId: string;
  seed: number;
  profile: string;
  /** Wall-clock time for the whole run, in milliseconds. */
  durationMs: number;
  agents: AgentRecord[];
  approvals: ApprovalRequest[];
  tasks: TaskRecord[];
  spentUsd: number;
  eventCount: number;
  /** Every event in the run, so a report shows each model and tool call. */
  events: LoggedEvent[];
}

/** Builds an agent's system prompt: its role brief plus the instructions its hiring manager wrote. */
export function systemFor(base: string, agent: AgentRecord): string {
  return `${base}\n\nStanding instructions from your hiring manager:\n${agent.instructions}`;
}

/**
 * The President's written request to HR. HR's instructions require one before
 * any hire; without it, the local model claimed in its first real run
 * (2026-11-10) that a written approval existed when none had been given.
 */
export function hireRequestFromPresident(presidentId: number, roles: string[], need: string, budgetUsd: number): string {
  return [
    `Written request from the President (agent #${presidentId}):`,
    `Hire ${roles.join(" and ")} now, and no other roles.`,
    `Business need: ${need}`,
    `Approved budget: up to $${budgetUsd} per hire.`,
  ].join("\n");
}

/** The written request for the first hire after HR: a Project Manager. */
export function pmRequestFromPresident(presidentId: number, budgetUsd: number): string {
  return hireRequestFromPresident(
    presidentId,
    ["a Project Manager"],
    "before we bid, someone must be ready to run each awarded job from kickoff to closeout.",
    budgetUsd,
  );
}

/**
 * One simulated company for one run: its agents, approvals, budget, event log
 * and the tasks its agents have run. Each slice drives a Company through its
 * part of the job lifecycle.
 */
export class Company {
  readonly log: EventLog;
  readonly registry = new AgentRegistry();
  readonly approvals = new ApprovalQueue();
  readonly runBudget: Budget;
  readonly hiring: HiringContext;
  readonly tasks: TaskRecord[] = [];
  private readonly wall: () => number;
  private readonly started: number;

  constructor(readonly o: CompanyOptions) {
    this.log = o.log ?? new InMemoryEventLog();
    this.runBudget = new Budget(o.runBudgetUsd);
    this.hiring = {
      runId: o.runId,
      registry: this.registry,
      approvals: this.approvals,
      approver: o.approver,
      log: this.log,
      maxAgentBudgetUsd: o.maxAgentBudgetUsd ?? 2,
    };
    this.wall = o.wallClock ?? (() => performance.now());
    this.started = this.wall();
  }

  event(type: string, actor: string, payload: Record<string, unknown> = {}): void {
    this.log.append({ runId: this.o.runId, type, actor, simTime: 0, payload });
  }

  /** The owner appoints the President. */
  appointPresident(): AgentRecord {
    const president = this.registry.appointPresident(
      "Lead the company toward winning and delivering its first federal construction job.",
      Math.min(this.hiring.maxAgentBudgetUsd, this.o.runBudgetUsd),
    );
    this.event("agent_hired", "owner", { agentId: president.id, role: "president", managerId: null });
    return president;
  }

  /** The active agent in a role; throws when the role is not staffed. */
  staff(role: Role): AgentRecord {
    const agent = this.registry.byRole(role);
    if (!agent) throw new Error(`No active ${role}`);
    return agent;
  }

  hiringTools(agent: AgentRecord): ToolHandler[] {
    return [proposeHireTool(agent.id, this.hiring), listStaffTool(this.registry)];
  }

  /**
   * Puts a decision in front of the owner through a gate and records it.
   * Returns the decided request.
   */
  async askOwner(input: { gate: Gate; requestedBy: string; summary: string; amountUsd?: number }): Promise<ApprovalRequest> {
    const request = this.approvals.request(input);
    this.event("approval_requested", input.requestedBy, { approvalId: request.id, gate: input.gate, summary: input.summary });
    if (request.status !== "pending") return request;
    const decision: ApprovalDecision = await this.o.approver(request);
    const decided = this.approvals.decide(request.id, decision.approve, "owner", decision.reason);
    this.event("approval_decided", "owner", { approvalId: decided.id, gate: decided.gate, status: decided.status, reason: decided.reason ?? null });
    return decided;
  }

  /** Runs one agent task with the company's budgets and log. */
  async runTask(agent: AgentRecord, system: string, task: string, tools: ToolHandler[], maxSteps?: number): Promise<TaskResult> {
    const provider = this.o.router.providerFor(agent.role);
    const actor = `${agent.role}#${agent.id}`;
    const steps = maxSteps ?? this.o.maxStepsPerTask;
    const result = await runAgentTask({
      runId: this.o.runId,
      actor,
      provider,
      system,
      task,
      tools,
      runBudget: this.runBudget,
      agentBudget: new Budget(agent.budgetUsd),
      log: this.log,
      wallClock: this.wall,
      ...(steps !== undefined ? { maxSteps: steps } : {}),
    });
    this.tasks.push({ actor, role: agent.role, model: provider.model, ...result });
    return result;
  }

  /** Report fields shared by every slice. Call last: it captures the duration and events so far. */
  baseReport(): BaseReport {
    return {
      runId: this.o.runId,
      seed: this.o.seed,
      profile: this.o.profile ?? "custom",
      durationMs: this.wall() - this.started,
      agents: this.registry.all(),
      approvals: this.approvals.all(),
      tasks: this.tasks,
      spentUsd: this.runBudget.spentUsd(),
      eventCount: this.log.list({ runId: this.o.runId }).length,
      events: this.log.list({ runId: this.o.runId }),
    };
  }
}

/**
 * Slice 1: the President hires HR, then HR hires the Project Manager. Both
 * hires are automatic by the owner's rule. Returns why it stopped short, if it did.
 */
export async function hireInitialStaff(c: Company, president: AgentRecord): Promise<{ ok: true } | { ok: false; reason: string }> {
  const presidentResult = await c.runTask(
    president,
    `${PRESIDENT_SYSTEM}\n\nYou have no staff yet. Hire an HR representative, who will run hiring for every other role. \
Use the propose_hire tool once, with clear standing instructions for HR. When the hire is active, reply with a \
one-paragraph summary of what you asked HR to do.`,
    "Hire the company's HR representative now.",
    c.hiringTools(president),
  );
  const hr = c.registry.byRole("hr");
  if (!hr) return { ok: false, reason: `The President did not hire HR (task stopped: ${presidentResult.stop}).` };

  const hrResult = await c.runTask(hr, systemFor(HR_SYSTEM, hr), pmRequestFromPresident(president.id, c.hiring.maxAgentBudgetUsd), c.hiringTools(hr));
  if (!c.registry.byRole("project_manager")) {
    return { ok: false, reason: `HR did not hire a Project Manager (task stopped: ${hrResult.stop}).` };
  }
  return { ok: true };
}
