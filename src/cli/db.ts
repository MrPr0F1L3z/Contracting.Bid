import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FileUserStore } from "../dashboard/auth.js";
import { openDb, redactUrl, type Db } from "../db/db.js";
import { appliedMigrations, loadMigrations, migrate, migrationsDir } from "../db/migrate.js";
import { PgUserStore, RunStore, type RunRow, type StoredReport } from "../db/stores.js";
import { formatLocal, parseCutoff } from "./cutoff.js";
import { usersFile } from "./dashboardCli.js";
import { loadDotEnv } from "../config/dotenv.js";

export const DB_USAGE = `Usage:
  pnpm db migrate              apply new schema migrations (db/migrations); runs do this themselves too
  pnpm db status               show which migrations are applied
  pnpm db import [--out DIR]   copy saved reports (default runs/) and dashboard logins from files into the database
  pnpm db export RUN_ID [--out DIR]   write one run's report to DIR/RUN_ID.json (default runs/), to share it
  pnpm db delete RUN_ID [--yes]       delete one run with its events, approvals and agents
  pnpm db delete --before WHEN [--yes]   delete every run that started before WHEN

delete only lists what it would remove until you add --yes. Deleting cannot be undone; export a run first to keep a copy.
Runs that have not finished are left alone unless you add --include-unfinished.
WHEN is in this machine's local time:
  now                  everything so far
  14:30  14:30:00      that time today
  261115  2026-11-15   the start of that day
  261115 14:30:00      that day at that time

Uses DATABASE_URL, for example postgres://contracting:contracting@localhost:5432/contracting.`;

export interface DbDeps {
  env?: Record<string, string | undefined>;
  out?: (line: string) => void;
  db?: Db;
  /** The clock, for tests. */
  now?: () => Date;
}

/** What `pnpm db delete` was asked to remove. */
export interface DeleteArgs {
  runId?: string;
  /** The words after --before, still to be read as a time. */
  before?: string[];
  yes: boolean;
  includeUnfinished: boolean;
}

/** `pnpm db ...`. Returns the exit code. */
export async function main(argv: string[], deps: DbDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const env = deps.env ?? process.env;
  const [command, ...rest] = argv;
  if (!command || command === "help") {
    out(DB_USAGE);
    return command ? 0 : 2;
  }
  const parsed = parseDbArgs(command, rest);
  if (!parsed) {
    out(DB_USAGE);
    return 2;
  }
  const { runsDir, runId } = parsed;
  let cutoff: Date | undefined;
  if (parsed.del?.before) {
    // Checked before the database is opened, so a typo costs nothing.
    const read = parseCutoff(parsed.del.before, (deps.now ?? (() => new Date()))());
    if (!read) {
      out(`Cannot read "${parsed.del.before.join(" ")}" as a time. Use now, 14:30:00, 261115, 2026-11-15 or 261115 14:30:00.`);
      return 2;
    }
    cutoff = read;
  }
  const db = deps.db ?? openDb(env);
  if (!db) {
    out("Set DATABASE_URL first (see .env.example).");
    return 2;
  }
  try {
    const migrations = await loadMigrations(migrationsDir(env));
    if (command === "status") {
      const done = new Set(await appliedMigrations(db));
      for (const m of migrations) out(`${done.has(m.name) ? "applied" : "pending"}  ${m.name}`);
      return 0;
    }
    const applied = await migrate(db, migrations);
    if (command === "migrate") {
      out(applied.length ? `Applied ${applied.join(", ")}.` : "The database is up to date.");
      return 0;
    }
    if (applied.length) out(`Applied ${applied.join(", ")}.`);
    if (command === "export") return await exportRun(db, runId!, runsDir, out);
    if (command === "delete") return await deleteRuns(db, parsed.del!, cutoff, out);
    return await importFiles(db, runsDir, usersFile(env), out);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    out(env.DATABASE_URL ? `${msg} (database ${redactUrl(env.DATABASE_URL)})` : msg);
    return 1;
  } finally {
    if (!deps.db) await db.close();
  }
}

/** The folder and run a `pnpm db` command names, or null when the arguments are wrong. */
export function parseDbArgs(command: string, rest: string[]): { runsDir: string; runId?: string; del?: DeleteArgs } | null {
  if (command === "delete") {
    const del = parseDeleteArgs(rest);
    return del ? { runsDir: "runs", del } : null;
  }
  const args = [...rest];
  let runsDir = "runs";
  const at = args.indexOf("--out");
  if (at >= 0) {
    if (command !== "import" && command !== "export") return null;
    const dir = args[at + 1];
    if (!dir) return null;
    runsDir = dir;
    args.splice(at, 2);
  }
  if (command === "export") {
    const [runId] = args;
    return args.length === 1 && /^[\w.-]+$/.test(runId!) ? { runsDir, runId: runId! } : null;
  }
  return args.length === 0 && ["migrate", "status", "import"].includes(command) ? { runsDir } : null;
}

/**
 * The arguments of `pnpm db delete`, or null when they are wrong. Either one
 * run id, or `--before` (or `before`) followed by one or two words of time.
 * A time word may carry a leading "--", as in `--now` or `--261115`.
 */
