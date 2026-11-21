import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/db.js";
import { Pipeline, failedLine, imageFor, stackSettings, stamp, tail, type ExecOptions, type ExecResult, type PipelineDeps } from "../src/deploy/pipeline.js";
import { migratedDb } from "./helpers/pgliteDb.js";

const REPO = new URL("../", import.meta.url).pathname;
const SHA = "0123456789abcdef0123456789abcdef01234567";
const BUILD = SHA.slice(0, 12);
const SHA2 = "fedcba9876543210fedcba9876543210fedcba98";
const BUILD2 = SHA2.slice(0, 12);

interface Call {
  cmd: string;
  args: string[];
  opts: ExecOptions;
}

/**
 * A fake machine: git, tar and docker answer the way they would, and the
 * dashboards answer /healthz for whatever build was last started.
 */
class FakeMachine {
  calls: Call[] = [];
  dirty = false;
  images = new Set<string>();
  running = new Map<number, { stack: string; build: string }>();
  /** Step names (matched against the command) to make fail. */
  failing = new Set<"unit" | "build" | "up" | "health" | "closeout" | "guard" | "dump" | "upPrevious" | "migrate">();
  logins = 1;
  t = new Date(2026, 10, 22, 3, 0).getTime(); // Sunday 03:00, this machine's time

  constructor(private readonly root: string) {}

