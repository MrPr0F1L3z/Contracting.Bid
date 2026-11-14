import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FileUserStore } from "../dashboard/auth.js";
import { openDb, redactUrl, type Db } from "../db/db.js";
import { appliedMigrations, loadMigrations, migrate, migrationsDir } from "../db/migrate.js";
import { PgUserStore, RunStore, type StoredReport } from "../db/stores.js";
import { usersFile } from "./dashboardCli.js";
import { loadDotEnv } from "../config/dotenv.js";

export const DB_USAGE = `Usage:
  pnpm db migrate              apply new schema migrations (db/migrations); runs do this themselves too
  pnpm db status               show which migrations are applied
  pnpm db import [--out DIR]   copy saved reports (default runs/) and dashboard logins from files into the database
  pnpm db export RUN_ID [--out DIR]   write one run's report to DIR/RUN_ID.json (default runs/), to share it

Uses DATABASE_URL, for example postgres://contracting:contracting@localhost:5432/contracting.`;

export interface DbDeps {
  env?: Record<string, string | undefined>;
  out?: (line: string) => void;
  db?: Db;
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
export function parseDbArgs(command: string, rest: string[]): { runsDir: string; runId?: string } | null {
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
