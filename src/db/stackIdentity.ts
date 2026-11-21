import type { Stack } from "../config/stack.js";
import type { Db } from "./db.js";

/** The stack a database belongs to, or null when nothing has claimed it yet. */
export async function databaseStack(db: Db): Promise<Stack | null> {
  const r = await db.query<{ stack: Stack }>("SELECT stack FROM stack_identity");
  return r.rows[0]?.stack ?? null;
}

/**
 * Records that the database belongs to `stack`, the first time. Throws when it
 * already belongs to another stack. Needs migration 004.
 */
export async function claimDatabase(db: Db, stack: Stack): Promise<void> {
  await db.query("INSERT INTO stack_identity (stack) VALUES ($1) ON CONFLICT (only_row) DO NOTHING", [stack]);
  const owner = await databaseStack(db);
  if (owner !== stack) {
    throw new Error(`This database belongs to the ${owner} stack, but APP_STACK is ${stack}. Point DATABASE_URL at the ${stack} database.`);
  }
}

/**
 * Throws when the database already belongs to another stack. Safe to call
 * before migrations run (a database without the table belongs to no stack
 * yet), so a wrong DATABASE_URL is caught before anything is written.
 */
export async function refuseOtherStack(db: Db, stack: Stack): Promise<void> {
  const t = await db.query<{ t: string | null }>("SELECT to_regclass('public.stack_identity')::text AS t");
  if (!t.rows[0]?.t) return;
  const owner = await databaseStack(db);
  if (owner !== null && owner !== stack) {
    throw new Error(`This database belongs to the ${owner} stack, but APP_STACK is ${stack}. Point DATABASE_URL at the ${stack} database.`);
  }
}
