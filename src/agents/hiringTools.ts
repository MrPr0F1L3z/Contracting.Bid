import type { ApprovalQueue, ApprovalRequest } from "../approvals/approvals.js";
import { ROLES, isRole, type Role } from "../config/roles.js";
import type { EventLog } from "../events/eventLog.js";
import type { ToolHandler } from "./loop.js";
import { isInitialHire, type AgentRecord, type AgentRegistry } from "./registry.js";

/** The owner's answer on a hire that needs approval. */
export interface ApprovalDecision {
  approve: boolean;
  reason?: string;
  /** For a batch request: approve only these item ids. Left out, an approval covers every item. */
  items?: string[];
}

/** Asks the owner to decide a gated request. The CLI prompts in the terminal; tests answer directly. */
export type Approver = (request: ApprovalRequest) => Promise<ApprovalDecision>;

export interface HiringContext {
  runId: string;
  registry: AgentRegistry;
  approvals: ApprovalQueue;
  approver: Approver;
  log: EventLog;
  /** The most a single hire's budget may be, in US dollars. */
  maxAgentBudgetUsd: number;
  simTime?: () => number;
}

export const INITIAL_HIRE_REASON = "Initial hire: automatic by owner policy (President→HR, HR→PM)";

/** Reads and checks propose_hire input. Returns an error message when it is invalid. */
export function parseHireInput(
  input: Record<string, unknown>,
  maxBudgetUsd: number,
): { role: Role; instructions: string; budgetUsd: number; justification: string } | { error: string } {
  const { role, instructions, budget_usd: budget, justification } = input;
  if (typeof role !== "string" || !isRole(role)) return { error: `role must be one of: ${ROLES.join(", ")}` };
  if (typeof instructions !== "string" || instructions.trim().length < 20) {
    return { error: "instructions must describe the job in at least 20 characters" };
  }
  if (instructions.length > 4000) return { error: "instructions must be 4000 characters or fewer" };
  if (typeof budget !== "number" || !(budget > 0) || budget > maxBudgetUsd) {
    return { error: `budget_usd must be a number above 0 and at most ${maxBudgetUsd}` };
  }
  return { role, instructions, budgetUsd: budget, justification: typeof justification === "string" ? justification : "" };
}

/**
 * propose_hire: creates an agent record. The owner's initial hires go live at
 * once; any other hire waits for the owner's decision.
 */
export function proposeHireTool(hirerId: number, ctx: HiringContext): ToolHandler {
  const now = ctx.simTime ?? (() => 0);
  return {
    definition: {
      name: "propose_hire",
      description:
        "Hire an agent into a role. Write the instructions the new agent will work from: its responsibilities, " +
        "who it reports to, what it must escalate, and what it must never do. Returns whether the hire is active.",
      inputSchema: {
        properties: {
          role: { type: "string", enum: [...ROLES], description: "The role to fill." },
          instructions: { type: "string", description: "The new agent's standing instructions (20-4000 characters)." },
          budget_usd: { type: "number", description: `Spending limit for the new agent, at most ${ctx.maxAgentBudgetUsd}.` },
          justification: { type: "string", description: "Why the company needs this hire now." },
        },
        required: ["role", "instructions", "budget_usd", "justification"],
        additionalProperties: false,
      },
    },
    async handle(input) {
      const parsed = parseHireInput(input, ctx.maxAgentBudgetUsd);
      if ("error" in parsed) return { content: parsed.error, isError: true };
      const hirer = ctx.registry.get(hirerId);
      if (!hirer) return { content: `Agent ${hirerId} not found`, isError: true };

      let proposal: AgentRecord;
      try {
        proposal = ctx.registry.propose({ hirerId, role: parsed.role, instructions: parsed.instructions, budgetUsd: parsed.budgetUsd });
      } catch (err) {
        return { content: err instanceof Error ? err.message : String(err), isError: true };
      }

      const automatic = isInitialHire(hirer.role, parsed.role);
      const request = ctx.approvals.request({
        gate: "hire_agent",
        requestedBy: `${hirer.role}#${hirer.id}`,
        summary: `Hire ${parsed.role} with a $${parsed.budgetUsd} budget. ${parsed.justification}`.trim(),
        amountUsd: parsed.budgetUsd,
        ...(automatic ? { autoApproveReason: INITIAL_HIRE_REASON } : {}),
      });
      ctx.log.append({
        runId: ctx.runId,
        type: "approval_requested",
        actor: request.requestedBy,
        simTime: now(),
        payload: { approvalId: request.id, gate: request.gate, agentId: proposal.id, role: parsed.role, automatic },
      });

      let approved = request.status === "approved";
      let reason = request.reason;
      if (request.status === "pending") {
        const decision = await ctx.approver(request);
        const decided = ctx.approvals.decide(request.id, decision.approve, "owner", decision.reason);
        approved = decided.status === "approved";
        reason = decided.reason;
      }
      const record = approved ? ctx.registry.activate(proposal.id, request.id) : ctx.registry.reject(proposal.id, request.id);
      ctx.log.append({
        runId: ctx.runId,
        type: approved ? "agent_hired" : "hire_rejected",
        actor: request.requestedBy,
        simTime: now(),
        payload: { approvalId: request.id, agentId: record.id, role: record.role, managerId: record.managerId, budgetUsd: record.budgetUsd, reason: reason ?? null },
      });
      return approved
        ? { content: `Hired: ${record.role} is now active as agent #${record.id}${automatic ? " (initial hire, approved automatically)" : ""}.` }
        : { content: `The owner rejected this hire${reason ? `: ${reason}` : ""}. You may revise the proposal and try again.`, isError: true };
    },
  };
}

/** list_staff: the company's agents and their status. */
export function listStaffTool(registry: AgentRegistry): ToolHandler {
  return {
    definition: {
      name: "list_staff",
      description: "List the company's agents: role, status, manager and budget.",
      inputSchema: { properties: {}, additionalProperties: false },
    },
    async handle() {
      const rows = registry.all().map(
        (a) => `#${a.id} ${a.role}: ${a.status}, reports to ${a.managerId === null ? "owner" : `#${a.managerId}`}, budget $${a.budgetUsd}`,
      );
      return { content: rows.length > 0 ? rows.join("\n") : "No agents yet." };
    },
  };
}
