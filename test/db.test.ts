import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, PgDb, redactUrl, type Db } from "../src/db/db.js";
import { appliedMigrations, loadMigrations, migrate, migrationsDir, pendingMigrations, requireMigrated } from "../src/db/migrate.js";
import { PersistentEventLog, PgUserStore, RunStore, ensureCompany, type StoredReport } from "../src/db/stores.js";
import { main as dbMain } from "../src/cli/db.js";
import { FileUserStore } from "../src/dashboard/auth.js";
import { MIGRATIONS, migratedDb, pgliteDb } from "./helpers/pgliteDb.js";

describe("db helpers", () => {
  it("opens a pool only when DATABASE_URL is set", async () => {
    expect(openDb({})).toBeNull();
    expect(openDb({ DATABASE_URL: "  " })).toBeNull();
    const db = openDb({ DATABASE_URL: "postgres://u:p@127.0.0.1:1/x" });
    expect(db).toBeInstanceOf(PgDb);
    await db!.close();
  });
  it("hides the password in a connection string", () => {
    expect(redactUrl("postgres://contracting:s3cret@db:5432/contracting")).toBe("postgres://contracting:***@db:5432/contracting");
    expect(redactUrl("postgres://db:5432/x")).toBe("postgres://db:5432/x");
  });
  it("finds the migrations folder", () => {
    expect(migrationsDir({}, "/repo")).toBe("/repo/db/migrations");
    expect(migrationsDir({ MIGRATIONS_DIR: "/m" }, "/repo")).toBe("/m");
  });
});

describe("migrations (functional, embedded Postgres)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mig-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads numbered files in order and refuses duplicate numbers", async () => {
    await writeFile(join(dir, "002_b.sql"), "SELECT 2");
    await writeFile(join(dir, "001_a.sql"), "SELECT 1");
    await writeFile(join(dir, "notes.md"), "x");
    expect((await loadMigrations(dir)).map((m) => m.name)).toEqual(["001_a.sql", "002_b.sql"]);
    await writeFile(join(dir, "002_c.sql"), "SELECT 3");
    await expect(loadMigrations(dir)).rejects.toThrow("Two migrations are numbered 002");
  });

  it("applies the repo's migrations once, in order", async () => {
    const db = pgliteDb();
    const all = await loadMigrations(MIGRATIONS);
    await expect(requireMigrated(db, all)).rejects.toThrow(/needs 2 migration\(s\) \(001_init.sql, 002_runs_users.sql\)\. Run: pnpm db migrate/);
    expect(await migrate(db, all)).toEqual(["001_init.sql", "002_runs_users.sql"]);
    expect(await migrate(db, all)).toEqual([]);
    expect(await appliedMigrations(db)).toEqual(["001_init.sql", "002_runs_users.sql"]);
    await requireMigrated(db, all);
    await db.close();
  }, 30_000);

  it("treats a database the container already set up as having 001", async () => {
    const db = pgliteDb();
    const all = await loadMigrations(MIGRATIONS);
    await db.exec(all[0]!.sql);
    expect((await pendingMigrations(db, all)).map((m) => m.name)).toEqual(["002_runs_users.sql"]);
    expect(await migrate(db, all)).toEqual(["002_runs_users.sql"]);
    await db.close();
  }, 30_000);

  it("rolls back a migration that fails, leaving it pending", async () => {
    await writeFile(join(dir, "001_ok.sql"), "CREATE TABLE a (x INT);");
    await writeFile(join(dir, "002_bad.sql"), "CREATE TABLE b (x INT); SELECT nonsense FROM nowhere;");
    const db = pgliteDb();
    const all = await loadMigrations(dir);
    await expect(migrate(db, all)).rejects.toThrow();
    expect(await appliedMigrations(db)).toEqual(["001_ok.sql"]);
    expect((await db.query("SELECT to_regclass('public.b')::text AS t")).rows[0]).toEqual({ t: null });
    await db.close();
  }, 30_000);
});

