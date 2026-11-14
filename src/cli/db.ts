import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FileUserStore } from "../dashboard/auth.js";
import { openDb, redactUrl, type Db } from "../db/db.js";
import { appliedMigrations, loadMigrations, migrate, migrationsDir, pendingMigrations } from "../db/migrate.js";
import { PgUserStore, RunStore, type StoredReport } from "../db/stores.js";
import { usersFile } from "./dashboardCli.js";
import { loadDotEnv } from "../config/dotenv.js";

export const DB_USAGE = `Usage:
  pnpm db migrate          apply new schema migrations (db/migrations)
  pnpm db status           show which migrations are applied
  pnpm db import [--out DIR]   copy saved reports (default runs/) and dashboard logins from files into the database

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
  let runsDir = "runs";
  if (command === "import" && rest.length === 2 && rest[0] === "--out") runsDir = rest[1]!;
  else if (rest.length > 0 || !["migrate", "status", "import"].includes(command)) {
    out(DB_USAGE);
    return 2;
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
    if (command === "migrate") {
      const applied = await migrate(db, migrations);
      out(applied.length ? `Applied ${applied.join(", ")}.` : "The database is up to date.");
      return 0;
    }
    if ((await pendingMigrations(db, migrations)).length) {
      out("Run pnpm db migrate first.");
      return 2;
    }
    return await importFiles(db, runsDir, usersFile(env), out);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    out(env.DATABASE_URL ? `${msg} (database ${redactUrl(env.DATABASE_URL)})` : msg);
    return 1;
  } finally {
    if (!deps.db) await db.close();
  }
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
