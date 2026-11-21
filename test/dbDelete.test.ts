import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatLocal } from "../src/cli/cutoff.js";
import { main as dbMain, parseDbArgs, parseDeleteArgs } from "../src/cli/db.js";
import { RunStore, type StoredReport } from "../src/db/stores.js";
import { migratedDb } from "./helpers/pgliteDb.js";

type TestDb = Awaited<ReturnType<typeof migratedDb>>;

const report = (runId: string): StoredReport => ({
  runId, outcome: "closed", reason: "Done.", spentUsd: 0.25,
  agents: [
    { id: 1, role: "president", instructions: "lead", budgetUsd: 1, managerId: null, hiredById: null, status: "active" },
    { id: 2, role: "hr", instructions: "hire", budgetUsd: 1, managerId: 1, hiredById: 1, status: "active" },
  ],
  approvals: [{ id: 1, gate: "hire_agent", requestedBy: "president#1", summary: "Hire HR", amountUsd: 1, status: "approved", decidedBy: "auto", autoApproved: true }],
});

// Local-time dates, so the tests read the same in any time zone.
const local = (d: number, h = 12, mi = 0, s = 0) => new Date(2026, 10, d, h, mi, s, 0);
const now = () => local(15, 16, 0, 0);

async function addRun(db: TestDb, runId: string, startedAt: Date, finished = true): Promise<void> {
  const store = new RunStore(db);
  const log = await store.start({ runId, seed: 1, command: "bid", profile: "cloud", modelConfig: {} });
  log.append({ runId, type: "run_started", actor: "system", simTime: 0, payload: {} });
  log.append({ runId, type: "agent_hired", actor: "president#1", simTime: 1, payload: { role: "hr" } });
  if (finished) await store.finish(log, report(runId));
  else await log.flush();
  await db.query("UPDATE runs SET started_at = $2 WHERE id = $1", [runId, startedAt.toISOString()]);
}