const report = (runId: string, extra: Partial<StoredReport> = {}): StoredReport & { seed: number; profile: string } => ({
  runId,
  seed: 7,
  profile: "cloud",
  outcome: "closed",
  reason: "All done.",
  spentUsd: 0.5,
  agents: [
    { id: 1, role: "president", instructions: "lead", budgetUsd: 1.5, managerId: null, hiredById: null, status: "active" },
    { id: 2, role: "hr", instructions: "hire", budgetUsd: 2, managerId: 1, hiredById: 1, status: "active" },
  ],
  approvals: [
    { id: 1, gate: "hire_agent", requestedBy: "president#1", summary: "Hire HR", amountUsd: 2, status: "approved", decidedBy: "auto", autoApproved: true },
    {
      id: 2, gate: "release_payment", requestedBy: "bookkeeper#7", summary: "Pay", amountUsd: 30, status: "approved", decidedBy: "owner:owner",
      reason: "hold B-1", autoApproved: false, items: [{ id: "B-1" }, { id: "B-2" }], approvedItems: ["B-2"],
    },
  ],
  ...extra,
});

describe("stores (functional, embedded Postgres)", () => {
  let db: Db;
  beforeEach(async () => {
    db = await migratedDb();
  }, 30_000);
  afterEach(async () => {
    await db.close();
  });

  it("creates the company row once", async () => {
    const id = await ensureCompany(db);
    expect(await ensureCompany(db)).toBe(id);
    expect((await db.query("SELECT name FROM companies")).rows).toEqual([{ name: "Contracting.Bid" }]);
  });

  it("keeps dashboard logins", async () => {
    const users = new PgUserStore(db);
    const u = { username: "owner", passwordHash: "h", totpSecret: "S", lastTotpStep: -1, createdAt: "2026-11-10T00:00:00.000Z" };
    expect(await users.get("owner")).toBeNull();
    await users.put(u);
    await users.put({ ...u, lastTotpStep: 99, passwordHash: "h2" });
    expect(await users.get("owner")).toEqual({ ...u, lastTotpStep: 99, passwordHash: "h2" });
    expect(await users.list()).toHaveLength(1);
    expect(await users.remove("owner")).toBe(true);
    expect(await users.remove("owner")).toBe(false);
  });

  it("writes a run's events in order as they happen, and the report with its agents and approvals at the end", async () => {
    const runs = new RunStore(db);
    const log = await runs.start({ runId: "bid-1", seed: 7, command: "bid", profile: "cloud", modelConfig: { president: "x" } });
    const first = log.append({ runId: "bid-1", simTime: 0, type: "run_started", actor: "owner", payload: { seed: 7 } });
    log.append({ runId: "bid-1", simTime: 2.6, type: "bid_submitted", actor: "pm#3" });
    expect(first.seq).toBe(1);
    expect(log.list()).toHaveLength(2);
    expect(await runs.list()).toEqual([]);
    await runs.finish(log, report("bid-1"));
    expect(await runs.events("bid-1")).toEqual([
      { runId: "bid-1", seq: 1, type: "run_started", actor: "owner", simTime: 0, payload: { seed: 7 } },
      { runId: "bid-1", seq: 2, type: "bid_submitted", actor: "pm#3", simTime: 3, payload: {} },
    ]);
    expect(await runs.list()).toEqual([{ file: "bid-1.json", runId: "bid-1", seed: 7, outcome: "closed", reason: "All done.", job: null, spentUsd: 0.5 }]);
    expect(await runs.report("bid-1")).toMatchObject({ runId: "bid-1", outcome: "closed" });
    expect(await runs.report("missing")).toBeNull();
    const agents = await db.query("SELECT agent_no, role, manager_no, status FROM agents WHERE run_id = 'bid-1' ORDER BY agent_no");
    expect(agents.rows).toEqual([
      { agent_no: 1, role: "president", manager_no: null, status: "active" },
      { agent_no: 2, role: "hr", manager_no: 1, status: "active" },
    ]);
    const appr = await db.query("SELECT approval_no, decided_by, approved_items, items FROM approvals WHERE run_id = 'bid-1' ORDER BY approval_no");
    expect(appr.rows[1]).toEqual({ approval_no: 2, decided_by: "owner:owner", approved_items: ["B-2"], items: [{ id: "B-1" }, { id: "B-2" }] });
    expect((await db.query("SELECT command, profile, finished_at IS NOT NULL AS done FROM runs")).rows).toEqual([{ command: "bid", profile: "cloud", done: true }]);
  });

  it("reports a failed event write at flush, and keeps the run going meanwhile", async () => {
    const log = new PersistentEventLog(db);
    // No runs row for this run id, so the foreign key refuses the insert.
    expect(log.append({ runId: "ghost", simTime: 0, type: "x", actor: "a" }).seq).toBe(1);
    expect(log.append({ runId: "ghost", simTime: 0, type: "y", actor: "a" }).seq).toBe(2);
    await expect(log.flush()).rejects.toThrow(/^Saving events to the database failed: /);
  });

  it("saves nothing of a report whose rows fail", async () => {
    const runs = new RunStore(db);
    const log = await runs.start({ runId: "r2", seed: 1, command: "bid", profile: "cloud", modelConfig: {} });
    const bad = report("r2", { agents: [{ id: 1, role: "president", instructions: "x", budgetUsd: 1, managerId: null, hiredById: null, status: "weird" }] });
    await expect(runs.finish(log, bad)).rejects.toThrow();
    expect((await db.query("SELECT report FROM runs WHERE id = 'r2'")).rows).toEqual([{ report: null }]);
    expect((await db.query("SELECT count(*)::int AS n FROM approvals")).rows).toEqual([{ n: 0 }]);
  });

  it("imports a report file once", async () => {
    const runs = new RunStore(db);
    const r = { ...report("closeout-1"), events: [{ runId: "closeout-1", seq: 1, simTime: 0, type: "run_started", actor: "owner", payload: {} }] };
    expect(await runs.importReport(r, "closeout")).toBe(true);
    expect(await runs.importReport(r, "closeout")).toBe(false);
    expect(await runs.events("closeout-1")).toHaveLength(1);
  });
});

