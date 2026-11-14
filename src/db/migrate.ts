import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "./db.js";

const MIGRATION_FILE = /^(\d{3})_[\w-]+\.sql$/;

export interface Migration {
  name: string;
  sql: string;
}

/** The migration files in a folder, in order. */
export async function loadMigrations(dir: string): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => MIGRATION_FILE.test(f)).sort();
  const numbers = files.map((f) => f.slice(0, 3));
  const dup = numbers.find((n, i) => numbers.indexOf(n) !== i);
  if (dup) throw new Error(`Two migrations are numbered ${dup}`);
  return Promise.all(files.map(async (name) => ({ name, sql: await readFile(join(dir, name), "utf8") })));
}

async function ensureTable(db: Db): Promise<void> {
  const exists = await db.query<{ t: string | null }>("SELECT to_regclass('public.schema_migrations')::text AS t");
  if (exists.rows[0]?.t) return;
  await db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  // A database made before migrations were tracked (the container used to apply 001 on first start)
  // already has 001's tables; record it as applied instead of running it again.
  const old = await db.query<{ t: string | null }>("SELECT to_regclass('public.companies')::text AS t");
  if (old.rows[0]?.t) await db.query("INSERT INTO schema_migrations (name) VALUES ('001_init.sql')");
}

/** Names of the migrations already applied. */
export async function appliedMigrations(db: Db): Promise<string[]> {
  await ensureTable(db);
  return (await db.query<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name")).rows.map((r) => r.name);
}

/** Migrations not yet applied, in order. */
export async function pendingMigrations(db: Db, migrations: Migration[]): Promise<Migration[]> {
  const done = new Set(await appliedMigrations(db));
  return migrations.filter((m) => !done.has(m.name));
}

/**
 * Applies every pending migration in one transaction and returns the names applied. If any of
 * them fails, all of them are rolled back, so the database is left exactly as it was.
 */
export async function migrate(db: Db, migrations: Migration[]): Promise<string[]> {
  const pending = await pendingMigrations(db, migrations);
  if (!pending.length) return [];
  await db.transaction(async (tx) => {
    for (const m of pending) {
      try {
        await tx.exec(m.sql);
      } catch (err) {
        throw new Error(`Migration ${m.name} failed, so none were applied: ${err instanceof Error ? err.message : String(err)}`);
      }
      await tx.query("INSERT INTO schema_migrations (name) VALUES ($1)", [m.name]);
    }
  });
  return pending.map((m) => m.name);
}

/** The migrations folder: MIGRATIONS_DIR, or db/migrations under the folder the command runs in. */
export function migrationsDir(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): string {
  return env.MIGRATIONS_DIR || join(cwd, "db", "migrations");
}
