import type { DashboardUser, UserStore } from "../dashboard/auth.js";
import type { RunSummary } from "../dashboard/server.js";
import { InMemoryEventLog, type EventInput, type EventLog, type LoggedEvent } from "../events/eventLog.js";
import type { Db } from "./db.js";

/** Dashboard logins in the dashboard_users table. */
export class PgUserStore implements UserStore {
  constructor(private readonly db: Db) {}

  private static row(r: Record<string, unknown>): DashboardUser {
    return {
      username: String(r.username),
      passwordHash: String(r.password_hash),
      totpSecret: String(r.totp_secret),
      lastTotpStep: Number(r.last_totp_step),
      createdAt: new Date(r.created_at as string | Date).toISOString(),
    };
  }

  async get(username: string): Promise<DashboardUser | null> {
    const r = await this.db.query("SELECT * FROM dashboard_users WHERE username = $1", [username]);
    return r.rows[0] ? PgUserStore.row(r.rows[0]) : null;
  }
  async list(): Promise<DashboardUser[]> {
    return (await this.db.query("SELECT * FROM dashboard_users ORDER BY username")).rows.map(PgUserStore.row);
  }
  async put(u: DashboardUser): Promise<void> {
    await this.db.query(
      `INSERT INTO dashboard_users (username, password_hash, totp_secret, last_totp_step, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (username) DO UPDATE SET password_hash = $2, totp_secret = $3, last_totp_step = $4`,
      [u.username, u.passwordHash, u.totpSecret, u.lastTotpStep, u.createdAt],
    );
  }
  async remove(username: string): Promise<boolean> {
    return (await this.db.query("DELETE FROM dashboard_users WHERE username = $1", [username])).rowCount > 0;
  }
}

export const COMPANY_NAME = "Contracting.Bid";

/** The id of the one company the sim runs, creating its row the first time. */
export async function ensureCompany(db: Db): Promise<number> {
  const found = await db.query<{ id: string }>("SELECT id FROM companies ORDER BY id LIMIT 1");
  if (found.rows[0]) return Number(found.rows[0].id);
  const made = await db.query<{ id: string }>("INSERT INTO companies (name, owner) VALUES ($1, 'owner') RETURNING id", [COMPANY_NAME]);
  return Number(made.rows[0]!.id);
}

export interface RunStart {
  runId: string;
  seed: number;
  command: string;
  profile: string;
  modelConfig: Record<string, unknown>;
  scenarioVersion?: string;
}

/** The parts of a run report the database keeps in columns; the whole report is kept as JSON too. */
export interface StoredReport {
  runId: string;
  outcome: string;
  reason?: string;
  spentUsd: number;
  agents: Array<{ id: number; role: string; instructions: string; budgetUsd: number; managerId: number | null; hiredById: number | null; status: string }>;
  approvals: Array<{
    id: number; gate: string; requestedBy: string; summary: string; amountUsd?: number; status: string;
    decidedBy?: string; reason?: string; autoApproved: boolean; items?: unknown[]; approvedItems?: string[];
  }>;
}

/**
 * Wraps a run's event log so every event is also written to Postgres, in
 * order. Appends stay synchronous, so a run plays out the same with or
 * without a database; flush() waits for the writes and reports the first
 * failure.
 */
export class PersistentEventLog implements EventLog {
  private chain: Promise<void> = Promise.resolve();
  private failure: Error | null = null;

  constructor(private readonly db: Db, private readonly inner: EventLog = new InMemoryEventLog()) {}

  append(event: EventInput): LoggedEvent {
    const logged = this.inner.append(event);
    this.chain = this.chain.then(async () => {
      if (this.failure) return;
      try {
        await this.db.query(
          "INSERT INTO events (run_id, seq, type, actor, sim_time, payload) VALUES ($1, $2, $3, $4, $5, $6)",
          [logged.runId, logged.seq, logged.type, logged.actor, Math.round(logged.simTime), JSON.stringify(logged.payload)],
        );
      } catch (err) {
        this.failure = err instanceof Error ? err : new Error(String(err));
      }
    });
    return logged;
  }

  list(filter?: { runId?: string; type?: string; actor?: string }): LoggedEvent[] {
    return this.inner.list(filter);
  }

  async flush(): Promise<void> {
    await this.chain;
    if (this.failure) throw new Error(`Saving events to the database failed: ${this.failure.message}`);
  }
}

