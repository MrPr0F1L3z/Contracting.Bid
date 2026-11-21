import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STACK_USAGE, main, parseStackArgs, spawnExec, stateDir } from "../src/cli/stack.js";

describe("pnpm stack", () => {
  it("parses its commands", () => {
    expect(parseStackArgs(["status"])).toEqual({ command: "status", yes: false, outsideWindow: false });
    expect(parseStackArgs(["deploy", "staging"])).toEqual({ command: "deploy", yes: false, outsideWindow: false });
    expect(parseStackArgs(["deploy", "staging", "--ref", "main"])).toEqual({ command: "deploy", ref: "main", yes: false, outsideWindow: false });
    expect(parseStackArgs(["test", "staging"])).toMatchObject({ command: "test" });
    expect(parseStackArgs(["promote"])).toMatchObject({ command: "promote", yes: false, outsideWindow: false });
    expect(parseStackArgs(["promote", "prod", "--ref", "abc", "--yes", "--outside-window"])).toEqual({ command: "promote", ref: "abc", yes: true, outsideWindow: true });
  });

  it("parses user commands for a stack", () => {
    expect(parseStackArgs(["user", "prod", "add", "owner"])).toEqual({ command: "user", stack: "prod", userArgs: ["add", "owner"], yes: false, outsideWindow: false });
    expect(parseStackArgs(["user", "dev", "list"])).toBeNull();
    expect(parseStackArgs(["user", "staging"])).toBeNull();
  });

  it("runs a user command in the stack's container, attached to the terminal", async () => {
    const lines: string[] = [];
    const calls: string[][] = [];
    const exec = async () => ({ code: 0, stdout: "", stderr: "" });
    expect(await main(["user", "staging", "list"], { out: (l) => void lines.push(l), exec, env: {}, stateDir: "/nonexistent", interactive: async (_c, a) => (calls.push(a), 0) })).toBe(2);
    expect(lines).toEqual(["Nothing is deployed to staging yet, so it has no database. Deploy it first (pnpm stack status)."]);
    expect(calls).toEqual([]);
  });

  it("rejects anything else", () => {
    for (const bad of [[], ["deploy"], ["deploy", "prod"], ["deploy", "staging", "--yes"], ["deploy", "staging", "--ref"], ["deploy", "staging", "--ref", "--yes"], ["test", "staging", "--ref", "x"], ["status", "--yes"], ["promote", "staging"], ["promote", "--force"], ["rollback"]]) {
      expect(parseStackArgs(bad)).toBeNull();
    }
  });

  it("keeps its files outside the checkout by default", () => {
    expect(stateDir({ STACKS_DIR: "/data/stacks" })).toBe("/data/stacks");
    expect(stateDir({ XDG_DATA_HOME: "/x" })).toBe("/x/contracting-bid/stacks");
    expect(stateDir({ HOME: "/home/owner" })).toBe("/home/owner/.local/share/contracting-bid/stacks");
  });

  it("prints its usage", async () => {
    const lines: string[] = [];
    expect(await main([], { out: (l) => void lines.push(l) })).toBe(0);
    expect(await main(["nonsense"], { out: (l) => void lines.push(l) })).toBe(2);
    expect(lines).toEqual([STACK_USAGE, STACK_USAGE]);
  });

  it("reports an error instead of crashing", async () => {
    const lines: string[] = [];
    const code = await main(["deploy", "staging", "--ref", "nope"], {
      out: (l) => void lines.push(l),
      exec: async () => ({ code: 128, stdout: "", stderr: "fatal" }),
      env: {},
      stateDir: "/nonexistent",
    });
    expect(code).toBe(1);
    expect(lines).toEqual(['"nope" is not a commit in this repository.']);
  });

  it("runs programs without a shell, keeps their output, or writes it to a file (functional)", async () => {
    expect(await spawnExec("node", ["-e", "process.stdout.write('out;$HOME'); process.stderr.write('err'); process.exit(4)"])).toEqual({ code: 4, stdout: "out;$HOME", stderr: "err" });
    expect(await spawnExec("node", ["-e", "process.stdout.write(process.env.ONLY ?? 'none')"], { env: { ONLY: "this", PATH: process.env.PATH! } })).toMatchObject({ code: 0, stdout: "this" });
    const dir = await mkdtemp(join(tmpdir(), "spawn-"));
    const file = join(dir, "dump.sql");
    expect(await spawnExec("node", ["-e", "process.stdout.write('-- dump')"], { stdoutFile: file })).toMatchObject({ code: 0, stdout: "" });
    expect(await readFile(file, "utf8")).toBe("-- dump");
    expect((await spawnExec("/no/such/program", [])).code).toBe(127);
    await rm(dir, { recursive: true, force: true });
  });
});