describe("pnpm db (functional, embedded Postgres)", () => {
  let dir: string;
  let lines: string[];
  const out = (l: string) => void lines.push(l);
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dbcli-"));
    lines = [];
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("explains its usage and needs DATABASE_URL", async () => {
    expect(await dbMain([], { out })).toBe(2);
    expect(lines[0]).toMatch(/^Usage:/);
    lines = [];
    expect(await dbMain(["help"], { out })).toBe(0);
    expect(await dbMain(["drop"], { out })).toBe(2);
    expect(await dbMain(["import", "--bogus"], { out })).toBe(2);
    lines = [];
    expect(await dbMain(["status"], { out, env: {} })).toBe(2);
    expect(lines).toEqual(["Set DATABASE_URL first (see .env.example)."]);
  });

  it("migrates, shows status, and imports report files and file logins", async () => {
    const db = pgliteDb();
    const env = { MIGRATIONS_DIR: MIGRATIONS, DASHBOARD_USERS_FILE: join(dir, "users.json") };
    expect(await dbMain(["status"], { out, env, db })).toBe(0);
    expect(lines).toEqual(["pending  001_init.sql", "pending  002_runs_users.sql"]);
    lines = [];
    expect(await dbMain(["import"], { out, env, db })).toBe(2);
    expect(lines).toEqual(["Run pnpm db migrate first."]);
    lines = [];
    expect(await dbMain(["migrate"], { out, env, db })).toBe(0);
    expect(await dbMain(["migrate"], { out, env, db })).toBe(0);
    expect(lines).toEqual(["Applied 001_init.sql, 002_runs_users.sql.", "The database is up to date."]);

    const runsDir = join(dir, "runs");
    await import("node:fs/promises").then((fs) => fs.mkdir(runsDir));
    await writeFile(join(runsDir, "bid-cloud-1.json"), JSON.stringify(report("bid-cloud-1")));
    await writeFile(join(runsDir, "bench-1.json"), JSON.stringify({ summaries: [] }));
    await writeFile(join(runsDir, "broken.json"), "{");
    await writeFile(join(runsDir, "other.json"), JSON.stringify({ hello: 1 }));
    await new FileUserStore(env.DASHBOARD_USERS_FILE).put({ username: "owner", passwordHash: "h", totpSecret: "S", lastTotpStep: -1, createdAt: "2026-11-10T00:00:00.000Z" });
    lines = [];
    expect(await dbMain(["import", "--out", runsDir], { out, env, db })).toBe(0);
    expect(lines).toEqual([
      "Skipped broken.json: not valid JSON.",
      "Skipped other.json: not a run report.",
      "Imported 1 run(s); skipped 2. Imported 1 dashboard login(s).",
      `The logins are in the database now; you can delete ${env.DASHBOARD_USERS_FILE}.`,
    ]);
    lines = [];
    expect(await dbMain(["import", "--out", runsDir], { out, env, db })).toBe(0);
    expect(lines.at(-1)).toBe("Imported 0 run(s); skipped 3. Imported 0 dashboard login(s).");
    expect((await db.query("SELECT command FROM runs")).rows).toEqual([{ command: "bid" }]);
    expect(JSON.parse(await readFile(env.DASHBOARD_USERS_FILE, "utf8")).users).toHaveLength(1);
    await db.close();
  }, 30_000);
});
