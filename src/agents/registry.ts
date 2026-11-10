import { REPORTS_TO, type Role } from "../config/roles.js";

export type AgentStatus = "pending_approval" | "active" | "rejected";

/** An agent "hire": a role with instructions, a budget and a manager. */
export interface AgentRecord {
  id: number;
  role: Role;
  instructions: string;
  budgetUsd: number;
  /** The agent this one reports to; null for the President (reports to the owner). */
  managerId: number | null;
  /** The agent that proposed this hire; null for the President. */
  hiredById: number | null;
  status: AgentStatus;
  approvalId?: number;
}

/**
 * The hires the owner made automatic (2026-11-10): the President hires HR,
 * then HR hires the Project Manager. Every later hire needs owner approval.
 */
export const INITIAL_HIRES: ReadonlyArray<readonly [hirer: Role, role: Role]> = [
  ["president", "hr"],
  ["hr", "project_manager"],
];

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * Who may hire whom. The President hires HR; HR runs the hiring pipeline for
 * every other role. Nobody hires a President, and other roles do not hire.
 */
export function hirePolicy(hirer: Role, role: Role): PolicyDecision {
  if (role === "president") return { allowed: false, reason: "The company has one President, appointed by the owner." };
  if (hirer === "president") {
    return role === "hr"
      ? { allowed: true }
      : { allowed: false, reason: "The President hires HR; HR runs hiring for every other role." };
  }
  if (hirer === "hr") {
    return role === "hr" ? { allowed: false, reason: "HR cannot hire another HR rep." } : { allowed: true };
  }
  return { allowed: false, reason: `The ${hirer} role cannot hire.` };
}

/** True when this hire is one of the owner's automatic initial hires. */
export function isInitialHire(hirer: Role, role: Role): boolean {
  return INITIAL_HIRES.some(([h, r]) => h === hirer && r === role);
}

/**
 * In-memory agent records for one run. The POC has at most one agent per
 * role, so a role with an active or pending agent cannot be hired again.
 */
export class AgentRegistry {
  private readonly agents: AgentRecord[] = [];

  /** Creates the President, appointed by the owner. Allowed once. */
  appointPresident(instructions: string, budgetUsd: number): AgentRecord {
    if (this.agents.some((a) => a.role === "president")) throw new Error("A President already exists");
    return this.add({ role: "president", instructions, budgetUsd, managerId: null, hiredById: null, status: "active" });
  }

  /** Records a proposed hire as pending approval, after checking the policy. */
  propose(input: { hirerId: number; role: Role; instructions: string; budgetUsd: number }): AgentRecord {
    const hirer = this.get(input.hirerId);
    if (!hirer || hirer.status !== "active") throw new Error(`Agent ${input.hirerId} is not an active agent`);
    const policy = hirePolicy(hirer.role, input.role);
    if (!policy.allowed) throw new Error(policy.reason);
    const existing = this.agents.find((a) => a.role === input.role && a.status !== "rejected");
    if (existing) throw new Error(`A ${input.role} is already ${existing.status === "active" ? "on staff" : "pending approval"} (agent #${existing.id})`);
    if (!(input.budgetUsd > 0)) throw new Error(`Budget must be positive, got ${input.budgetUsd}`);
    if (input.instructions.trim().length === 0) throw new Error("Instructions are required");
    const managerRole = REPORTS_TO[input.role];
    const manager = managerRole === "owner" ? undefined : this.byRole(managerRole);
    if (managerRole !== "owner" && !manager) throw new Error(`A ${input.role} reports to the ${managerRole}, who is not on staff yet`);
    return this.add({
      role: input.role,
      instructions: input.instructions.trim(),
      budgetUsd: input.budgetUsd,
      managerId: manager?.id ?? null,
      hiredById: hirer.id,
      status: "pending_approval",
    });
  }

  activate(id: number, approvalId?: number): AgentRecord {
    return this.settle(id, "active", approvalId);
  }

  reject(id: number, approvalId?: number): AgentRecord {
    return this.settle(id, "rejected", approvalId);
  }

  get(id: number): AgentRecord | undefined {
    const a = this.agents.find((x) => x.id === id);
    return a && { ...a };
  }

  /** The active agent in a role, if any. */
  byRole(role: Role): AgentRecord | undefined {
    const a = this.agents.find((x) => x.role === role && x.status === "active");
    return a && { ...a };
  }

  all(): AgentRecord[] {
    return this.agents.map((a) => ({ ...a }));
  }

  private add(fields: Omit<AgentRecord, "id">): AgentRecord {
    const record: AgentRecord = { id: this.agents.length + 1, ...fields };
    this.agents.push(record);
    return { ...record };
  }

  private settle(id: number, status: "active" | "rejected", approvalId?: number): AgentRecord {
    const a = this.agents.find((x) => x.id === id);
    if (!a) throw new Error(`No agent ${id}`);
    if (a.status !== "pending_approval") throw new Error(`Agent ${id} is ${a.status}, not pending approval`);
    a.status = status;
    if (approvalId !== undefined) a.approvalId = approvalId;
    return { ...a };
  }
}
