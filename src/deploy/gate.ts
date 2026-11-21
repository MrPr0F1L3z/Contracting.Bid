import type { Db } from "../db/db.js";

/**
 * What counts as a run "without human intervention", for the promotion gate.
 *  - no-owner-decisions: every approval was automatic (the run used --auto-approve,
 *    or each gate was one the owner ruled automatic). Any owner click disqualifies it.
 *  - approvals-only: the owner may have clicked Approve, but rejected nothing and
 *    never approved only part of a batch.
 */
export const UNATTENDED_RULES = ["no-owner-decisions", "approvals-only"] as const;
export type UnattendedRule = (typeof UNATTENDED_RULES)[number];
export const DEFAULT_UNATTENDED_RULE: UnattendedRule = "no-owner-decisions";

/** The runs a promotion needs on staging, unless PROMOTE_MIN_RUNS says otherwise. */
export const DEFAULT_MIN_UNATTENDED_RUNS = 10;

export interface GateRun {
  runId: string;
  command: string | null;
  outcome: string | null;
  modelConfig: Record<string, unknown>;
  approvals: Array<{ status: string; autoApproved: boolean; items: unknown[] | null; approvedItems: unknown[] | null }>;
}

/** Why a run does not count, or null when it does. */
export function disqualification(run: GateRun, rule: UnattendedRule): string | null {
  if (run.command !== "closeout") return "not a full closeout run";
  if (run.outcome !== "closed") return `ended ${run.outcome ?? "unfinished"}, not closed`;
  if (run.modelConfig.stub === true) return "used scripted models";
  if (rule === "no-owner-decisions") {
    if (run.modelConfig.autoApprove === true) return null;
    return run.approvals.every((a) => a.autoApproved) ? null : "the owner decided an approval";
  }
  if (run.approvals.some((a) => a.status === "rejected")) return "the owner rejected an approval";
  const partial = run.approvals.some((a) => a.items && a.approvedItems && a.approvedItems.length < a.items.length);
  return partial ? "the owner approved only part of a batch" : null;
}

/** Reads the closeout runs in a database, newest first, with their approvals. */
export async function gateRuns(db: Db): Promise<GateRun[]> {
  const runs = await db.query<{ id: string; command: string | null; outcome: string | null; model_config: unknown }>(
    "SELECT id, command, outcome, model_config FROM runs WHERE command = 'closeout' ORDER BY started_at DESC, id DESC",
  );
  if (runs.rows.length === 0) return [];
  const approvals = await db.query<{ run_id: string; status: string; auto_approved: boolean; items: unknown; approved_items: unknown }>(
    "SELECT run_id, status, auto_approved, items, approved_items FROM approvals WHERE run_id = ANY($1::text[])",
    [runs.rows.map((r) => r.id)],
  );
  const json = (v: unknown): unknown => (typeof v === "string" ? JSON.parse(v) : v);
  return runs.rows.map((r) => ({
    runId: r.id,
    command: r.command,
    outcome: r.outcome,
    modelConfig: (json(r.model_config) as Record<string, unknown> | null) ?? {},
    approvals: approvals.rows
      .filter((a) => a.run_id === r.id)
      .map((a) => ({ status: a.status, autoApproved: a.auto_approved, items: (json(a.items) as unknown[] | null) ?? null, approvedItems: (json(a.approved_items) as unknown[] | null) ?? null })),
  }));
}

export interface GateResult {
  counted: number;
  needed: number;
  passed: boolean;
  /** The runs that counted, newest first. */
  runIds: string[];
}

/** Counts the runs that qualify against the number a promotion needs. */
export function evaluateGate(runs: readonly GateRun[], rule: UnattendedRule, needed: number): GateResult {
  const ok = runs.filter((r) => disqualification(r, rule) === null).map((r) => r.runId);
  return { counted: ok.length, needed, passed: ok.length >= needed, runIds: ok };
}

/** PROMOTE_MIN_RUNS, or the default of 10. Zero is allowed (for a pipeline test), negatives are not. */
export function minUnattendedRuns(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_MIN_UNATTENDED_RUNS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`PROMOTE_MIN_RUNS must be a whole number of 0 or more, got "${raw}"`);
  return n;
}

/** PROMOTE_RUN_RULE, or the default rule. */
export function unattendedRule(raw: string | undefined): UnattendedRule {
  if (raw === undefined || raw.trim() === "") return DEFAULT_UNATTENDED_RULE;
  if (!(UNATTENDED_RULES as readonly string[]).includes(raw)) throw new Error(`PROMOTE_RUN_RULE must be ${UNATTENDED_RULES.join(" or ")}, got "${raw}"`);
  return raw as UnattendedRule;
}
