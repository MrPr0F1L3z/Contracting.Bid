import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { databaseHint, launchJobs, main, parseSimArgs } from "../src/cli/sim.js";
import { stubBidProviders } from "../src/sim/stubBid.js";
import type { ApprovalRequest } from "../src/approvals/approvals.js";
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

  it("applies pending migrations before a run", async () => {
    const fresh = pgliteDb();
    expect(await main(["hiring", "--stub", "--seed", "1"], { ...deps(), db: fresh })).toBe(0);
    expect(lines[0]).toBe("Database: applied 001_init.sql, 002_runs_users.sql, 003_run_started_by.sql, 004_stack_identity.sql, 005_listing_cache.sql.");
    lines = [];
    expect(await main(["hiring", "--stub", "--seed", "2"], { ...deps(), db: fresh })).toBe(0);
    expect(lines.some((l) => l.startsWith("Database:"))).toBe(false);
    await fresh.close();
  }, 30_000);

  it("does not start a run when a migration fails, and leaves the database as it was", async () => {
    const dir = await mkdtemp(join(tmpdir(), "badmig-"));
    await writeFile(join(dir, "001_ok.sql"), "CREATE TABLE a (x INT);");
    await writeFile(join(dir, "002_bad.sql"), "SELECT nonsense FROM nowhere;");
    const fresh = pgliteDb();
    expect(await main(["hiring", "--stub"], { ...deps(), db: fresh, env: { ...env, MIGRATIONS_DIR: dir } })).toBe(2);
    expect(lines).toEqual([expect.stringMatching(/^Database: Migration 002_bad.sql failed, so none were applied: /)]);
    expect((await fresh.query("SELECT to_regclass('public.a')::text AS t")).rows[0]).toEqual({ t: null });
    await fresh.close();
    await rm(dir, { recursive: true, force: true });
  }, 30_000);

  it("writes no report file when the run is saved to the database", async () => {
    const written: string[] = [];
    expect(await main(["bid", "--stub", "--seed", "2"], { ...deps(), writeReport: async (p) => void written.push(p) })).toBe(0);
    expect(written).toEqual([]);
    expect(lines.at(-1)).toBe("Saved to the database. To get it as a file: pnpm db export bid-cloud-2026-11-10T00-00-00-000Z-2");
    expect(lines.some((l) => l.startsWith("Report:"))).toBe(false);
  }, 30_000);

  it("saves a closeout run with every event, agent and approval", async () => {
    expect(await main(["closeout", "--stub", "--seed", "1"], deps())).toBe(0);
    expect(lines.at(-1)).toMatch(/^Saved to the database\. To get it as a file: pnpm db export closeout-/);
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

  /** Signs in to a running dashboard as owner and returns a JSON caller. */
  const signIn = async (secret: string) => {
    const base = lines.find((l) => l.startsWith("Owner dashboard: "))!.slice("Owner dashboard: ".length).replace(/\/$/, "");
    const res = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "x-requested-with": "dashboard" },
      body: JSON.stringify({ username: "owner", password: PASSWORD, code: totpCode(secret, Math.floor(Date.now() / 30_000)) }),
    });
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    const { csrf } = (await res.json()) as { csrf: string };
    return async (path: string, body?: unknown) =>
      (await fetch(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { cookie, "x-csrf-token": csrf, "x-requested-with": "dashboard" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })).json() as Promise<Record<string, unknown>>;
  };
  const waitForLast = async (api: Awaited<ReturnType<typeof signIn>>, answer = false, count = 1) => {
    for (;;) {
      const s = await api("/api/launch");
      const finished = s.finished as Array<{ exitCode: number; output: string[]; startedBy: string }>;
      if (finished.length >= count) return finished[0]!;
      if (answer) {
        for (const p of ((await api("/api/state")).pending as ApprovalRequest[])) await api(`/api/approvals/${p.id}`, { approve: true });
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it("serve needs a database and takes no options", async () => {
    expect(parseSimArgs(["serve"])).toMatchObject({ command: "serve" });
    expect(() => parseSimArgs(["serve", "--stub"])).toThrow("serve takes no options");
    expect(await main(["serve"], { ...deps(), db: null })).toBe(2);
    expect(lines).toEqual(["serve needs DATABASE_URL: runs started from the dashboard are saved in the database."]);
    expect(launchJobs().map((j) => j.noticeId)).toContain("STUB-E02");
  });

  it("serve stays up, starts a run from the page and saves it in the database", async () => {
    const u = await newUser("owner", PASSWORD);
    await new PgUserStore(db).put(u);
    let last: { exitCode: number; output: string[]; startedBy: string } | undefined;
    const code = await main(["serve"], {
      ...deps(),
      untilStopped: async () => {
        const api = await signIn(u.totpSecret);
        expect(await api("/api/launch", { command: "closeout", stub: true, seed: 1 })).toMatchObject({ running: [{ argv: ["closeout", "--seed", "1", "--stub"] }] });
        last = await waitForLast(api);
      },
    });
    expect(code).toBe(0);
    expect(lines.slice(1, 2)).toEqual(["Start runs and answer approvals there. Press Ctrl+C to stop."]);
    expect(last).toMatchObject({ exitCode: 0, startedBy: "owner" });
    expect(last!.output.at(-1)).toMatch(/^Saved to the database\./);
    expect((await new RunStore(db).list()).map((r) => r.runId)).toEqual(["closeout-cloud-2026-11-10T00-00-00-000Z-1"]);
  }, 30_000);

  it("a run started from serve asks its approvals on the dashboard", async () => {
    const u = await newUser("owner", PASSWORD);
    await new PgUserStore(db).put(u);
    let last: { exitCode: number } | undefined;
    await main(["serve"], {
      ...deps(),
      providers: stubBidProviders("cloud"),
      untilStopped: async () => {
        const api = await signIn(u.totpSecret);
        await api("/api/launch", { command: "bid", job: "STUB-E02", seed: 2 });
        last = await waitForLast(api, true);
      },
    });
    expect(last).toMatchObject({ exitCode: 0 });
    const runs = new RunStore(db);
    const [run] = await runs.list();
    const report = (await runs.report(run!.runId)) as { approvals: Array<{ gate: string; decidedBy: string }> };
    expect(report.approvals.find((a) => a.gate === "submit_bid")!.decidedBy).toBe("owner:owner");
  }, 30_000);

  it("serve runs several runs side by side and saves who started each", async () => {
    const u = await newUser("owner", PASSWORD);
    await new PgUserStore(db).put(u);
    await main(["serve"], {
      ...deps(),
      providers: stubBidProviders("cloud"),
      untilStopped: async () => {
        const api = await signIn(u.totpSecret);
        // The bid waits for its approvals, so the hiring run goes alongside it.
        await api("/api/launch", { command: "bid", job: "STUB-E02", seed: 2 });
        while (((await api("/api/state")).pending as unknown[]).length === 0) await new Promise((r) => setTimeout(r, 10));
        const second = await api("/api/launch", { command: "hiring", stub: true, seed: 3 });
        expect((second.running as unknown[]).length).toBe(2);
        await waitForLast(api, true, 2);
      },
    });
    expect((await new RunStore(db).list()).map((r) => r.runId).sort()).toEqual(["bid-cloud-2026-11-10T00-00-00-000Z-2", "hiring-cloud-2026-11-10T00-00-00-000Z-3"]);
    expect((await db.query("SELECT DISTINCT started_by FROM runs")).rows).toEqual([{ started_by: "dashboard:owner" }]);
  }, 30_000);

  it("serve offers SAM.gov jobs when JOB_SOURCE=samgov, cached in the database", async () => {
    const u = await newUser("owner", PASSWORD);
    await new PgUserStore(db).put(u);
    const listing = { noticeId: "abc", title: "Paint stairwells", type: "Solicitation", naicsCode: "238320", active: "Yes" };
    let calls = 0;
    const samFetch = async () => (calls++, { ok: true, status: 200, json: async () => ({ totalRecords: 1, opportunitiesData: [listing] }), text: async () => "" });
    let jobs: unknown;
    await main(["serve"], {
      ...deps(),
      env: { ...env, JOB_SOURCE: "samgov", SAM_GOV_API_KEY: "k" },
      samFetch,
      untilStopped: async () => {
        jobs = (await (await signIn(u.totpSecret))("/api/launch")).jobs;
      },
    });
    expect(lines[0]).toBe("Offering 1 samgov job(s) in Start a run (restart the service to read new listings).");
    expect(jobs).toEqual([{ noticeId: "abc", title: "Paint stairwells", complexity: "easy" }]);
    expect(calls).toBe(2);
    expect((await db.query("SELECT source, requests FROM listing_cache")).rows).toEqual([{ source: "samgov", requests: 2 }]);
  }, 30_000);

  it("on prod, serve reads SAM.gov whatever JOB_SOURCE says, and never offers the stub jobs", async () => {
    const listing = { noticeId: "abc", title: "Paint stairwells", type: "Solicitation", naicsCode: "238320", active: "Yes" };
    const samFetch = async () => ({ ok: true, status: 200, json: async () => ({ totalRecords: 1, opportunitiesData: [listing] }), text: async () => "" });
    await main(["serve"], { ...deps(), env: { ...env, APP_STACK: "prod", SAM_GOV_API_KEY: "k" }, samFetch, untilStopped: async () => undefined });
    expect(lines[0]).toBe("Read 1 samgov job(s) that can be bid.");
    expect((await db.query("SELECT source FROM listing_cache")).rows).toEqual([{ source: "samgov" }]);
    lines = [];
    await main(["serve"], { ...deps(), env: { ...env, APP_STACK: "prod", JOB_SOURCE: "stub" }, untilStopped: async () => undefined });
    expect(lines[0]).toBe('The prod stack only reads jobs from SAM.gov, never sim data, so its job source is always samgov, not "stub".. No SAM.gov listings were read; fix the setting and restart.');
  }, 30_000);

  it("serve still starts when SAM.gov is not set up, offering no jobs", async () => {
    await main(["serve"], { ...deps(), env: { ...env, JOB_SOURCE: "samgov" }, untilStopped: async () => undefined });
    expect(lines[0]).toMatch(/^JOB_SOURCE=samgov needs SAM_GOV_API_KEY.*\. Start a run offers no jobs; fix the setting and restart\.$/);
  });

  it("serve refuses a bad MAX_PARALLEL_RUNS", async () => {
    expect(await main(["serve"], { ...deps(), env: { ...env, MAX_PARALLEL_RUNS: "0" } })).toBe(2);
    expect(lines).toEqual(['MAX_PARALLEL_RUNS must be a whole number from 1 to 20, not "0"']);
  });

  it("serve marks its runs cut off by a stop as interrupted, and leaves terminal runs alone", async () => {
    const u = await newUser("owner", PASSWORD);
    await new PgUserStore(db).put(u);
    const runs = new RunStore(db);
    const old = await runs.start({ runId: "old-dash", seed: 5, command: "bid", profile: "cloud", modelConfig: {}, startedBy: "dashboard:owner" });
    old.append({ runId: "old-dash", simTime: 0, type: "run_started", actor: "owner", payload: {} });
    await old.flush();
    await runs.start({ runId: "terminal", seed: 6, command: "bid", profile: "cloud", modelConfig: {} });
    await main(["serve"], {
      ...deps(),
      providers: stubBidProviders("cloud"),
      untilStopped: async () => {
        const api = await signIn(u.totpSecret);
        await api("/api/launch", { command: "bid", job: "STUB-E02", seed: 2 });
        // Stop while the run waits for its first approval.
        while (((await api("/api/state")).pending as unknown[]).length === 0) await new Promise((r) => setTimeout(r, 10));
      },
    });
    expect(lines[0]).toBe("Marked 1 run(s) cut off by the last stop as interrupted: old-dash");
    expect(lines.at(-1)).toBe("Stopping during 1 run(s); marked interrupted: bid-cloud-2026-11-10T00-00-00-000Z-2");
    const listed = await runs.list();
    expect(listed.map((r) => [r.runId, r.outcome]).sort()).toEqual([["bid-cloud-2026-11-10T00-00-00-000Z-2", "interrupted"], ["old-dash", "interrupted"]]);
    expect(await runs.report("old-dash")).toMatchObject({
      runId: "old-dash", seed: 5, outcome: "interrupted", reason: "The dashboard service stopped during the run.", startedBy: "dashboard:owner",
      events: [{ type: "run_started" }], approvals: [], agents: [],
    });
    expect(await runs.report("terminal")).toBeNull();
    expect(await runs.interruptDashboardRuns("again")).toEqual([]);
  }, 30_000);
  it("on prod, serve has no Start a run, and says which stack and build it is", async () => {
    const u = await newUser("owner", PASSWORD);
    await new PgUserStore(db).put(u);
    let health: unknown;
    let me: Record<string, unknown> | undefined;
    let launch: Record<string, unknown> | undefined;
    let loginBody: unknown;
    const code = await main(["serve"], {
      ...deps(),
      env: { ...env, APP_STACK: "prod", APP_BUILD: "abc123def456" },
      untilStopped: async () => {
        const base = lines.find((l) => l.startsWith("Owner dashboard: "))!.slice("Owner dashboard: ".length).replace(/\/$/, "");
        health = await (await fetch(`${base}/healthz`)).json();
        const login = await fetch(`${base}/api/login`, {
          method: "POST",
          headers: { "x-requested-with": "dashboard" },
          body: JSON.stringify({ username: "owner", password: PASSWORD, code: totpCode(u.totpSecret, Math.floor(Date.now() / 30_000)) }),
        });
        loginBody = await login.json();
        const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
        const get = async (path: string) => (await fetch(`${base}${path}`, { headers: { cookie } })).json() as Promise<Record<string, unknown>>;
        me = await get("/api/me");
        launch = await get("/api/launch");
      },
    });
    expect(code).toBe(0);
    expect(lines).toContain("The prod stack does not start sim runs. Press Ctrl+C to stop.");
    expect(lines[0]).toMatch(/^JOB_SOURCE=samgov needs SAM_GOV_API_KEY.*No SAM\.gov listings were read; fix the setting and restart\.$/);
    expect(health).toEqual({ ok: true, stack: "prod", build: "abc123def456" });
    expect(me).toMatchObject({ username: "owner", stack: "prod" });
    expect(loginBody).toMatchObject({ username: "owner", stack: "prod" });
    expect(launch).toEqual({ error: "This dashboard cannot start runs. Start it with: pnpm sim serve" });
  }, 30_000);

  it("on prod, every sim run command refuses before it opens the database", async () => {
    const untouchable: Db = {
      query: async () => { throw new Error("prod must not touch the database for a sim run"); },
      exec: async () => { throw new Error("prod must not touch the database for a sim run"); },
      transaction: async () => { throw new Error("prod must not touch the database for a sim run"); },
      close: async () => undefined,
    };
    for (const cmd of [["hiring", "--stub"], ["bench", "--stub"], ["bid", "--stub"], ["job", "--stub"], ["closeout", "--stub", "--auto-approve"]]) {
      lines = [];
      expect(await main(cmd, { ...deps(), db: untouchable, env: { ...env, APP_STACK: "prod" } })).toBe(3);
      expect(lines).toEqual([`The prod stack never runs simulations, so its database holds only real data. Run "${cmd[0]}" on dev or staging.`]);
    }
    lines = [];
    expect(await main(["closeout", "--stub"], { ...deps(), env: { ...env, APP_STACK: "nope" } })).toBe(2);
    expect(lines).toEqual(['APP_STACK must be one of dev, staging, prod, not "nope"']);
  });

  it("refuses a database that belongs to another stack, before migrating it", async () => {
    expect(await main(["hiring", "--stub", "--seed", "1"], { ...deps(), env: { ...env, APP_STACK: "staging" } })).toBe(0);
    lines = [];
    expect(await main(["user", "list"], { ...deps(), env: { ...env, APP_STACK: "prod" } })).toBe(2);
    expect(lines).toEqual(["Database: This database belongs to the staging stack, but APP_STACK is prod. Point DATABASE_URL at the prod database."]);
  }, 30_000);

  it("records how a run was set up, for the promotion gate", async () => {
    expect(await main(["closeout", "--stub", "--seed", "1"], { ...deps(), env: { ...env, APP_BUILD: "abc123def456" } })).toBe(0);
    const row = (await db.query<{ model_config: Record<string, unknown> }>("SELECT model_config FROM runs")).rows[0]!;
    expect(row.model_config).toMatchObject({ stub: true, autoApprove: true, build: "abc123def456" });
  }, 30_000);
});