export function parseDeleteArgs(rest: readonly string[]): DeleteArgs | null {
  const isTimeWord = (t: string) => /^--(now$|\d)/i.test(t);
  const flags = rest.filter((t) => t.startsWith("--") && !isTimeWord(t) && t !== "--before");
  if (flags.some((f) => f !== "--yes" && f !== "--include-unfinished") || new Set(flags).size !== flags.length) return null;
  const words = rest.filter((t) => !flags.includes(t));
  const base = { yes: flags.includes("--yes"), includeUnfinished: flags.includes("--include-unfinished") };
  if (words[0] === "--before" || words[0] === "before") {
    const before = words.slice(1);
    if (before.length < 1 || before.length > 2 || before.some((w) => w === "--before" || w === "before")) return null;
    return { ...base, before };
  }
  if (words.length !== 1 || !/^[\w.-]+$/.test(words[0]!)) return null;
  return { ...base, runId: words[0]! };
}

const runLine = (r: RunRow): string => `  ${r.runId}  started ${formatLocal(r.startedAt)}  ${r.finished ? (r.outcome ?? "finished") : "not finished"}`;

/**
 * Lists the runs a delete would remove and, with --yes, removes them.
 * Without --yes nothing changes. Returns the exit code.
 */
export async function deleteRuns(db: Db, args: DeleteArgs, cutoff: Date | undefined, out: (line: string) => void): Promise<number> {
  const store = new RunStore(db);
  let found: RunRow[];
  if (args.runId !== undefined) {
    const one = await store.find(args.runId);
    if (!one) {
      out(`No run ${args.runId} in the database. pnpm sim dashboard lists the runs.`);
      return 1;
    }
    found = [one];
  } else {
    if (!cutoff) throw new Error("delete needs a run id or a cut-off time");
    found = await store.startedBefore(cutoff);
    out(`Cut-off: ${formatLocal(cutoff)} (this machine's local time).`);
  }
  const chosen = args.includeUnfinished ? found : found.filter((r) => r.finished);
  const left = found.length - chosen.length;
  if (left > 0) out(`Leaving ${left} run(s) that have not finished. Add --include-unfinished to delete them too; a run that is still going will fail.`);
  if (chosen.length === 0) {
    out(args.runId !== undefined ? "Nothing to delete." : "No runs to delete before the cut-off.");
    return args.runId !== undefined ? 1 : 0;
  }
  out(`${chosen.length} run(s)${args.yes ? "" : " would be deleted"}:`);
  for (const r of chosen) out(runLine(r));
  if (!args.yes) {
    out("Nothing was deleted. Run the same command with --yes to delete them. This cannot be undone; pnpm db export RUN_ID saves a copy first.");
    return 0;
  }
  const gone = await store.deleteRuns(chosen.map((r) => r.runId));
  out(`Deleted ${gone.length} run(s) with their events, approvals and agents.`);
  return 0;
}

/** Writes one stored run's report to DIR/RUN_ID.json. */
export async function exportRun(db: Db, runId: string, dir: string, out: (line: string) => void): Promise<number> {
  const report = await new RunStore(db).report(runId);
  if (!report) {
    out(`No run ${runId} in the database. pnpm sim dashboard lists the runs.`);
    return 1;
  }
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${runId}.json`);
  await writeFile(path, JSON.stringify(report, null, 2));
  out(`Report: ${path}`);
  return 0;
}

/** Copies report files and file logins into the database, skipping ones already there. */
export async function importFiles(db: Db, runsDir: string, usersPath: string, out: (line: string) => void): Promise<number> {
  const runs = new RunStore(db);
  let imported = 0;
  let skipped = 0;
  let files: string[] = [];
  try {
    files = (await readdir(runsDir)).filter((f) => /^[\w.-]+\.json$/.test(f) && !f.startsWith("bench-")).sort();
  } catch {
    out(`No reports folder at ${runsDir}.`);
  }
  for (const f of files) {
    let report: StoredReport & { seed: number; profile?: string };
    try {
      report = JSON.parse(await readFile(join(runsDir, f), "utf8")) as typeof report;
    } catch {
      out(`Skipped ${f}: not valid JSON.`);
      skipped++;
      continue;
    }
    if (typeof report.runId !== "string" || typeof report.seed !== "number" || !Array.isArray(report.agents)) {
      out(`Skipped ${f}: not a run report.`);
      skipped++;
      continue;
    }
    const command = report.runId.split("-")[0] ?? "unknown";
    if (await runs.importReport(report, command)) imported++;
    else skipped++;
  }
  const fileUsers = await new FileUserStore(usersPath).list();
  const users = new PgUserStore(db);
  let usersAdded = 0;
  for (const u of fileUsers) {
    if (await users.get(u.username)) continue;
    await users.put(u);
    usersAdded++;
  }
  out(`Imported ${imported} run(s); skipped ${skipped}. Imported ${usersAdded} dashboard login(s).`);
  if (usersAdded) out(`The logins are in the database now; you can delete ${usersPath}.`);
  return 0;
}

// Run when invoked directly: node dist/src/cli/db.js migrate
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  loadDotEnv();
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