/** Runs, their events, agents and approvals in Postgres. */
export class RunStore {
  constructor(private readonly db: Db) {}

  /** Records that a run started, and returns the event log to give the run. */
  async start(r: RunStart, inner?: EventLog): Promise<PersistentEventLog> {
    const company = await ensureCompany(this.db);
    await this.db.query(
      `INSERT INTO runs (id, company_id, seed, scenario_version, model_config, command, profile)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [r.runId, company, r.seed, r.scenarioVersion ?? "poc-1", JSON.stringify(r.modelConfig), r.command, r.profile],
    );
    return new PersistentEventLog(this.db, inner);
  }

  /** Saves the finished report, with its agents and approvals as rows, in one transaction. */
  async finish(log: PersistentEventLog, report: StoredReport): Promise<void> {
    await log.flush();
    await this.db.transaction(async (tx) => {
      const company = await ensureCompany(tx);
      await tx.query(
        "UPDATE runs SET report = $2, outcome = $3, reason = $4, spent_usd = $5, finished_at = now() WHERE id = $1",
        [report.runId, JSON.stringify(report), report.outcome, report.reason ?? null, report.spentUsd],
      );
      for (const a of report.agents) {
        await tx.query(
          `INSERT INTO agents (company_id, run_id, agent_no, role, instructions, budget_usd, manager_no, hired_by_no, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [company, report.runId, a.id, a.role, a.instructions, a.budgetUsd, a.managerId, a.hiredById, a.status],
        );
      }
      for (const a of report.approvals) {
        await tx.query(
          `INSERT INTO approvals (run_id, approval_no, gate, requested_by, summary, amount_usd, status, decided_by, reason, auto_approved, items, approved_items)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            report.runId, a.id, a.gate, a.requestedBy, a.summary, a.amountUsd ?? null, a.status, a.decidedBy ?? null, a.reason ?? null,
            a.autoApproved, a.items ? JSON.stringify(a.items) : null, a.approvedItems ? JSON.stringify(a.approvedItems) : null,
          ],
        );
      }
    });
  }

  /** Finished runs, newest first, in the dashboard's summary shape. */
  async list(limit = 200): Promise<RunSummary[]> {
    const r = await this.db.query<{ id: string; seed: string; outcome: string | null; reason: string | null; spent_usd: string | null; job: string | null }>(
      `SELECT id, seed, outcome, reason, spent_usd, report->'opportunity'->>'noticeId' AS job
       FROM runs WHERE report IS NOT NULL ORDER BY started_at DESC, id DESC LIMIT $1`,
      [limit],
    );
    return r.rows.map((x) => ({
      file: `${x.id}.json`,
      runId: x.id,
      seed: Number(x.seed),
      outcome: x.outcome,
      reason: x.reason,
      job: x.job,
      spentUsd: x.spent_usd === null ? null : Number(x.spent_usd),
    }));
  }

  async report(runId: string): Promise<Record<string, unknown> | null> {
    const r = await this.db.query<{ report: Record<string, unknown> | string | null }>("SELECT report FROM runs WHERE id = $1", [runId]);
    const rep = r.rows[0]?.report;
    if (!rep) return null;
    return typeof rep === "string" ? (JSON.parse(rep) as Record<string, unknown>) : rep;
  }

  async events(runId: string): Promise<LoggedEvent[]> {
    const r = await this.db.query<{ run_id: string; seq: string; type: string; actor: string; sim_time: number; payload: Record<string, unknown> }>(
      "SELECT run_id, seq, type, actor, sim_time, payload FROM events WHERE run_id = $1 ORDER BY seq",
      [runId],
    );
    return r.rows.map((e) => ({ runId: e.run_id, seq: Number(e.seq), type: e.type, actor: e.actor, simTime: e.sim_time, payload: e.payload }));
  }

  /** Imports a saved report file. Returns false when the run is already in the database. */
  async importReport(report: StoredReport & { seed: number; profile?: string; events?: LoggedEvent[] }, command: string): Promise<boolean> {
    const exists = await this.db.query("SELECT 1 FROM runs WHERE id = $1", [report.runId]);
    if (exists.rows.length > 0) return false;
    await this.db.transaction(async (tx) => {
      const store = new RunStore(tx);
      const log = await store.start({ runId: report.runId, seed: report.seed, command, profile: report.profile ?? "unknown", modelConfig: {} });
      for (const e of report.events ?? []) log.append(e);
      await store.finish(log, report);
    });
    return true;
  }
}
