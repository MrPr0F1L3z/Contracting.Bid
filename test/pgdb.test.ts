import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgDb } from "../src/db/db.js";
import { loadMigrations, migrate, pendingMigrations } from "../src/db/migrate.js";
import { RunStore } from "../src/db/stores.js";
import { MIGRATIONS } from "./helpers/pgliteDb.js";

// Functional test against a real Postgres through the pg driver. Set TEST_DATABASE_URL to an
// empty, throwaway database to run it; it drops and recreates the public schema.
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("PgDb on a real Postgres (functional)", () => {
  let db: PgDb;
  beforeAll(async () => {
    db = new PgDb(url!);
    await db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  });
  afterAll(async () => {
    await db?.close();
  });

  it("commits and rolls back transactions", async () => {
    await db.exec("CREATE TABLE t (x INT PRIMARY KEY)");
    expect(await db.transaction(async (tx) => (await tx.query("INSERT INTO t VALUES (1) RETURNING x")).rows)).toEqual([{ x: 1 }]);
    await expect(db.transaction(async (tx) => {
      await tx.query("INSERT INTO t VALUES (2)");
      await tx.query("INSERT INTO t VALUES (1)");
    })).rejects.toThrow(/duplicate key/);
    expect((await db.query("SELECT x FROM t ORDER BY x")).rows).toEqual([{ x: 1 }]);
    expect((await db.query("SELECT x FROM t")).rowCount).toBe(1);
    await db.exec("DROP TABLE t");
  });

  it("migrates a database the container set up, then stores a run", async () => {
    const all = await loadMigrations(MIGRATIONS);
    await db.exec(all[0]!.sql);
    expect((await pendingMigrations(db, all)).map((m) => m.name)).toEqual(["002_runs_users.sql"]);
    expect(await migrate(db, all)).toEqual(["002_runs_users.sql"]);
    const runs = new RunStore(db);
    const log = await runs.start({ runId: "r1", seed: 2082671124, command: "bid", profile: "cloud", modelConfig: {} });
    log.append({ runId: "r1", simTime: 0, type: "run_started", actor: "owner", payload: { a: [1] } });
    await runs.finish(log, { runId: "r1", outcome: "lost", spentUsd: 0.1234, agents: [], approvals: [] });
    expect(await runs.events("r1")).toEqual([{ runId: "r1", seq: 1, type: "run_started", actor: "owner", simTime: 0, payload: { a: [1] } }]);
    expect(await runs.list()).toEqual([expect.objectContaining({ runId: "r1", seed: 2082671124, outcome: "lost", spentUsd: 0.1234 })]);
  });
});
