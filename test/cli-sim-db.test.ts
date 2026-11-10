import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { databaseHint, main } from "../src/cli/sim.js";
import { newUser, totpCode } from "../src/dashboard/auth.js";
import { PgUserStore, RunStore } from "../src/db/stores.js";
import type { Db } from "../src/db/db.js";
import { MIGRATIONS, migratedDb, pgliteDb } from "./helpers/pgliteDb.js";

const PASSWORD = "a long enough phrase";
const env = { MIGRATIONS_DIR: MIGRATIONS, DASHBOARD_PORT: "0" };

describe("pnpm sim with a database (functional, embedded Postgres)", () => {
  let db: Db;
  let lines: string[];
  const out = (l: string) => void lines.push(l);
  const deps = () => ({ out, env, db, now: () => new Date("2026-11-10T00:00:00Z"), writeReport: async () => undefined });

  beforeEach(async () => {
    db = await migratedDb();
    lines = [];
  }, 30_000);
  afterEach(async () => {
    await db.close();
  });

  it("says how to fix an unreachable database", async () => {
    expect(databaseHint("postgres://u:p@db:5432/x")).toMatch(/^DATABASE_URL points at "db".* use localhost/);
    expect(databaseHint("postgres://u:p@localhost:5432/x")).toMatch(/^Check DATABASE_URL in \.env/);
    expect(databaseHint(undefined)).toMatch(/^Check DATABASE_URL/);
    const code = await main(["closeout", "--stub"], { out, env: { ...env, DATABASE_URL: "postgres://u:p@127.0.0.1:1/x" } });
    expect(code).toBe(2);
    expect(lines[0]).toMatch(/^Database: /);
    expect(lines[1]).toMatch(/^Check DATABASE_URL in \.env/);
  }, 30_000);

  it("refuses to run on a database that needs migrations", async () => {
    const fresh = pgliteDb();
    expect(await main(["closeout", "--stub"], { ...deps(), db: fresh })).toBe(2);
    expect(lines).toEqual(["Database: The database needs 2 migration(s) (001_init.sql, 002_runs_users.sql). Run: pnpm db migrate"]);
    await fresh.close();
  }, 30_000);

  it("saves a closeout run with every event, agent and approval", async () => {
    expect(await main(["closeout", "--stub", "--seed", "1"], deps())).toBe(0);
    expect(lines).toContain("Saved to the database.");
    const runs = new RunStore(db);
    const [summary] = await runs.list();
    expect(summary).toMatchObject({ runId: "closeout-cloud-2026-11-10T00-00-00-000Z-1", seed: 1, outcome: "closed", job: "STUB-E02" });
    const report = (await runs.report(summary!.runId))! as { eventCount: number; agents: unknown[]; approvals: unknown[]; events: unknown[] };
    const events = await runs.events(summary!.runId);
    expect(events).toHaveLength(report.eventCount);
    expect(events).toEqual(report.events);
    const count = async (table: string) => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;
    expect(await count("agents")).toBe(report.agents.length);
    expect(await count("approvals")).toBe(report.approvals.length);
  }, 30_000);

  it("saves a hiring run", async () => {
    expect(await main(["hiring", "--stub", "--seed", "3"], deps())).toBe(0);
    expect((await new RunStore(db).list()).map((r) => r.runId)).toEqual(["hiring-cloud-2026-11-10T00-00-00-000Z-3"]);
  }, 30_000);

  it("keeps dashboard logins in the database", async () => {
    let shown = "";
    const t = 1_800_000_000_000;
    const user = {
      now: () => t,
      askSecret: async () => PASSWORD,
      ask: async () => totpCode(shown, Math.floor(t / 30_000)),
    };
    const capture = (l: string) => {
      lines.push(l);
      if (l.startsWith("  Secret key: ")) shown = l.slice(14).replace(/ /g, "");
    };
    expect(await main(["user", "add", "owner"], { ...deps(), out: capture, user })).toBe(0);
    expect((await new PgUserStore(db).get("owner"))!.totpSecret).toBe(shown);
  }, 30_000);

  it("the dashboard lists runs from the database and signs in with database logins", async () => {
    expect(await main(["bid", "--stub", "--seed", "2"], deps())).toBe(0);
    const u = await newUser("owner", PASSWORD);
    await new PgUserStore(db).put(u);
    let runs: unknown;
    lines = [];
    const code = await main(["dashboard"], {
      ...deps(),
      untilStopped: async () => {
        const base = lines[0]!.slice("Owner dashboard: ".length).replace(/\/$/, "");
        const login = await fetch(`${base}/api/login`, {
          method: "POST",
          headers: { "x-requested-with": "dashboard" },
          body: JSON.stringify({ username: "owner", password: PASSWORD, code: totpCode(u.totpSecret, Math.floor(Date.now() / 30_000)) }),
        });
        const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
        runs = await (await fetch(`${base}/api/runs`, { headers: { cookie } })).json();
        const file = (runs as Array<{ file: string }>)[0]!.file;
        const one = (await (await fetch(`${base}/api/runs/${file}`, { headers: { cookie } })).json()) as { runId: string };
        expect(one.runId).toBe(file.replace(/\.json$/, ""));
      },
    });
    expect(code).toBe(0);
    expect(runs).toEqual([expect.objectContaining({ runId: "bid-cloud-2026-11-10T00-00-00-000Z-2", seed: 2 })]);
  }, 30_000);
});
