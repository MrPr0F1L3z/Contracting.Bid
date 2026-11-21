import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger, type Deployment } from "../src/deploy/ledger.js";

const dep = (over: Partial<Deployment>): Deployment => ({ stack: "staging", build: "aaaaaaaaaaaa", at: "2026-11-21T00:00:00.000Z", result: "pass", steps: [], ...over });

describe("deploy ledger", () => {
  let dir: string;
  beforeEach(async () => (dir = await mkdtemp(join(tmpdir(), "ledger-"))));
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it("starts empty and keeps deploys in order", async () => {
    const l = new Ledger(join(dir, "sub", "ledger.json"));
    expect(await l.all()).toEqual([]);
    expect(await l.latest("staging")).toBeNull();
    expect(await l.running("prod")).toBeNull();
    await l.add(dep({ build: "a" }));
    await l.add(dep({ build: "b", result: "fail" }));
    expect((await l.all()).map((d) => d.build)).toEqual(["a", "b"]);
    expect(JSON.parse(await readFile(join(dir, "sub", "ledger.json"), "utf8")).deployments).toHaveLength(2);
  });

  it("knows what passed and what each stack runs", async () => {
    const l = new Ledger(join(dir, "ledger.json"));
    await l.add(dep({ build: "a" }));
    await l.add(dep({ build: "b", result: "fail" }));
    expect(await l.passed("staging", "a")).toBe(true);
    expect(await l.passed("staging", "b")).toBe(false);
    expect(await l.passed("prod", "a")).toBe(false);
    expect(await l.latestPass("staging")).toBe("a");
    // A failed staging deploy still leaves that build on staging.
    expect(await l.running("staging")).toBe("b");
    await l.add(dep({ stack: "prod", build: "a" }));
    await l.add(dep({ stack: "prod", build: "c", result: "fail", previous: "a", rolledBack: true }));
    expect(await l.running("prod")).toBe("a");
    await l.add(dep({ stack: "prod", build: "d", result: "fail", previous: "a", rolledBack: false }));
    expect(await l.running("prod")).toBe("d");
    await l.add(dep({ stack: "prod", build: "e", result: "fail", previous: "d", runningAfter: "d" }));
    expect(await l.running("prod")).toBe("d");
  });

  it("says so when the file is damaged", async () => {
    const path = join(dir, "ledger.json");
    await writeFile(path, "{not json");
    await expect(new Ledger(path).all()).rejects.toThrow(/Cannot read the deploy ledger/);
    await writeFile(path, "{}");
    expect(await new Ledger(path).all()).toEqual([]);
  });
});