const count = async (db: TestDb, table: string, runId?: string): Promise<number> => {
  const r = await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}${runId ? " WHERE run_id = $1" : ""}`, runId ? [runId] : []);
  return Number(r.rows[0]!.n);
};
const runIds = async (db: TestDb) => (await db.query<{ id: string }>("SELECT id FROM runs ORDER BY id")).rows.map((r) => r.id);

describe("parseDeleteArgs", () => {
  it("reads one run id, with the flags in any position", () => {
    expect(parseDeleteArgs(["bid-1"])).toEqual({ runId: "bid-1", yes: false, includeUnfinished: false });
    expect(parseDeleteArgs(["--yes", "bid-1", "--include-unfinished"])).toEqual({ runId: "bid-1", yes: true, includeUnfinished: true });
  });

  it("reads a cut-off after --before or before, keeping dashed time words", () => {
    expect(parseDeleteArgs(["--before", "now"])).toEqual({ before: ["now"], yes: false, includeUnfinished: false });
    expect(parseDeleteArgs(["before", "--now"])).toEqual({ before: ["--now"], yes: false, includeUnfinished: false });
    expect(parseDeleteArgs(["before", "--261115", "14:30:00", "--yes"])).toEqual({ before: ["--261115", "14:30:00"], yes: true, includeUnfinished: false });
    expect(parseDeleteArgs(["--yes", "--before", "2026-11-15 14:30:00"])).toEqual({ before: ["2026-11-15 14:30:00"], yes: true, includeUnfinished: false });
  });

  it("rejects missing, extra or unknown arguments", () => {
    for (const bad of [[], ["--yes"], ["a", "b"], ["--before"], ["before"], ["--before", "a", "b", "c"], ["--before", "--before", "now"], ["bid-1", "--force"], ["bid-1", "--yes", "--yes"], ["../etc"], ["--out", "x", "bid-1"]]) {
      expect(parseDeleteArgs(bad), bad.join(" ")).toBeNull();
    }
  });

  it("is what parseDbArgs uses for delete", () => {
    expect(parseDbArgs("delete", ["bid-1", "--yes"])).toEqual({ runsDir: "runs", del: { runId: "bid-1", yes: true, includeUnfinished: false } });
    expect(parseDbArgs("delete", [])).toBeNull();
  });
});

describe("RunStore delete (functional, embedded Postgres)", () => {
  let db: TestDb;
  beforeEach(async () => { db = await migratedDb(); }, 30_000);
  afterEach(async () => { await db.close(); });

  it("find and startedBefore report each run's start, outcome and whether it finished", async () => {
    await addRun(db, "bid-a", local(13));
    await addRun(db, "bid-b", local(14));
    await addRun(db, "bid-c", local(15, 9), false);
    const store = new RunStore(db);
    expect(await store.find("nope")).toBeNull();
    expect(await store.find("bid-a")).toEqual({ runId: "bid-a", startedAt: local(13), outcome: "closed", finished: true });
    expect(await store.find("bid-c")).toEqual({ runId: "bid-c", startedAt: local(15, 9), outcome: null, finished: false });
    expect((await store.startedBefore(local(14))).map((r) => r.runId)).toEqual(["bid-a"]); // strictly before
    expect((await store.startedBefore(local(14, 12, 0, 1))).map((r) => r.runId)).toEqual(["bid-a", "bid-b"]);
    expect((await store.startedBefore(local(16))).map((r) => r.runId)).toEqual(["bid-a", "bid-b", "bid-c"]);
  });

  it("removes a run's events, approvals and agents and leaves other runs whole", async () => {
    await addRun(db, "bid-a", local(13));
    await addRun(db, "bid-b", local(14));
    expect(await new RunStore(db).deleteRuns(["bid-a", "bid-a", "nope"])).toEqual(["bid-a"]);
    expect(await runIds(db)).toEqual(["bid-b"]);
    for (const t of ["events", "approvals", "agents"]) {
      expect(await count(db, t, "bid-a"), t).toBe(0);
      expect(await count(db, t, "bid-b"), t).toBeGreaterThan(0);
    }
    expect(await new RunStore(db).deleteRuns([])).toEqual([]);
  });

  it("clears links from tables the sim does not fill yet, and pointers from other runs", async () => {
    await addRun(db, "bid-a", local(13));
    await addRun(db, "bid-b", local(14));
    const agentA = (await db.query<{ id: string }>("SELECT id FROM agents WHERE run_id = 'bid-a' ORDER BY agent_no LIMIT 1")).rows[0]!.id;
    await db.query("INSERT INTO agent_config_history (agent_id, rev, config) VALUES ($1, 1, '{}')", [agentA]);
    await db.query("INSERT INTO vendors (run_id, kind, name, trade) VALUES ('bid-a', 'subcontractor', 'Mesa Coatings', 'painting')");
    await db.query("INSERT INTO vendors (run_id, kind, name, trade) VALUES ('bid-b', 'vendor', 'Front Range Floors', 'flooring')");
    await db.query("UPDATE agents SET manager_id = $1 WHERE run_id = 'bid-b'", [agentA]);
    expect(await new RunStore(db).deleteRuns(["bid-a"])).toEqual(["bid-a"]);
    expect(await count(db, "agents", "bid-b")).toBe(2);
    expect(await count(db, "agent_config_history")).toBe(0);
    expect(await count(db, "vendors", "bid-a")).toBe(0);
    expect(await count(db, "vendors", "bid-b")).toBe(1);
    expect(Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM agents WHERE manager_id IS NOT NULL")).rows[0]!.n)).toBe(0);
  });

  it("deletes nothing when one statement fails", async () => {
    await addRun(db, "bid-a", local(13));
    const broken = { ...db, transaction: db.transaction, query: db.query } as TestDb;
    const store = new RunStore({
      ...broken,
      transaction: (fn) => db.transaction((tx) => fn({ ...tx, query: ((sql: string, params?: unknown[]) => (sql.startsWith("DELETE FROM runs") ? Promise.reject(new Error("boom")) : tx.query(sql, params))) as typeof tx.query })),
    });
    await expect(store.deleteRuns(["bid-a"])).rejects.toThrow("boom");
    expect(await runIds(db)).toEqual(["bid-a"]);
    expect(await count(db, "events", "bid-a")).toBe(2);
    expect(await count(db, "agents", "bid-a")).toBe(2);
  });
});

describe("pnpm db delete (functional, embedded Postgres)", () => {
  let db: TestDb;
  let lines: string[];
  const out = (l: string) => void lines.push(l);
  const run = (...argv: string[]) => dbMain(["delete", ...argv], { out, env: {}, db, now });
  const text = () => lines.join("\n");

  beforeEach(async () => {
    db = await migratedDb();
    lines = [];
    await addRun(db, "bid-old", local(13, 10));
    await addRun(db, "bid-yesterday", local(14, 18));
    await addRun(db, "bid-morning", local(15, 9));
    await addRun(db, "bid-afternoon", local(15, 15));
    await addRun(db, "bid-running", local(15, 8), false);
  }, 30_000);
  afterEach(async () => { await db.close(); });

  it("only lists what it would delete until --yes is given", async () => {
    expect(await run("--before", "now")).toBe(0);
    expect(text()).toContain(`Cut-off: ${formatLocal(now())} (this machine's local time).`);
    expect(text()).toContain("4 run(s) would be deleted:");
    expect(text()).toContain(`  bid-old  started ${formatLocal(local(13, 10))}  closed`);
    expect(text()).toContain("Leaving 1 run(s) that have not finished.");
    expect(text()).toContain("Nothing was deleted. Run the same command with --yes");
    expect(await runIds(db)).toHaveLength(5);
  });

  it("before now with --yes deletes every finished run and keeps the unfinished one", async () => {
    expect(await run("before", "--now", "--yes")).toBe(0);
    expect(text()).toContain("Deleted 4 run(s) with their events, approvals and agents.");
    expect(await runIds(db)).toEqual(["bid-running"]);
    expect(await count(db, "events")).toBe(2);
    expect(await count(db, "approvals")).toBe(0);
  });

  it("a time with no date means today", async () => {
    expect(await run("--before", "12:00:00", "--yes")).toBe(0);
    expect(text()).toContain(`Cut-off: ${formatLocal(local(15, 12))}`);
    expect(await runIds(db)).toEqual(["bid-afternoon", "bid-running"]);
  });

  it("a date with no time means the start of that day", async () => {
    expect(await run("--before", "261114", "--yes")).toBe(0);
    expect(await runIds(db)).toEqual(["bid-afternoon", "bid-morning", "bid-running", "bid-yesterday"]);
  });

  it("a date and a time, dashed the way the owner typed it", async () => {
    expect(await run("before", "--261114", "18:00:01", "--yes")).toBe(0);
    expect(await runIds(db)).toEqual(["bid-afternoon", "bid-morning", "bid-running"]);
  });

  it("--include-unfinished takes unfinished runs too", async () => {
    expect(await run("--before", "now", "--yes", "--include-unfinished")).toBe(0);
    expect(text()).toContain("Deleted 5 run(s)");
    expect(await runIds(db)).toEqual([]);
    expect(await count(db, "events")).toBe(0);
  });

  it("says so when nothing is old enough", async () => {
    expect(await run("--before", "2026-11-01", "--yes")).toBe(0);
    expect(text()).toContain("No runs to delete before the cut-off.");
    expect(await runIds(db)).toHaveLength(5);
  });

  it("deletes one run by id, after showing it", async () => {
    expect(await run("bid-old")).toBe(0);
    expect(text()).toContain("1 run(s) would be deleted:");
    expect(await runIds(db)).toHaveLength(5);
    lines = [];
    expect(await run("bid-old", "--yes")).toBe(0);
    expect(text()).toContain("Deleted 1 run(s)");
    expect(await runIds(db)).not.toContain("bid-old");
  });

  it("refuses an unknown run and an unfinished one", async () => {
    expect(await run("nope", "--yes")).toBe(1);
    expect(text()).toContain("No run nope in the database.");
    lines = [];
    expect(await run("bid-running", "--yes")).toBe(1);
    expect(text()).toContain("Leaving 1 run(s) that have not finished.");
    expect(text()).toContain("Nothing to delete.");
    expect(await runIds(db)).toContain("bid-running");
    expect(await run("bid-running", "--yes", "--include-unfinished")).toBe(0);
    expect(await runIds(db)).not.toContain("bid-running");
  });

  it("rejects a time it cannot read without touching the database", async () => {
    expect(await dbMain(["delete", "--before", "yesterday", "--yes"], { out, env: {}, now })).toBe(2);
    expect(text()).toContain('Cannot read "yesterday" as a time.');
    lines = [];
    expect(await run("--before")).toBe(2);
    expect(text()).toContain("pnpm db delete --before WHEN");
    expect(await runIds(db)).toHaveLength(5);
  });
});
