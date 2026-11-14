import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDotEnv } from "../src/config/dotenv.js";

const file = (text: string) => {
  const p = join(mkdtempSync(join(tmpdir(), "dotenv-")), ".env");
  writeFileSync(p, text);
  return p;
};

describe("loadDotEnv", () => {
  it("sets the file's variables, skipping comments and blank lines", () => {
    const env: Record<string, string | undefined> = {};
    const p = file("# Postgres\nDATABASE_URL=postgres://u:p@localhost:5432/x\n\nQUOTED=\"a b\"\n");
    expect(loadDotEnv(p, env)).toEqual(["DATABASE_URL", "QUOTED"]);
    expect(env).toEqual({ DATABASE_URL: "postgres://u:p@localhost:5432/x", QUOTED: "a b" });
  });

  it("keeps a variable that is already set", () => {
    const env: Record<string, string | undefined> = { DATABASE_URL: "from-shell" };
    expect(loadDotEnv(file("DATABASE_URL=from-file\nOTHER=1\n"), env)).toEqual(["OTHER"]);
    expect(env.DATABASE_URL).toBe("from-shell");
  });

  it("does nothing when there is no file", () => {
    const env: Record<string, string | undefined> = {};
    expect(loadDotEnv(join(tmpdir(), "no-such-dir-xyz", ".env"), env)).toEqual([]);
    expect(env).toEqual({});
  });
});