  exec = async (cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> => {
    this.calls.push({ cmd, args, opts });
    const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
    const fail = (stderr: string, code = 1): ExecResult => ({ code, stdout: "", stderr });
    const joined = args.join(" ");
    if (cmd === "git") {
      if (args.includes("status")) return ok(this.dirty ? " M src/x.ts\n" : "");
      if (args.includes("rev-parse")) {
        const ref = args.at(-1)!;
        if (ref.startsWith("HEAD") || ref.startsWith(BUILD)) return ok(`${SHA}\n`);
        if (ref.startsWith(BUILD2) || ref.startsWith("next")) return ok(`${SHA2}\n`);
        return fail("");
      }
      if (args.includes("archive")) return ok();
    }
    if (cmd === "tar") {
      // Unpack the "commit": this checkout's compose file and stack settings.
      const dest = args[args.indexOf("-C") + 1]!;
      await mkdir(join(dest, "deploy", "stacks"), { recursive: true });
      await writeFile(join(dest, "docker-compose.yml"), "services: {}\n");
      for (const s of ["staging", "prod"]) await copyFile(join(this.root, "deploy", "stacks", `${s}.env`), join(dest, "deploy", "stacks", `${s}.env`));
      return ok();
    }
    if (cmd === "rm") return ok();
    if (cmd !== "docker") return fail(`unexpected ${cmd}`, 127);
    if (args[0] === "image") return this.images.has(args[2]!) ? ok() : fail("No such image");
    if (args[0] === "build") {
      if (this.failing.has("build")) return fail("tsc: error TS2322");
      this.images.add(args[2]!);
      return ok("built");
    }
    if (args[0] === "run") {
      if (args.includes("APP_STACK=prod")) return this.failing.has("guard") ? ok("Starting a cloud closeout run") : { code: 3, stdout: 'The prod stack never runs simulations, so its database holds only real data. Run "closeout" on dev or staging.\n', stderr: "" };
      return this.failing.has("unit") ? { code: 1, stdout: " FAIL  test/x.test.ts > adds\nAssertionError: expected 2 to be 3\n", stderr: "" } : ok(" Tests  548 passed");
    }
    // docker compose -p PROJECT ...
    const project = args[2]!;
    const stack = project.replace("contracting-", "");
    const port = stack === "prod" ? 4300 : 4200;
    if (args.includes("--wait")) return ok();
    if (args.includes("migrate") && args.includes("run")) return this.failing.has("migrate") ? fail("Migration 005_x.sql failed, so none were applied") : ok("Applied 004_stack_identity.sql.");
    if (args.includes("psql")) return ok(`${this.logins}\n`);
    if (args.includes("user")) return ok();
    if (args.includes("up")) {
      const build = opts.env!.APP_BUILD!;
      if (this.failing.has("upPrevious") && build === BUILD) return fail("cannot start");
      if (this.failing.has("up") && build !== BUILD) return fail("port is already allocated");
      this.running.set(port, { stack, build });
      return ok();
    }
    if (args.includes("pg_dump")) {
      if (this.failing.has("dump")) return fail("pg_dump: connection refused");
      await writeFile(opts.stdoutFile!, "-- dump\n");
      return ok();
    }
    if (joined.includes("db.js status")) return ok("applied  001_init.sql\napplied  004_stack_identity.sql\n");
    if (joined.includes("sim.js closeout")) {
      if (stack === "prod") return { code: 3, stdout: "The prod stack never runs simulations, so its database holds only real data.\n", stderr: "" };
      return this.failing.has("closeout") ? { code: 1, stdout: "Run closeout-x: FAILED in 1s", stderr: "" } : ok("Run closeout-cloud-x (cloud, seed 1): CLOSED in 0.4s.\n");
    }
    return fail(`unexpected docker ${joined}`);
  };

  fetch = async (url: string) => {
    const port = Number(/:(\d+)\//.exec(url)![1]);
    const r = this.running.get(port);
    if (!r) throw new Error("ECONNREFUSED");
    const health = this.failing.has("health") && r.build !== BUILD ? { ok: true, stack: r.stack, build: "something-else" } : { ok: true, ...r };
    return { ok: true, json: async () => health };
  };

  now = () => new Date((this.t += 1000));

  composeCalls(what: string): Call[] {
    return this.calls.filter((c) => c.cmd === "docker" && c.args[0] === "compose" && c.args.includes(what));
  }

  /** The calls that start a stack's dashboard. */
  starts(project?: string): Call[] {
    return this.composeCalls("up").filter((c) => c.args.includes("dashboard") && (!project || c.args.includes(project)));
  }
}

describe("deploy pipeline (dev -> staging -> prod)", () => {
  let root: string;
  let state: string;
  let m: FakeMachine;
  let lines: string[];
  let staging: Db & { close(): Promise<void> };
  let answers: boolean[];

  const pipeline = (env: Record<string, string | undefined> = {}) => {
    const deps: PipelineDeps = {
      exec: m.exec,
      fetch: m.fetch,
      out: (l) => void lines.push(l),
      now: m.now,
      sleep: async () => undefined,
      confirm: async () => answers.shift() ?? false,
      openDb: () => ({ ...staging, close: async () => undefined }),
      root,
      stateDir: state,
      env: { PATH: "/usr/bin", HOME: "/home/owner", DOCKER_HOST: "unix:///x", ANTHROPIC_API_KEY: "sk-secret", DASHBOARD_PORT: "4100", PROD_MAINTENANCE_WINDOW: "Sun 02:00-04:00", PROMOTE_MIN_RUNS: "0", ...env },
      healthTimeoutMs: 10_000,
    };
    return new Pipeline(deps);
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pipe-root-"));
    state = join(root, "state");
    await mkdir(join(root, "deploy", "stacks"), { recursive: true });
    for (const s of ["staging", "prod"]) await copyFile(join(REPO, "deploy", "stacks", `${s}.env`), join(root, "deploy", "stacks", `${s}.env`));
    m = new FakeMachine(root);
    lines = [];
    answers = [];
    staging = await migratedDb();
  }, 30_000);
  afterEach(async () => {
    await staging.close();
    await rm(root, { recursive: true, force: true });
  });

  it("reads each stack's settings from the committed files", async () => {
    expect(await stackSettings(REPO, "staging")).toEqual({ stack: "staging", project: "contracting-staging", dbPort: 5433, dashboardPort: 4200, dbUser: "contracting", dbPassword: "contracting", dbName: "contracting" });
    expect(await stackSettings(REPO, "prod")).toMatchObject({ project: "contracting-prod", dbPort: 5434, dashboardPort: 4300 });
    await writeFile(join(root, "deploy", "stacks", "prod.env"), "APP_STACK=staging\nCOMPOSE_PROJECT_NAME=x\nDB_PORT=1\nDASHBOARD_PORT=2\n");
    await expect(stackSettings(root, "prod")).rejects.toThrow("must set APP_STACK=prod");
    await writeFile(join(root, "deploy", "stacks", "prod.env"), "APP_STACK=prod\nCOMPOSE_PROJECT_NAME=x\nDB_PORT=99999\nDASHBOARD_PORT=2\n");
    await expect(stackSettings(root, "prod")).rejects.toThrow("DB_PORT in deploy/stacks/prod.env must be a port number");
  });

  it("formats times and output for reports", () => {
    expect(failedLine([{ name: "a", ok: true }, { name: "b", ok: false, detail: "x\ny" }])).toBe("Failed step: b: y");
    expect(failedLine([{ name: "b", ok: false }])).toBe("Failed step: b");
    expect(failedLine([])).toBe("No step failed.");
    expect(stamp(new Date("2026-11-21T03:52:05.123Z"))).toBe("20261121T035205Z");
    expect(tail("a\nb\nc\n", 2)).toBe("b\nc");
  });

  it("gives docker only what it needs, never the owner's .env values", () => {
    const env = pipeline().composeEnv(BUILD);
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/owner", DOCKER_HOST: "unix:///x", APP_IMAGE: imageFor(BUILD), APP_BUILD: BUILD, SECRETS_FILE: join(root, ".env") });
    expect(pipeline({ DASHBOARD_DOMAIN: "cb.example.com" }).composeEnv(BUILD).DASHBOARD_DOMAIN).toBe("cb.example.com");
  });

  it("refuses to deploy uncommitted changes as HEAD", async () => {
    m.dirty = true;
    expect(await pipeline().deployStaging(undefined)).toBe(2);
    expect(lines[0]).toMatch(/^The working copy has changes that are not committed/);
    expect(m.calls.filter((c) => c.cmd === "docker")).toEqual([]);
  });

  it("refuses a ref that is not a commit", async () => {
    await expect(pipeline().deployStaging("no-such-branch")).rejects.toThrow('"no-such-branch" is not a commit in this repository.');
  });

  it("deploys a commit to staging: export, build, unit tests, start, checks, PASS", async () => {
    expect(await pipeline().deployStaging(undefined)).toBe(0);
    const ups = m.starts();
    expect(ups).toHaveLength(1);
    const dir = join(state, "src", BUILD);
    expect(ups[0]!.args).toEqual(["compose", "-p", "contracting-staging", "--project-directory", dir, "-f", join(dir, "docker-compose.yml"), "--env-file", join(dir, "deploy", "stacks", "staging.env"), "up", "-d", "--no-build", "--remove-orphans", "db", "migrate", "dashboard"]);
    expect(ups[0]!.opts.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(ups[0]!.opts.env).not.toHaveProperty("DASHBOARD_PORT");
    expect(m.calls.find((c) => c.args[0] === "build")!.args).toEqual(["build", "-t", "contracting-bid:0123456789ab", dir]);
    expect(lines.filter((l) => /^ {2}(PASS|FAIL) /.test(l))).toEqual([
      "  PASS  export commit", "  PASS  read stack settings", "  PASS  build image", "  PASS  unit tests in the image",
      "  PASS  start staging database", "  PASS  apply migrations", "  PASS  dashboard login exists", "  PASS  start staging on 0123456789ab",
      "  PASS  health check", "  PASS  migrations applied", "  PASS  stub closeout run on staging", "  PASS  prod refuses sim runs",
    ]);
    expect(lines.at(-1)).toMatch(/^PASS: 0123456789ab is on staging/);
    const ledger = await pipeline().ledger.all();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ stack: "staging", build: BUILD, result: "pass" });
    // A second deploy of the same commit reuses the export and the image.
    m.calls = [];
    expect(await pipeline().deployStaging(BUILD)).toBe(0);
    expect(m.calls.some((c) => c.cmd === "tar" || c.args[0] === "build")).toBe(false);
  });

  it("on FAIL, stops, writes a report for dev and records it", async () => {
    m.failing.add("unit");
    expect(await pipeline().deployStaging(undefined)).toBe(1);
    expect(m.starts()).toEqual([]);
    const [entry] = await pipeline().ledger.all();
    expect(entry).toMatchObject({ stack: "staging", build: BUILD, result: "fail" });
    const report = await readFile(entry!.report!, "utf8");
    expect(report).toMatch(/^# staging deploy of 0123456789ab FAILED/);
    expect(report).toContain("Failed step: unit tests in the image");
    expect(report).toContain("AssertionError: expected 2 to be 3");
    expect(report).toContain("Fix this on the dev stack, commit the fix, then deploy to staging again");
    expect(lines.at(-3)).toBe("Failed step: unit tests in the image: AssertionError: expected 2 to be 3");
    expect(lines.slice(-2)).toEqual([`FAIL: ${BUILD} did not pass staging. Report for dev: ${entry!.report}`, "Fix it on the dev stack, commit, and run pnpm stack deploy staging again."]);
    expect(await pipeline().ledger.latestPass("staging")).toBeNull();
  });

  it("fails staging when the stub run or the prod guard fails", async () => {
    m.failing.add("closeout");
    expect(await pipeline().deployStaging(undefined)).toBe(1);
    expect((await pipeline().ledger.latest("staging"))!.steps.at(-1)).toMatchObject({ name: "stub closeout run on staging", ok: false });
    m.failing.clear();
    m.failing.add("guard");
    expect(await pipeline().testStaging()).toBe(1);
    expect((await pipeline().ledger.latest("staging"))!.steps.at(-1)).toMatchObject({ name: "prod refuses sim runs", ok: false });
  });

  it("re-checks staging only once something is deployed", async () => {
    expect(await pipeline().testStaging()).toBe(2);
    expect(lines).toEqual(["Nothing is deployed to staging yet. Run: pnpm stack deploy staging"]);
    await pipeline().deployStaging(undefined);
    expect(await pipeline().testStaging()).toBe(0);
  });

  it("times out a health check that never reports the build", async () => {
    await pipeline().deployStaging(undefined);
    m.running.clear();
    expect(await pipeline().testStaging()).toBe(1);
    expect((await pipeline().ledger.latest("staging"))!.steps[0]).toMatchObject({ name: "health check", ok: false, detail: expect.stringContaining("ECONNREFUSED") });
  });

  it("promotes only a build that passed staging", async () => {
    expect(await pipeline().promote({ yes: true })).toBe(2);
    expect(lines).toEqual(["No build has passed staging yet. Run: pnpm stack deploy staging"]);
    m.failing.add("unit");
    await pipeline().deployStaging(undefined);
    lines = [];
    expect(await pipeline().promote({ ref: BUILD, yes: true })).toBe(2);
    expect(lines).toEqual([`${BUILD} has not passed staging, so it cannot go to prod. Run: pnpm stack deploy staging --ref ${BUILD}`]);
  });

  it("holds prod until staging has enough unattended runs", async () => {
    await pipeline().deployStaging(undefined);
    lines = [];
    expect(await pipeline({ PROMOTE_MIN_RUNS: undefined }).promote({ yes: true })).toBe(2);
    expect(lines).toEqual(["Not yet: staging has 0 of the 10 successful closeout runs without owner intervention that prod needs."]);
    expect(m.starts("contracting-prod")).toEqual([]);
  });

  it("changes prod only inside the maintenance window, unless told to", async () => {
    await pipeline().deployStaging(undefined);
    m.t = new Date(2026, 10, 23, 9, 0).getTime(); // Monday 09:00
    lines = [];
    expect(await pipeline().promote({ yes: true })).toBe(2);
    expect(lines[1]).toMatch(/^Prod changes only in a maintenance window \(Sun 02:00-04:00, this machine's time\)\. Next one opens Sun Nov 29 2026 02:00/);
    expect(lines[2]).toBe("To deploy now anyway, add --outside-window.");
    expect(await pipeline({ PROD_MAINTENANCE_WINDOW: "" }).promote({ yes: true })).toBe(2);
    expect(lines.at(-1)).toMatch(/^Set PROD_MAINTENANCE_WINDOW/);
    lines = [];
    expect(await pipeline().promote({ yes: true, outsideWindow: true })).toBe(0);
    expect(lines.some((l) => l.startsWith("OUTSIDE the maintenance window"))).toBe(true);
  });

  it("asks before it changes prod, and changes nothing on no", async () => {
    await pipeline().deployStaging(undefined);
    answers = [false];
    expect(await pipeline().promote({})).toBe(1);
    expect(lines.at(-1)).toBe("Nothing was changed.");
    expect(m.starts("contracting-prod")).toEqual([]);
  });

  it("promotes: first deploy, then the next with a backup of the prod database", async () => {
    await pipeline().deployStaging(undefined);
    answers = [true];
    expect(await pipeline().promote({})).toBe(0);
    expect(m.running.get(4300)).toEqual({ stack: "prod", build: BUILD });
    expect(lines.at(-1)).toBe(`PASS: prod runs ${BUILD}.`);
    expect(m.composeCalls("pg_dump")).toEqual([]);

    await pipeline().deployStaging("next");
    lines = [];
    expect(await pipeline().promote({ yes: true })).toBe(0);
    expect(m.running.get(4300)).toEqual({ stack: "prod", build: BUILD2 });
    const [dump] = m.composeCalls("pg_dump");
    expect(dump!.args.slice(0, 3)).toEqual(["compose", "-p", "contracting-prod"]);
    expect(dump!.opts.stdoutFile).toMatch(new RegExp(`backups/prod-\\d{8}T\\d{6}Z-before-${BUILD}\\.sql$`));
    expect(await readFile(dump!.opts.stdoutFile!, "utf8")).toBe("-- dump\n");
    expect(lines.at(-1)).toBe(`PASS: prod runs ${BUILD2}. The database before the deploy is saved at ${dump!.opts.stdoutFile}.`);
    expect(await pipeline().ledger.running("prod")).toBe(BUILD2);
  });

  it("starts Caddy with prod only when PROD_PUBLIC=1", async () => {
    await pipeline().deployStaging(undefined);
    expect(await pipeline({ PROD_PUBLIC: "1" }).promote({ yes: true })).toBe(0);
    const up = m.starts("contracting-prod")[0]!;
    expect(up.args.slice(9)).toEqual(["--profile", "public", "up", "-d", "--no-build", "--remove-orphans", "db", "migrate", "dashboard", "caddy"]);
  });

  it("goes back to the previous build when the new one fails on prod", async () => {
    await pipeline().deployStaging(undefined);
    await pipeline().promote({ yes: true });
    await pipeline().deployStaging("next");
    m.failing.add("health");
    lines = [];
    expect(await pipeline().promote({ yes: true })).toBe(1);
    expect(m.running.get(4300)).toEqual({ stack: "prod", build: BUILD });
    const last = (await pipeline().ledger.latest("prod"))!;
    expect(last).toMatchObject({ build: BUILD2, result: "fail", previous: BUILD, rolledBack: true });
    expect(await pipeline().ledger.running("prod")).toBe(BUILD);
    const report = await readFile(last.report!, "utf8");
    expect(report).toContain(`Prod is back on ${BUILD}.`);
    expect(report).toContain("The prod database was saved first");
    expect(lines.at(-1)).toMatch(new RegExp(`^FAIL: ${BUILD2} did not pass on prod\\. Prod is back on ${BUILD}\\.`));
  });

  it("says so when going back fails too, and when a backup fails it changes nothing", async () => {
    await pipeline().deployStaging(undefined);
    await pipeline().promote({ yes: true });
    await pipeline().deployStaging("next");
    m.failing.add("dump");
    expect(await pipeline().promote({ yes: true })).toBe(1);
    expect(m.running.get(4300)).toEqual({ stack: "prod", build: BUILD });
    expect((await pipeline().ledger.latest("prod"))!.steps.at(-1)).toMatchObject({ name: "back up prod database", ok: false });
    expect(lines.at(-1)).toMatch(new RegExp(`Prod was not changed and still runs ${BUILD}\\.`));
    expect(m.starts("contracting-prod")).toHaveLength(1);
    expect(await pipeline().ledger.running("prod")).toBe(BUILD);
    m.failing.clear();
    m.failing.add("up");
    m.failing.add("upPrevious");
    lines = [];
    expect(await pipeline().promote({ yes: true })).toBe(1);
    expect(lines.at(-1)).toMatch(new RegExp(`Going back to ${BUILD} FAILED: prod may be down\\.`));
    expect((await pipeline().ledger.latest("prod"))!.rolledBack).toBe(false);
  });

  it("has nothing to go back to when the first prod deploy fails", async () => {
    await pipeline().deployStaging(undefined);
    // The first prod deploy cannot start.
    m.exec = ((orig) => async (cmd: string, args: string[], opts?: ExecOptions) =>
      cmd === "docker" && args.includes("contracting-prod") && args.includes("up") && args.includes("dashboard") ? { code: 1, stdout: "", stderr: "port is already allocated" } : orig(cmd, args, opts))(m.exec);
    expect(await pipeline().promote({ yes: true })).toBe(1);
    expect(lines.at(-1)).toMatch(/This was the first prod deploy, so there is nothing to go back to\./);
  });

  it("stops before the dashboard when migrations fail or the database has no login", async () => {
    m.failing.add("migrate");
    expect(await pipeline().deployStaging(undefined)).toBe(1);
    expect((await pipeline().ledger.latest("staging"))!.steps.at(-1)).toMatchObject({ name: "apply migrations", ok: false, detail: expect.stringContaining("none were applied") });
    m.failing.clear();
    m.logins = 0;
    expect(await pipeline().deployStaging(undefined)).toBe(1);
    expect((await pipeline().ledger.latest("staging"))!.steps.at(-1)).toMatchObject({
      name: "dashboard login exists",
      ok: false,
      detail: "The staging database is new and has no dashboard login, so its dashboard cannot start. Add one, then deploy again: pnpm stack user staging add NAME",
    });
    expect(m.starts()).toEqual([]);
  });

  it("manages a stack's logins in its own database", async () => {
    expect(await pipeline().userCommand("staging", ["list"])).toBeNull();
    await pipeline().deployStaging(undefined);
    const run = (await pipeline().userCommand("staging", ["add", "owner"]))!;
    const dir = join(state, "src", BUILD);
    expect(run.args).toEqual(["compose", "-p", "contracting-staging", "--project-directory", dir, "-f", join(dir, "docker-compose.yml"), "--env-file", join(dir, "deploy", "stacks", "staging.env"), "run", "--rm", "--no-deps", "dashboard", "node", "dist/src/cli/sim.js", "user", "add", "owner"]);
    expect(run.env.APP_BUILD).toBe(BUILD);
  });

  it("shows each stack's status and the gate", async () => {
    await pipeline().status();
    expect(lines).toEqual([
      "dev      the working copy: docker compose up -d (no pipeline; see README)",
      "staging  nothing, not deployed",
      "prod     nothing, not deployed",
      "gate     0 of 0 unattended successful closeout runs on staging: ready to promote",
    ]);
    await pipeline().deployStaging(undefined);
    lines = [];
    await pipeline({ PROMOTE_MIN_RUNS: "10" }).status();
    expect(lines[1]).toMatch(new RegExp(`^staging  runs ${BUILD}, up on 127\\.0\\.0\\.1:4200, reports staging on ${BUILD}; last deploy ${BUILD} PASS at `));
    expect(lines[3]).toBe("gate     0 of 10 unattended successful closeout runs on staging");
    lines = [];
    const broken = pipeline({ PROMOTE_MIN_RUNS: "x" });
    m.running.clear();
    await broken.status();
    expect(lines[1]).toMatch(/not answering/);
    expect(lines[3]).toBe("gate     cannot reach the staging database to count runs");
  });
});
