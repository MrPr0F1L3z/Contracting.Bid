import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { Stack } from "../config/stack.js";
import type { Db } from "../db/db.js";
import { evaluateGate, gateRuns, minUnattendedRuns, unattendedRule, type GateResult } from "./gate.js";
import { Ledger, type Deployment, type StepResult } from "./ledger.js";
import { checkTimeZone, currentWindow, formatIn, nextWindowStart, parseWindows } from "./window.js";

/** What a command printed and how it ended. */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  /** The whole environment the command gets; nothing else from this process leaks in. */
  env?: Record<string, string>;
  /** Write stdout to this file instead of keeping it (a database dump). */
  stdoutFile?: string;
}

/** Runs a program with arguments (no shell). */
export type Exec = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

export type FetchLike = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export interface PipelineDeps {
  exec: Exec;
  fetch: FetchLike;
  out: (line: string) => void;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** Asks the owner a yes/no question in the terminal. */
  confirm: (question: string) => Promise<boolean>;
  /** Opens a database by URL (staging's, for the promotion gate). */
  openDb: (url: string) => Db;
  /** The repository checkout the pipeline runs from. */
  root: string;
  /** Where builds, the ledger, reports and backups live (STACKS_DIR). */
  stateDir: string;
  /** Settings: PROD_MAINTENANCE_WINDOW, PROMOTE_MIN_RUNS, PROMOTE_RUN_RULE, PATH, HOME, DOCKER_*. */
  env: Record<string, string | undefined>;
  /** How long to wait for a stack to come up, in ms (default 120 s). */
  healthTimeoutMs?: number;
}

/** A stack's settings, from deploy/stacks/STACK.env. */
export interface StackSettings {
  stack: Stack;
  project: string;
  dbPort: number;
  dashboardPort: number;
  dbUser: string;
  dbPassword: string;
  dbName: string;
}

/** The image a build runs as. */
export const imageFor = (build: string): string => `contracting-bid:${build}`;

/** Reads deploy/stacks/STACK.env under a checkout. */
export async function stackSettings(dir: string, stack: Stack): Promise<StackSettings> {
  const vars = parseEnv(await readFile(join(dir, "deploy", "stacks", `${stack}.env`), "utf8"));
  const port = (name: string): number => {
    const n = Number(vars[name]);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new Error(`${name} in deploy/stacks/${stack}.env must be a port number`);
    return n;
  };
  if (vars.APP_STACK !== stack) throw new Error(`deploy/stacks/${stack}.env must set APP_STACK=${stack}`);
  if (!vars.COMPOSE_PROJECT_NAME) throw new Error(`deploy/stacks/${stack}.env must set COMPOSE_PROJECT_NAME`);
  return {
    stack,
    project: vars.COMPOSE_PROJECT_NAME,
    dbPort: port("DB_PORT"),
    dashboardPort: port("DASHBOARD_PORT"),
    dbUser: vars.DB_USER || "contracting",
    dbPassword: vars.DB_PASSWORD || "contracting",
    dbName: vars.DB_NAME || "contracting",
  };
}

/** The last `n` lines of some output, for reports. */
export function tail(text: string, n = 60): string {
  const lines = text.trimEnd().split("\n");
  return lines.slice(-n).join("\n");
}

/** The failed step and the last line of what it said, for the terminal. */
export function failedLine(steps: readonly StepResult[]): string {
  const failed = steps.find((s) => !s.ok);
  if (!failed) return "No step failed.";
  const last = (failed.detail ?? "").trim().split("\n").at(-1) ?? "";
  return `Failed step: ${failed.name}${last ? `: ${last}` : ""}`;
}

/** A UTC timestamp safe for file names: 20261121T035205Z. */
export function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/**
 * The deploy pipeline. dev is the working copy, run as today with docker compose.
 * staging and prod only ever run a committed build: the commit is exported from
 * git, built into an image tagged with its hash, and started from that export, so
 * nothing on a stack is edited by hand.
 */
export class Pipeline {
  readonly ledger: Ledger;

