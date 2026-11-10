import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

// Functional test: the migration applies cleanly to a real (embedded) Postgres.
describe("db/migrations/001_init.sql", () => {
  it("creates every table in the data model", async () => {
    const sql = await readFile(new URL("../db/migrations/001_init.sql", import.meta.url), "utf8");
    const db = new PGlite();
    await db.exec(sql);
    const res = await db.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    expect(res.rows.map((r) => r.tablename)).toEqual([
      "agent_config_history", "agents", "approvals", "bids", "change_orders", "commitments", "companies",
      "estimates", "events", "invoices", "opportunities", "projects", "quotes", "runs", "tasks", "vendors",
    ]);
    await db.close();
  }, 30_000);

  it("enforces atomic task checkout", async () => {
    const sql = await readFile(new URL("../db/migrations/001_init.sql", import.meta.url), "utf8");
    const db = new PGlite();
    await db.exec(sql);
    await db.exec(`
      INSERT INTO companies (name, owner) VALUES ('Test GC', 'owner');
      INSERT INTO runs (id, company_id, seed, scenario_version, model_config) VALUES ('r1', 1, 1, 'v1', '{}');
      INSERT INTO agents (company_id, role, instructions, model, budget_usd) VALUES (1, 'estimator', 'x', 'm', 1), (1, 'procurement', 'x', 'm', 1);
      INSERT INTO tasks (run_id, title, status) VALUES ('r1', 'Takeoff', 'todo');
    `);
    const claim = "UPDATE tasks SET checked_out_by = $1 WHERE id = 1 AND checked_out_by IS NULL";
    expect((await db.query(claim, [1])).affectedRows).toBe(1);
    expect((await db.query(claim, [2])).affectedRows).toBe(0);
    await db.close();
  }, 30_000);
});
