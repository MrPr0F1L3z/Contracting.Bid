import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main as dbMain } from "../src/cli/db.js";
import { claimDatabase, databaseStack, refuseOtherStack } from "../src/db/stackIdentity.js";
import { MIGRATIONS, migratedDb, pgliteDb } from "./helpers/pgliteDb.js";

describe("which stack a database belongs to (functional, embedded Postgres)", () => {
  it("is claimed by the first stack and refused to any other", async () => {
    const db = await migratedDb();
    expect(await databaseStack(db)).toBeNull();
    await claimDatabase(db, "staging");
    await claimDatabase(db, "staging");
    expect(await databaseStack(db)).toBe("staging");
    await expect(claimDatabase(db, "prod")).rejects.toThrow("This database belongs to the staging stack, but APP_STACK is prod.");
    await expect(refuseOtherStack(db, "prod")).rejects.toThrow("belongs to the staging stack");
    await refuseOtherStack(db, "staging");
    await expect(db.query("INSERT INTO stack_identity (only_row, stack) VALUES (false, 'dev')")).rejects.toThrow();
    await db.close();
  }, 30_000);

  it("lets any stack through a database that has no migrations yet", async () => {
    const db = pgliteDb();
    await refuseOtherStack(db, "prod");
    await db.close();
  }, 30_000);

  it("pnpm db migrate claims the database, and prod refuses pnpm db import", async () => {
    const db = await migratedDb();
    const dir = await mkdtemp(join(tmpdir(), "stackid-"));
    const lines: string[] = [];
    const out = (l: string) => void lines.push(l);
    const env = { MIGRATIONS_DIR: MIGRATIONS, DASHBOARD_USERS_FILE: join(dir, "users.json") };
    expect(await dbMain(["migrate"], { out, env: { ...env, APP_STACK: "prod" }, db })).toBe(0);
    expect(await databaseStack(db)).toBe("prod");
    lines.length = 0;
    expect(await dbMain(["import", "--out", dir], { out, env: { ...env, APP_STACK: "prod" }, db })).toBe(3);
    expect(lines).toEqual(["The prod stack holds no sim data, so pnpm db import is turned off there."]);
    lines.length = 0;
    expect(await dbMain(["migrate"], { out, env: { ...env, APP_STACK: "staging" }, db })).toBe(1);
    expect(lines).toEqual(["This database belongs to the prod stack, but APP_STACK is staging. Point DATABASE_URL at the staging database."]);
    lines.length = 0;
    expect(await dbMain(["status"], { out, env: { ...env, APP_STACK: "bad" }, db })).toBe(2);
    expect(lines).toEqual(['APP_STACK must be one of dev, staging, prod, not "bad"']);
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }, 30_000);
});
