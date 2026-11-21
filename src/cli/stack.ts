import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { loadDotEnv } from "../config/dotenv.js";
import { PgDb } from "../db/db.js";
import { Pipeline, type Exec, type PipelineDeps } from "../deploy/pipeline.js";

export const STACK_USAGE = `Usage:
  pnpm stack status                       what staging and prod run, and the promotion gate
  pnpm stack deploy staging [--ref REF]   build a commit (default: HEAD, which must be committed),
                                          run its tests, start staging on it and check it
  pnpm stack test staging                 run the staging checks again on what staging runs
  pnpm stack promote [--ref BUILD] [--yes] [--outside-window]
                                          put the newest build that passed staging (or BUILD) on prod
  pnpm stack user staging|prod add|passwd|reset-code|remove NAME, or ... list
                                          manage a stack's dashboard logins (each stack has its own)

The flow: change and try things on dev (docker compose up -d, pnpm sim ...), commit, deploy
to staging. PASS: promote to prod in a maintenance window. FAIL: a report says what failed;
fix it on dev, commit, deploy to staging again.

Promotion needs PROMOTE_MIN_RUNS (default 10) closeout runs on staging that closed with no
owner intervention (PROMOTE_RUN_RULE), and runs only inside PROD_MAINTENANCE_WINDOW (this
machine's time, for example "Sun 02:00-04:00") unless you add --outside-window. It asks before
it changes prod unless you add --yes. Builds, reports, backups and the deploy ledger are kept in
STACKS_DIR (default ~/.local/share/contracting-bid/stacks).`;

export interface StackArgs {
  command: "status" | "deploy" | "test" | "promote" | "user";
  ref?: string;
  /** For user: the stack, and the arguments for pnpm sim user. */
  stack?: "staging" | "prod";
  userArgs?: string[];
  yes: boolean;
  outsideWindow: boolean;
}

/** Parses a `pnpm stack` command line, or returns null when it is wrong. */
export function parseStackArgs(argv: readonly string[]): StackArgs | null {
  const [command, ...rest] = argv;
  const args: StackArgs = { command: "status", yes: false, outsideWindow: false };
  if (command === "user") {
    const [stack, ...userArgs] = rest;
    if ((stack !== "staging" && stack !== "prod") || userArgs.length === 0) return null;
    return { ...args, command, stack, userArgs };
  }
  const words: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--ref") {
      const v = rest[++i];
      if (!v || v.startsWith("--")) return null;
      args.ref = v;
    } else if (a === "--yes") args.yes = true;
    else if (a === "--outside-window") args.outsideWindow = true;
    else if (a.startsWith("--")) return null;
    else words.push(a);
  }
  if (command === "status" && words.length === 0 && !args.ref && !args.yes && !args.outsideWindow) return { ...args, command };
  if (command === "deploy" && words.length === 1 && words[0] === "staging" && !args.yes && !args.outsideWindow) return { ...args, command };
  if (command === "test" && words.length === 1 && words[0] === "staging" && !args.ref && !args.yes && !args.outsideWindow) return { ...args, command };
  if (command === "promote" && (words.length === 0 || (words.length === 1 && words[0] === "prod"))) return { ...args, command };
  return null;
}

/** Where builds, reports and the ledger live: STACKS_DIR, or a folder under the home folder (outside a synced checkout). */
export function stateDir(env: Record<string, string | undefined>): string {
  if (env.STACKS_DIR) return resolve(env.STACKS_DIR);
  return join(env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share"), "contracting-bid", "stacks");
}

/**
 * Runs a program with arguments and no shell, showing its output as it goes
 * and keeping it for the report.
 */
export const spawnExec: Exec = (cmd, args, opts = {}) =>
  new Promise((done) => {
    const child = spawn(cmd, args, { env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const keep = (prev: string, chunk: Buffer) => (prev + chunk.toString()).slice(-200_000);
    // A dump goes straight to a file only the owner can read; wait for it to be written out.
    const file = opts.stdoutFile ? createWriteStream(opts.stdoutFile, { mode: 0o600 }) : null;
    const written = file ? new Promise<void>((r) => file.on("close", () => r())) : Promise.resolve();
    if (file) child.stdout.pipe(file);
    else child.stdout.on("data", (c: Buffer) => (stdout = keep(stdout, c)));
    child.stderr.on("data", (c: Buffer) => (stderr = keep(stderr, c)));
    child.on("error", (err) => {
      file?.end();
      void written.then(() => done({ code: 127, stdout, stderr: `${stderr}${err.message}` }));
    });
    child.on("close", (code) => void written.then(() => done({ code: code ?? 1, stdout, stderr })));
  });

/** Runs a program attached to this terminal (for prompts such as a new password). */
export type Interactive = (cmd: string, args: string[], env: Record<string, string>) => Promise<number>;

export const terminalExec: Interactive = (cmd, args, env) =>
  new Promise((done) => {
    const child = spawn(cmd, args, { env, stdio: "inherit" });
    child.on("error", () => done(127));
    child.on("close", (code) => done(code ?? 1));
  });

/** `pnpm stack ...`. Returns the exit code. */
export async function main(argv: string[], deps: Partial<PipelineDeps> & { interactive?: Interactive } = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const args = parseStackArgs(argv);
  if (!args) {
    out(STACK_USAGE);
    return argv.length === 0 || argv[0] === "help" ? 0 : 2;
  }
  const env = deps.env ?? process.env;
  let rl: ReturnType<typeof createInterface> | undefined;
  const pipeline = new Pipeline({
    exec: deps.exec ?? spawnExec,
    fetch: deps.fetch ?? ((url) => fetch(url, { signal: AbortSignal.timeout(5000) })),
    out,
    now: deps.now ?? (() => new Date()),
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    confirm:
      deps.confirm ??
      (async (q) => {
        rl ??= createInterface({ input: process.stdin, output: process.stdout });
        return /^y(es)?$/i.test((await rl.question(`${q} [y/N] `)).trim());
      }),
    openDb: deps.openDb ?? ((url) => new PgDb(url, 1)),
    root: deps.root ?? process.cwd(),
    stateDir: deps.stateDir ?? stateDir(env),
    env,
    ...(deps.healthTimeoutMs !== undefined ? { healthTimeoutMs: deps.healthTimeoutMs } : {}),
  });
  try {
    if (args.command === "status") return await pipeline.status();
    if (args.command === "deploy") return await pipeline.deployStaging(args.ref);
    if (args.command === "test") return await pipeline.testStaging();
    if (args.command === "user") {
      const run = await pipeline.userCommand(args.stack!, args.userArgs!);
      if (!run) {
        out(`Nothing is deployed to ${args.stack} yet, so it has no database. Deploy it first (pnpm stack status).`);
        return 2;
      }
      return await (deps.interactive ?? terminalExec)("docker", run.args, run.env);
    }
    return await pipeline.promote({ ...(args.ref ? { ref: args.ref } : {}), yes: args.yes, outsideWindow: args.outsideWindow });
  } catch (err) {
    out(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    rl?.close();
  }
}

// Run when invoked directly: node dist/src/cli/stack.js status
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // Only the pipeline's own settings are read from .env (PROD_MAINTENANCE_WINDOW and the like).
  // Docker gets a clean environment (see Pipeline.composeEnv), so .env cannot change a stack's ports.
  loadDotEnv();
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