  constructor(private readonly d: PipelineDeps) {
    this.ledger = new Ledger(join(d.stateDir, "ledger.json"));
  }

  private out(line: string): void {
    this.d.out(line);
  }

  /** The environment for docker: only what docker needs, plus the stack's own values. */
  composeEnv(build: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.d.env)) {
      if (v !== undefined && (k === "PATH" || k === "HOME" || k === "USER" || k.startsWith("DOCKER_") || k === "XDG_RUNTIME_DIR")) env[k] = v;
    }
    env.APP_IMAGE = imageFor(build);
    env.APP_BUILD = build;
    // Secrets (the Claude API key) come from the checkout's .env, read by Compose, never copied.
    env.SECRETS_FILE = join(this.d.root, ".env");
    if (this.d.env.DASHBOARD_DOMAIN) env.DASHBOARD_DOMAIN = this.d.env.DASHBOARD_DOMAIN;
    return env;
  }

  /** The source folder of a build. */
  sourceDir(build: string): string {
    return join(this.d.stateDir, "src", build);
  }

  /** docker compose arguments for a stack running a build. */
  composeArgs(settings: StackSettings, build: string, ...rest: string[]): string[] {
    const dir = this.sourceDir(build);
    return ["compose", "-p", settings.project, "--project-directory", dir, "-f", join(dir, "docker-compose.yml"), "--env-file", join(dir, "deploy", "stacks", `${settings.stack}.env`), ...rest];
  }

  private async git(args: string[]): Promise<ExecResult> {
    return this.d.exec("git", ["-C", this.d.root, ...args]);
  }

  /** The 12-character commit a ref names. Throws when it names none. */
  async resolve(ref: string): Promise<string> {
    const r = await this.git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (r.code !== 0 || !/^[0-9a-f]{40}$/.test(r.stdout.trim())) throw new Error(`"${ref}" is not a commit in this repository.`);
    return r.stdout.trim().slice(0, 12);
  }

  /** Why the working copy cannot be deployed as HEAD, or null. */
  async uncommitted(): Promise<string | null> {
    const r = await this.git(["status", "--porcelain", "--untracked-files=no"]);
    if (r.code !== 0) return `git status failed: ${tail(r.stderr, 5)}`;
    return r.stdout.trim() ? "The working copy has changes that are not committed. Staging runs only committed code: commit them first (or pass --ref to deploy another commit)." : null;
  }

  private async exists(path: string): Promise<boolean> {
    return stat(path).then(() => true, () => false);
  }

  /** Exports a commit from git into its source folder, once. */
  async prepareSource(build: string): Promise<StepResult> {
    const dir = this.sourceDir(build);
    if (await this.exists(join(dir, "docker-compose.yml"))) return { name: "export commit", ok: true, detail: `already at ${dir}` };
    await mkdir(dir, { recursive: true });
    const tar = `${dir}.tar`;
    const a = await this.git(["archive", "--format=tar", "-o", tar, build]);
    if (a.code !== 0) return { name: "export commit", ok: false, detail: tail(a.stderr) };
    const x = await this.d.exec("tar", ["-xf", tar, "-C", dir]);
    await this.d.exec("rm", ["-f", tar]);
    return x.code === 0 ? { name: "export commit", ok: true, detail: dir } : { name: "export commit", ok: false, detail: tail(x.stderr) };
  }

  /** Builds the image for a commit, unless it is already built. */
  async buildImage(build: string): Promise<StepResult> {
    const image = imageFor(build);
    if ((await this.d.exec("docker", ["image", "inspect", image])).code === 0) return { name: "build image", ok: true, detail: `${image} already built` };
    this.out(`Building ${image} ...`);
    const b = await this.d.exec("docker", ["build", "-t", image, this.sourceDir(build)]);
    return { name: "build image", ok: b.code === 0, detail: b.code === 0 ? image : tail(b.stdout + b.stderr) };
  }

  /** Runs a check command and turns its result into a step. */
  private async step(name: string, cmd: string, args: string[], pass: (r: ExecResult) => boolean, env?: Record<string, string>): Promise<StepResult> {
    this.out(`  ${name} ...`);
    const r = await this.d.exec(cmd, args, env ? { env } : {});
    const ok = pass(r);
    return { name, ok, detail: tail(`${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.trim() || `exit ${r.code}`, ok ? 8 : 60) };
  }

  /**
   * Starts (or replaces) a stack's services on a build, in order: the database,
   * then the migrations (all in one transaction; a failure stops here), then a
   * check that someone can sign in, then the dashboard.
   */
  async up(settings: StackSettings, build: string): Promise<StepResult[]> {
    const env = this.composeEnv(build);
    // Prod is the public one: with PROD_PUBLIC=1 its Caddy serves DASHBOARD_DOMAIN over HTTPS.
    const pub = settings.stack === "prod" && this.d.env.PROD_PUBLIC === "1";
    const profile = pub ? ["--profile", "public"] : [];
    const services = ["db", "migrate", "dashboard", ...(pub ? ["caddy"] : [])];
    return this.runSteps([
      () => this.step(`start ${settings.stack} database`, "docker", this.composeArgs(settings, build, "up", "-d", "--wait", "db"), (r) => r.code === 0, env),
      () => this.step("apply migrations", "docker", this.composeArgs(settings, build, "run", "--rm", "--no-deps", "migrate"), (r) => r.code === 0, env),
      () => this.logins(settings, build),
      () => this.step(`start ${settings.stack} on ${build}`, "docker", this.composeArgs(settings, build, ...profile, "up", "-d", "--no-build", "--remove-orphans", ...services), (r) => r.code === 0, env),
    ]);
  }

  /** The dashboard will not start without a login, so a new stack's database needs one first. */
  async logins(settings: StackSettings, build: string): Promise<StepResult> {
    const sql = "SELECT count(*) FROM dashboard_users";
    const r = await this.d.exec("docker", this.composeArgs(settings, build, "exec", "-T", "db", "psql", "-U", settings.dbUser, "-d", settings.dbName, "-tAc", sql), { env: this.composeEnv(build) });
    const n = Number(r.stdout.trim());
    if (r.code === 0 && n > 0) return { name: "dashboard login exists", ok: true, detail: `${n} login(s)` };
    return {
      name: "dashboard login exists",
      ok: false,
      detail: r.code !== 0 ? tail(r.stderr || r.stdout) : `The ${settings.stack} database is new and has no dashboard login, so its dashboard cannot start. Add one, then deploy again: pnpm stack user ${settings.stack} add NAME`,
    };
  }

  /** The compose command that manages logins on a stack, for `pnpm stack user`. */
  async userCommand(stack: Stack, userArgs: string[]): Promise<{ args: string[]; env: Record<string, string> } | null> {
    const build = await this.ledger.running(stack);
    if (!build) return null;
    const settings = await stackSettings(this.sourceDir(build), stack);
    return { args: this.composeArgs(settings, build, "run", "--rm", "--no-deps", "dashboard", "node", "dist/src/cli/sim.js", "user", ...userArgs), env: this.composeEnv(build) };
  }

  /** Waits until the stack's dashboard answers /healthz as the right stack and build. */
  async health(settings: StackSettings, build: string): Promise<StepResult> {
    const url = `http://127.0.0.1:${settings.dashboardPort}/healthz`;
    const deadline = this.d.now().getTime() + (this.d.healthTimeoutMs ?? 120_000);
    let last = "no answer yet";
    for (;;) {
      try {
        const res = await this.d.fetch(url);
        const body = (await res.json()) as { ok?: boolean; stack?: string; build?: string | null };
        if (res.ok && body.ok && body.stack === settings.stack && body.build === build) return { name: "health check", ok: true, detail: `${url}: ${settings.stack} on ${build}` };
        last = `answered ${JSON.stringify(body)}`;
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
      }
      if (this.d.now().getTime() >= deadline) return { name: "health check", ok: false, detail: `${url} did not report ${settings.stack} on ${build}: ${last}` };
      await this.d.sleep(2000);
    }
  }

  /** The checks a build must pass on staging, after its unit tests passed in the image. */
  async stagingChecks(settings: StackSettings, build: string): Promise<StepResult[]> {
    const env = this.composeEnv(build);
    const exec = (...cmd: string[]) => this.composeArgs(settings, build, "exec", "-T", "dashboard", ...cmd);
    const checks: Array<() => Promise<StepResult>> = [
      () => this.health(settings, build),
      () => this.step("migrations applied", "docker", exec("node", "dist/src/cli/db.js", "status"), (r) => r.code === 0 && !/^pending/m.test(r.stdout), env),
      // A fixed seed with a forced award, so the check always runs the whole job (a random seed can lose the bid).
      () => this.step("stub closeout run on staging", "docker", exec("node", "dist/src/cli/sim.js", "closeout", "--stub", "--force-award", "--seed", "1"), (r) => r.code === 0 && /: CLOSED in/.test(r.stdout), env),
      // Staging's job source (JOB_SOURCE in deploy/stacks/staging.env) must answer: SAM.gov, or its cache.
      () => this.step("staging reads its job listings", "docker", exec("node", "dist/src/cli/sim.js", "listings"), (r) => r.code === 0, env),
      // The image a prod deploy would run must refuse sim runs and the stub's made-up jobs. No database is involved.
      () => this.step("prod refuses sim runs", "docker", ["run", "--rm", "--network", "none", "-e", "APP_STACK=prod", imageFor(build), "node", "dist/src/cli/sim.js", "closeout", "--stub"], (r) => r.code === 3 && /never runs simulations/.test(r.stdout)),
      () => this.step("prod refuses stub jobs", "docker", ["run", "--rm", "--network", "none", "-e", "APP_STACK=prod", "-e", "JOB_SOURCE=stub", imageFor(build), "node", "dist/src/cli/sim.js", "listings"], (r) => r.code === 2 && /only reads jobs from SAM\.gov/.test(r.stdout)),
    ];
    return this.runSteps(checks);
  }

  /** Runs steps in order and stops at the first that fails. */
  private async runSteps(steps: Array<() => Promise<StepResult>>, done: StepResult[] = []): Promise<StepResult[]> {
    for (const s of steps) {
      const r = await s();
      done.push(r);
      this.out(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
      if (!r.ok) break;
    }
    return done;
  }

  /** Writes a failure report for dev to work from, and returns its path. */
  async writeReport(stack: Stack, build: string, steps: StepResult[], note: string): Promise<string> {
    const dir = join(this.d.stateDir, "reports");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${stack}-${build}-${stamp(this.d.now())}.md`);
    const failed = steps.find((s) => !s.ok);
    const body = [
      `# ${stack} deploy of ${build} FAILED`,
      "",
      `When: ${this.d.now().toISOString()}`,
      `Failed step: ${failed?.name ?? "none"}`,
      "",
      note,
      "",
      "## Steps",
      "",
      ...steps.map((s) => `- ${s.ok ? "PASS" : "FAIL"} ${s.name}`),
      "",
      ...(failed ? ["## Output of the failed step", "", "```", failed.detail ?? "", "```", ""] : []),
    ].join("\n");
    await writeFile(path, body);
    return path;
  }

  /**
   * dev -> staging: exports the commit, builds it, runs its unit tests in the
   * image, starts staging on it and runs the staging checks. Returns the exit code.
   */
  async deployStaging(ref: string | undefined): Promise<number> {
    if (ref === undefined) {
      const dirty = await this.uncommitted();
      if (dirty) {
        this.out(dirty);
        return 2;
      }
    }
    const build = await this.resolve(ref ?? "HEAD");
    this.out(`Deploying ${build} to staging.`);
    const steps: StepResult[] = [];
    let settings: StackSettings | undefined;
    await this.runSteps(
      [
        () => this.prepareSource(build),
        async () => {
          try {
            settings = await stackSettings(this.sourceDir(build), "staging");
            return { name: "read stack settings", ok: true, detail: `${settings.project}, dashboard on 127.0.0.1:${settings.dashboardPort}` };
          } catch (err) {
            return { name: "read stack settings", ok: false, detail: err instanceof Error ? err.message : String(err) };
          }
        },
        () => this.buildImage(build),
        () => this.step("unit tests in the image", "docker", ["run", "--rm", imageFor(build), "pnpm", "test"], (r) => r.code === 0),
      ],
      steps,
    );
    if (steps.every((s) => s.ok)) steps.push(...(await this.up(settings!, build)));
    if (steps.every((s) => s.ok)) steps.push(...(await this.stagingChecks(settings!, build)));
    return this.finishStaging(build, steps);
  }

  /** Re-runs the staging checks on the build staging runs now. */
  async testStaging(): Promise<number> {
    const build = await this.ledger.running("staging");
    if (!build) {
      this.out("Nothing is deployed to staging yet. Run: pnpm stack deploy staging");
      return 2;
    }
    this.out(`Checking staging on ${build}.`);
    const settings = await stackSettings(this.sourceDir(build), "staging");
    return this.finishStaging(build, await this.stagingChecks(settings, build));
  }

  private async finishStaging(build: string, steps: StepResult[]): Promise<number> {
    const pass = steps.length > 0 && steps.every((s) => s.ok);
    const entry: Deployment = { stack: "staging", build, at: this.d.now().toISOString(), result: pass ? "pass" : "fail", steps };
    if (!pass) {
      entry.report = await this.writeReport("staging", build, steps, "Fix this on the dev stack, commit the fix, then deploy to staging again: pnpm stack deploy staging");
    }
    await this.ledger.add(entry);
    if (pass) {
      this.out(`PASS: ${build} is on staging and passed every check. Promote it in a maintenance window: pnpm stack promote`);
      return 0;
    }
    this.out(failedLine(steps));
    this.out(`FAIL: ${build} did not pass staging. Report for dev: ${entry.report}`);
    this.out("Fix it on the dev stack, commit, and run pnpm stack deploy staging again.");
    return 1;
  }

  /** Counts staging's unattended runs against the promotion gate. */
  async gate(): Promise<GateResult> {
    const s = await stackSettings(this.d.root, "staging");
    const db = this.d.openDb(`postgres://${encodeURIComponent(s.dbUser)}:${encodeURIComponent(s.dbPassword)}@127.0.0.1:${s.dbPort}/${s.dbName}`);
    try {
      return evaluateGate(await gateRuns(db), unattendedRule(this.d.env.PROMOTE_RUN_RULE), minUnattendedRuns(this.d.env.PROMOTE_MIN_RUNS));
    } finally {
      await db.close();
    }
  }

  /**
   * staging -> prod. Only a build that passed staging, only once staging has the
   * unattended runs the gate needs, and only inside a maintenance window (unless
   * the owner passes --outside-window). Saves the prod database first, and goes
   * back to the previous build if the new one fails its checks.
   */
  async promote(opts: { ref?: string; yes?: boolean; outsideWindow?: boolean }): Promise<number> {
    const build = opts.ref !== undefined ? await this.resolve(opts.ref) : await this.ledger.latestPass("staging");
    if (!build) {
      this.out("No build has passed staging yet. Run: pnpm stack deploy staging");
      return 2;
    }
    if (!(await this.ledger.passed("staging", build))) {
      this.out(`${build} has not passed staging, so it cannot go to prod. Run: pnpm stack deploy staging --ref ${build}`);
      return 2;
    }
    let gate: GateResult;
    try {
      gate = await this.gate();
    } catch (err) {
      this.out(`Cannot count staging's runs: ${err instanceof Error ? err.message : String(err)}. Is staging up? (pnpm stack status)`);
      return 2;
    }
    if (!gate.passed) {
      this.out(`Not yet: staging has ${gate.counted} of the ${gate.needed} successful closeout runs without owner intervention that prod needs.`);
      return 2;
    }
    this.out(`Gate: ${gate.counted} unattended successful runs on staging (needs ${gate.needed}).`);
    let windows;
    let tz: string | undefined;
    try {
      windows = parseWindows(this.d.env.PROD_MAINTENANCE_WINDOW);
      tz = checkTimeZone(this.d.env.PROD_MAINTENANCE_TZ);
    } catch (err) {
      this.out(err instanceof Error ? err.message : String(err));
      return 2;
    }
    const now = this.d.now();
    const open = currentWindow(windows, now, tz);
    if (!open && !opts.outsideWindow) {
      const next = nextWindowStart(windows, now, tz);
      this.out(`Prod changes only in a maintenance window (${windows.map((w) => w.text).join(", ")}, ${tz ?? "this machine's time"}). Next one opens ${next ? formatIn(next, tz) : "never"}.`);
      this.out("To deploy now anyway, add --outside-window.");
      return 2;
    }
    const previous = await this.ledger.running("prod");
    this.out(`${open ? `In maintenance window ${open.text}.` : "OUTSIDE the maintenance window (--outside-window)."} Prod runs ${previous ?? "nothing yet"}; this deploys ${build}. The prod dashboard is down while it restarts.`);
    if (!opts.yes && !(await this.d.confirm(`Deploy ${build} to prod now?`))) {
      this.out("Nothing was changed.");
      return 1;
    }
    const prepared: StepResult[] = [];
    let settings: StackSettings | undefined;
    await this.runSteps(
      [
        () => this.prepareSource(build),
        async () => {
          try {
            settings = await stackSettings(this.sourceDir(build), "prod");
            return { name: "read stack settings", ok: true, detail: settings.project };
          } catch (err) {
            return { name: "read stack settings", ok: false, detail: err instanceof Error ? err.message : String(err) };
          }
        },
        () => this.buildImage(build),
      ],
      prepared,
    );
    if (!prepared.every((s) => s.ok)) return this.finishProd(build, previous, prepared, false, undefined, false);
    const backup = await this.backupProd(settings!, previous);
    prepared.push(backup.step);
    this.out(`  ${backup.step.ok ? "PASS" : "FAIL"}  ${backup.step.name}`);
    if (!backup.step.ok) return this.finishProd(build, previous, prepared, false, undefined, false);
    const steps = [...prepared, ...(await this.up(settings!, build))];
    if (steps.every((s) => s.ok)) steps.push(...(await this.runSteps(this.prodChecks(settings!, build))));
    if (steps.every((s) => s.ok)) return this.finishProd(build, previous, steps, false, backup.path);
    let rolledBack = false;
    if (previous) {
      this.out(`Going back to ${previous}.`);
      const prevSettings = await stackSettings(this.sourceDir(previous), "prod");
      const back = await this.up(prevSettings, previous);
      if (back.every((s) => s.ok)) back.push(...(await this.runSteps([() => this.health(prevSettings, previous)])));
      rolledBack = back.every((s) => s.ok);
      steps.push(...back.map((s) => ({ ...s, name: `roll back: ${s.name}` })));
    }
    return this.finishProd(build, previous, steps, rolledBack, backup.path);
  }

  /** The checks a prod deploy must pass. */
  private prodChecks(settings: StackSettings, build: string): Array<() => Promise<StepResult>> {
    const env = this.composeEnv(build);
    const exec = (...cmd: string[]) => this.composeArgs(settings, build, "exec", "-T", "dashboard", ...cmd);
    return [
      () => this.health(settings, build),
      () => this.step("migrations applied", "docker", exec("node", "dist/src/cli/db.js", "status"), (r) => r.code === 0 && !/^pending/m.test(r.stdout), env),
      () => this.step("prod refuses sim runs", "docker", exec("node", "dist/src/cli/sim.js", "closeout", "--stub"), (r) => r.code === 3 && /never runs simulations/.test(r.stdout), env),
      () => this.step("prod reads SAM.gov listings", "docker", exec("node", "dist/src/cli/sim.js", "listings"), (r) => r.code === 0 && /SAM\.gov listing\(s\)/.test(r.stdout), env),
    ];
  }

  /** Saves the prod database to a file before a deploy. A first deploy has nothing to save. */
  async backupProd(settings: StackSettings, previous: string | null): Promise<{ step: StepResult; path?: string }> {
    if (!previous) return { step: { name: "back up prod database", ok: true, detail: "first prod deploy: nothing to save" } };
    const source = await this.prepareSource(previous);
    if (!source.ok) return { step: { name: "back up prod database", ok: false, detail: `cannot export ${previous}: ${source.detail}` } };
    const dir = join(this.d.stateDir, "backups");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `prod-${stamp(this.d.now())}-before-${previous}.sql`);
    const r = await this.d.exec("docker", this.composeArgs(settings, previous, "exec", "-T", "db", "pg_dump", "-U", settings.dbUser, "--clean", "--if-exists", settings.dbName), { env: this.composeEnv(previous), stdoutFile: path });
    return r.code === 0 ? { step: { name: "back up prod database", ok: true, detail: path }, path } : { step: { name: "back up prod database", ok: false, detail: tail(r.stderr) } };
  }

  /** Records a prod deploy. `touched` is false when it failed before prod was changed. */
  private async finishProd(build: string, previous: string | null, steps: StepResult[], rolledBack: boolean, backup?: string, touched = true): Promise<number> {
    const pass = steps.every((s) => s.ok);
    const entry: Deployment = { stack: "prod", build, at: this.d.now().toISOString(), result: pass ? "pass" : "fail", steps, previous, ...(backup ? { backup } : {}) };
    if (!pass) {
      entry.rolledBack = rolledBack;
      entry.runningAfter = !touched || rolledBack ? previous : build;
      const state = !touched
        ? previous ? `Prod was not changed and still runs ${previous}.` : "Prod was not changed."
        : rolledBack ? `Prod is back on ${previous}.` : previous ? `Going back to ${previous} FAILED: prod may be down.` : "This was the first prod deploy, so there is nothing to go back to.";
      const restore = backup ? `\n\nThe prod database was saved first, to ${backup}. Restore it only if the failed deploy changed data you need back.` : "";
      entry.report = await this.writeReport("prod", build, steps, `${state} Fix this on the dev stack, commit, pass staging again, then promote.${restore}`);
      await this.ledger.add(entry);
      this.out(failedLine(steps));
      this.out(`FAIL: ${build} did not pass on prod. ${state} Report for dev: ${entry.report}`);
      return 1;
    }
    await this.ledger.add(entry);
    this.out(`PASS: prod runs ${build}.${backup ? ` The database before the deploy is saved at ${backup}.` : ""}`);
    return 0;
  }

  /** One line per stack: what it runs, its last deploy, and whether it answers. */
  async status(): Promise<number> {
    this.out("dev      the working copy: docker compose up -d (no pipeline; see README)");
    for (const stack of ["staging", "prod"] as const) {
      const running = await this.ledger.running(stack);
      const last = await this.ledger.latest(stack);
      let health = "not deployed";
      if (running) {
        try {
          const settings = await stackSettings(this.d.root, stack);
          const res = await this.d.fetch(`http://127.0.0.1:${settings.dashboardPort}/healthz`);
          const body = (await res.json()) as { stack?: string; build?: string | null };
          health = res.ok ? `up on 127.0.0.1:${settings.dashboardPort}, reports ${body.stack} on ${body.build ?? "unknown build"}` : "answers with an error";
        } catch {
          health = "not answering";
        }
      }
      const lastLine = last ? `; last deploy ${last.build} ${last.result.toUpperCase()} at ${last.at}${last.report ? ` (report: ${last.report})` : ""}` : "";
      this.out(`${stack.padEnd(8)} ${running ? `runs ${running}` : "nothing"}, ${health}${lastLine}`);
    }
    try {
      const g = await this.gate();
      this.out(`gate     ${g.counted} of ${g.needed} unattended successful closeout runs on staging${g.passed ? ": ready to promote" : ""}`);
    } catch {
      this.out("gate     cannot reach the staging database to count runs");
    }
    return 0;
  }
}
