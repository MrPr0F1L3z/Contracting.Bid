import { PGlite, type Transaction } from "@electric-sql/pglite";
import type { Db } from "../../src/db/db.js";
import { loadMigrations, migrate } from "../../src/db/migrate.js";

type Runner = Pick<PGlite, "query" | "exec"> | Transaction;

function wrap(r: Runner, inTx: boolean, pg: PGlite): Db {
  const db: Db = {
    query: async <T>(sql: string, params: unknown[] = []) => {
      const res = await r.query<T>(sql, params);
      return { rows: res.rows, rowCount: Math.max(res.rows.length, res.affectedRows ?? 0) };
    },
    exec: async (sql) => void (await r.exec(sql)),
    transaction: (fn) => (inTx ? fn(db) : pg.transaction((tx) => fn(wrap(tx, true, pg)))),
    close: async () => (inTx ? undefined : pg.close()),
  };
  return db;
}

/** An embedded Postgres behind the app's Db interface, for tests. */
export function pgliteDb(pg = new PGlite()): Db & { pg: PGlite } {
  return Object.assign(wrap(pg, false, pg), { pg });
}

export const MIGRATIONS = new URL("../../db/migrations/", import.meta.url).pathname;

/** A fresh embedded database with every migration applied. */
export async function migratedDb(): Promise<Db & { pg: PGlite }> {
  const db = pgliteDb();
  await migrate(db, await loadMigrations(MIGRATIONS));
  return db;
}
