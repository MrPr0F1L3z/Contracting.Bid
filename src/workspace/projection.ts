import type { LoggedEvent } from "../events/eventLog.js";
import type { Gate } from "../approvals/approvals.js";
import type { Opportunity } from "../opportunities/types.js";

/**
 * Turns a run's event log into what the customer workspace shows. The log is
 * the only input, so the same code serves a run in progress (events so far),
 * a finished run, and a replay. Nothing here reads the simulated world's
 * hidden state: the workspace sees only what the company itself knows.
 */

/** The nine lifecycle stages, in the order the workspace shows them. */
export const WORKSPACE_STAGES = ["find", "research", "bid", "award", "subs", "schedule", "bill", "pay", "closeout"] as const;
export type WorkspaceStage = (typeof WORKSPACE_STAGES)[number];

/** Where a job stands overall. `active` covers everything still moving. */
export type JobStatus = "active" | "passed" | "lost" | "closed";

/** The stage each owner gate belongs to. A hire has no stage of its own, so it takes the job's. */
export const GATE_STAGE: Record<Exclude<Gate, "hire_agent">, WorkspaceStage> = {
  pursue_opportunity: "research",
  submit_bid: "bid",
  sign_contract: "award",
  sign_commitment: "subs",
  approve_change_order: "schedule",
  submit_invoice: "bill",
  release_payment: "pay",
  close_project: "closeout",
};

export interface WorkspaceQuote {
  quoteId: string;
  trade: string;
  subcontractor: string;
  priceUsd: number;
  selected: boolean;
}

export interface WorkspaceTask {
  /** Unique across runs: `runId:approvalId`. */
  id: string;
  runId: string;
  approvalId: number;
  gate: Gate;
  stage: WorkspaceStage;
  summary: string;
  requestedBy: string;
}

export interface WorkspaceProblem {
  id: string;
  trade: string | null;
  resolved: boolean;
  choice: string | null;
  costUsd: number;
  days: number;
}

export interface WorkspaceJob {
  runId: string;
  noticeId: string | null;
  title: string | null;
  agency: string | null;
  stage: WorkspaceStage;
  status: JobStatus;
  /** True once the run has logged `run_finished`. */
  finished: boolean;
  estimateUsd: number | null;
  /** Trades the Estimator priced; a trade with no quote yet is a quote still outstanding. */
  trades: string[];
  quotes: WorkspaceQuote[];
  bidUsd: number | null;
  bidStatus: "none" | "submitted" | "won" | "lost";
  contractUsd: number | null;
  contractDays: number | null;
  changeOrdersUsd: number;
  schedule: Array<{ trade: string; startDay: number; days: number }>;
  problems: WorkspaceProblem[];
  /** Committed to subcontractors, plus the cost of problems once the job completes. */
  costUsd: number;
  invoicedUsd: number;
  receivedUsd: number;
  paidOutUsd: number;
  profitUsd: number | null;
  daysLate: number | null;
  /** Owner approvals asked for and not yet answered. */
  tasks: WorkspaceTask[];
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const rec = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** A stage never moves backwards: an event can only advance the job. */
export function laterStage(a: WorkspaceStage, b: WorkspaceStage): WorkspaceStage {
  return WORKSPACE_STAGES.indexOf(b) > WORKSPACE_STAGES.indexOf(a) ? b : a;
}

/** The stage a pending approval is shown under. */
export function stageForGate(gate: Gate, current: WorkspaceStage): WorkspaceStage {
  return gate === "hire_agent" ? current : GATE_STAGE[gate];
}

function emptyJob(runId: string): WorkspaceJob {
  return {
    runId, noticeId: null, title: null, agency: null, stage: "find", status: "active", finished: false,
    estimateUsd: null, trades: [], quotes: [], bidUsd: null, bidStatus: "none",
    contractUsd: null, contractDays: null, changeOrdersUsd: 0, schedule: [], problems: [],
    costUsd: 0, invoicedUsd: 0, receivedUsd: 0, paidOutUsd: 0, profitUsd: null, daysLate: null, tasks: [],
  };
}

/**
 * One run's events, in order, as one job. Events of other runs are ignored,
 * so a mixed log can be passed as it is. `opportunities` only adds what the
 * log does not carry (the agency name).
 */
export function projectJob(runId: string, events: readonly LoggedEvent[], opportunities: readonly Opportunity[] = []): WorkspaceJob {
  const job = emptyJob(runId);
  const pending = new Map<number, { gate: Gate; summary: string; requestedBy: string }>();
  const problem = (id: string, trade: string | null): WorkspaceProblem => {
    let p = job.problems.find((x) => x.id === id);
    if (!p) job.problems.push((p = { id, trade, resolved: false, choice: null, costUsd: 0, days: 0 }));
    return p;
  };
  const advance = (s: WorkspaceStage) => void (job.stage = laterStage(job.stage, s));

  for (const e of events) {
    if (e.runId !== runId) continue;
    const p = e.payload;
    switch (e.type) {
      case "opportunity_found":
        job.noticeId = str(p.noticeId);
        job.title = str(p.title);
        job.agency = opportunities.find((o) => o.noticeId === job.noticeId)?.agency ?? null;
        break;
      case "opportunity_decided":
        if (p.decision !== "pursue" || p.ownerApproved === false) job.status = "passed";
        else if (p.ownerApproved === true) advance("research");
        break;
      case "estimate_submitted":
        job.estimateUsd = num(p.totalUsd);
        job.trades = list(p.lines).map((l) => str(rec(l).trade)).filter((t): t is string => t !== null);
        advance("bid");
        break;
      case "quotes_received":
        for (const raw of list(p.quotes)) {
          const q = rec(raw);
          const quoteId = str(q.quoteId);
          if (!quoteId || job.quotes.some((x) => x.quoteId === quoteId)) continue;
          job.quotes.push({ quoteId, trade: str(q.trade) ?? "", subcontractor: str(q.subcontractor) ?? "", priceUsd: num(q.priceUsd), selected: false });
        }
        advance("bid");
        break;
      case "quote_selected": {
        const trade = str(p.trade);
        for (const q of job.quotes) {
          if (q.trade === trade) q.selected = q.quoteId === p.quoteId;
          // A re-quote changes the price of the quote that was picked.
          if (q.quoteId === p.quoteId) q.priceUsd = num(p.priceUsd);
        }
        break;
      }
      case "bid_submitted":
        job.bidUsd = num(p.priceUsd);
        job.bidStatus = "submitted";
        advance("award");
        break;
      case "award_decided":
        job.bidStatus = p.awarded === true ? "won" : "lost";
        if (p.awarded !== true) job.status = "lost";
        break;
      case "award_forced":
        job.bidStatus = "won";
        job.status = "active";
        break;
      case "contract_signed":
        job.contractUsd = num(p.priceUsd);
        job.contractDays = num(p.contractDays);
        advance("award");
        break;
      case "subcontracts_issued":
        job.costUsd = num(p.totalUsd);
        advance("subs");
        break;
      case "schedule_set":
        job.schedule = list(p.lines).map((l) => ({ trade: str(rec(l).trade) ?? "", startDay: num(rec(l).startDay), days: num(rec(l).days) }));
        advance("schedule");
        break;
      case "problem_injected":
        problem(str(p.problem) ?? "unknown", str(p.trade));
        break;
      case "problem_resolved":
      case "problem_unresolved": {
        const x = problem(str(p.problem) ?? "unknown", str(p.trade));
        x.resolved = e.type === "problem_resolved";
        x.choice = str(p.choice) ?? str(p.option);
        x.costUsd = num(p.costUsd);
        x.days = num(p.days);
        break;
      }
      case "change_order_decided":
        if (p.accepted === true) {
          job.changeOrdersUsd += num(p.priceUsd);
          const x = problem(str(p.problem) ?? "unknown", null);
          x.resolved = true;
          x.choice = "change_order";
          x.days = num(p.days);
        }
        break;
      case "change_disputed": {
        const x = problem(str(p.problem) ?? "unknown", null);
        x.resolved = true;
        x.choice = "disputed";
        break;
      }
      case "job_completed":
        job.costUsd = num(p.costUsd);
        job.changeOrdersUsd = num(p.changeOrderRevenueUsd);
        job.profitUsd = num(p.profitUsd);
        job.daysLate = num(p.daysLate);
        advance("bill");
        break;
      case "invoice_submitted":
        if (p.accepted === true) {
          job.invoicedUsd = num(p.amountUsd);
          advance("pay");
        }
        break;
      case "bills_paid":
        job.paidOutUsd += num(p.totalUsd);
        break;
      case "payment_received":
        job.receivedUsd += num(p.paidUsd);
        advance("closeout");
        break;
      case "project_closed":
        job.receivedUsd = num(p.receivedUsd);
        job.paidOutUsd = num(p.paidOutUsd);
        job.profitUsd = num(p.cashProfitUsd);
        job.status = "closed";
        advance("closeout");
        break;
      case "approval_requested": {
        const id = num(p.approvalId);
        // An automatic hire is never waiting on the owner.
        if (p.automatic !== true) pending.set(id, { gate: p.gate as Gate, summary: str(p.summary) ?? (p.role ? `Hire a ${String(p.role).replace(/_/g, " ")}.` : ""), requestedBy: e.actor });
        break;
      }
      case "approval_decided":
      case "agent_hired":
        if (p.approvalId !== undefined) pending.delete(num(p.approvalId));
        break;
      case "run_finished":
        job.finished = true;
        pending.clear();
        break;
    }
  }
  job.tasks = [...pending].map(([approvalId, t]) => ({
    id: `${runId}:${approvalId}`, runId, approvalId, gate: t.gate, stage: stageForGate(t.gate, job.stage), summary: t.summary, requestedBy: t.requestedBy,
  }));
  return job;
}

/** Every run in a log, as jobs, in the order each run first appears. */
export function projectJobs(events: readonly LoggedEvent[], opportunities: readonly Opportunity[] = []): WorkspaceJob[] {
  const ids = [...new Set(events.map((e) => e.runId))];
  return ids.map((id) => projectJob(id, events, opportunities));
}

/** The counts the workspace's job stats row shows, across jobs. */
export interface WorkspaceStats {
  quotesRequested: number;
  quotesReceived: number;
  quotesOutstanding: number;
  bidsAwaiting: number;
  bidsAwaitingUsd: number;
  awardedJobs: number;
  urgent: number;
}

/**
 * Quotes are counted per trade on jobs still being bid: a trade is requested
 * once it is in the estimate and received once any quote for it is in.
 * Everything waiting on the owner is urgent, because the agents stop there.
 */
export function workspaceStats(jobs: readonly WorkspaceJob[]): WorkspaceStats {
  const s: WorkspaceStats = { quotesRequested: 0, quotesReceived: 0, quotesOutstanding: 0, bidsAwaiting: 0, bidsAwaitingUsd: 0, awardedJobs: 0, urgent: 0 };
  for (const j of jobs) {
    if (j.status === "active" && j.stage === "bid") {
      const received = j.trades.filter((t) => j.quotes.some((q) => q.trade === t)).length;
      s.quotesRequested += j.trades.length;
      s.quotesReceived += received;
    }
    if (j.bidStatus === "submitted") {
      s.bidsAwaiting += 1;
      s.bidsAwaitingUsd += j.bidUsd ?? 0;
    }
    if (j.contractUsd !== null && j.status !== "lost" && j.status !== "passed") s.awardedJobs += 1;
    s.urgent += j.tasks.length;
  }
  s.quotesOutstanding = s.quotesRequested - s.quotesReceived;
  return s;
}
