import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USAGE, formatReport, main, parseSimArgs, terminalApprover } from "../src/cli/sim.js";
import { stubHiringProviders } from "../src/sim/stubHiring.js";
import type { ApprovalRequest } from "../src/approvals/approvals.js";
import type { AgentRecord } from "../src/agents/registry.js";
import type { HiringReport } from "../src/sim/hiringChain.js";
import { startFakeVllm } from "./fakeVllm.js";

describe("parseSimArgs", () => {
  it("reads --stub, --seed and --out", () => {
    expect(parseSimArgs([])).toEqual({ stub: false, out: "runs" });
    expect(parseSimArgs(["--stub", "--seed", "7", "--out", "x"])).toEqual({ stub: true, seed: 7, out: "x" });
  });
  it("rejects unknown flags, missing values and bad seeds", () => {
    expect(() => parseSimArgs(["--fast"])).toThrow('Unknown option "--fast"');
    expect(() => parseSimArgs(["--seed"])).toThrow("needs a value");
    expect(() => parseSimArgs(["--seed", "-1"])).toThrow("whole number");
    expect(() => parseSimArgs(["--seed", "1.5"])).toThrow("whole number");
  });
});

describe("terminalApprover", () => {
  const req = { id: 3, summary: "Hire bookkeeper" } as ApprovalRequest;
  const rec = { role: "bookkeeper", budgetUsd: 1 } as AgentRecord;
  it("approves on y or yes, in any case", async () => {
    for (const a of ["y", "YES", " y "]) expect(await terminalApprover(async () => a)(req, rec)).toEqual({ approve: true });
  });
  it("rejects otherwise, using the answer as the reason", async () => {
    expect(await terminalApprover(async () => "")(req, rec)).toEqual({ approve: false, reason: "Rejected by owner" });
    expect(await terminalApprover(async () => "too costly")(req, rec)).toEqual({ approve: false, reason: "too costly" });
  });
  it("shows the hire in the question", async () => {
    let asked = "";
    await terminalApprover(async (q) => ((asked = q), "y"))(req, rec);
    expect(asked).toContain("Approve hire #3: bookkeeper, $1 budget?");
  });
});

describe("formatReport", () => {
  it("summarises outcome, agents, tasks and spend", () => {
    const report = {
      runId: "r", seed: 1, outcome: "complete", reason: "ok", spentUsd: 0.01234, eventCount: 9,
      agents: [{ id: 1, role: "president", status: "active", managerId: null, budgetUsd: 2 }],
      tasks: [{ actor: "president#1", model: "m", stop: "done", steps: 2 }],
      approvals: [{ autoApproved: true }, { autoApproved: false }],
    } as unknown as HiringReport;
    expect(formatReport(report)).toEqual([
      "Run r (seed 1): COMPLETE. ok",
      "  #1 president: active, reports to owner, budget $2",
      "  task president#1 on m: done after 2 model calls",
      "  Claude spend: $0.0123; 2 approvals (1 automatic); 9 events",
    ]);
  });
});

describe("pnpm sim (functional)", () => {
  let dir: string;
  let lines: string[];
  const out = (l: string) => lines.push(l);
  const now = () => new Date("2026-11-10T15:00:00.000Z");
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sim-"));
    lines = [];
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("prints usage for help and unknown commands", async () => {
    expect(await main([], { out })).toBe(0);
    expect(await main(["bidding"], { out })).toBe(2);
    expect(lines[0]).toBe(USAGE);
    expect(await main(["hiring", "--nope"], { out })).toBe(2);
    expect(lines).toContain('Unknown option "--nope"');
  });

  it("runs the hiring chain with scripted models and writes the report", async () => {
    const code = await main(["hiring", "--stub", "--seed", "9", "--out", dir], { out, env: {}, now });
    expect(code).toBe(0);
    const path = join(dir, "hiring-2026-11-10T15-00-00-000Z-9.json");
    const report = JSON.parse(await readFile(path, "utf8")) as HiringReport;
    expect(report).toMatchObject({ outcome: "complete", seed: 9 });
    expect(report.agents.map((a) => a.role)).toEqual(["president", "hr", "project_manager"]);
    expect(lines[0]).toBe("Starting hiring-2026-11-10T15-00-00-000Z-9 with scripted models. Claude budget: $5.");
    expect(lines.at(-1)).toBe(`Report: ${path}`);
  });

  it("checks vLLM before a real run, restarting it when the model is missing", async () => {
    const fake = await startFakeVllm();
    try {
      const ran: string[] = [];
      const env = { VLLM_BASE_URL: fake.baseUrl, VLLM_MODEL: "not-loaded", VLLM_STOP_CMD: "stop-it", VLLM_START_CMD: "start-it" };
      const writes: string[] = [];
      const code = await main(["hiring", "--seed", "1"], {
        out, env, now,
        providers: stubHiringProviders(),
        run: async (c) => { ran.push(c); },
        writeReport: async (p) => { writes.push(p); },
      });
      expect(code).toBe(0);
      expect(ran).toEqual(["stop-it", "start-it"]);
      expect(writes).toEqual([join("runs", "hiring-2026-11-10T15-00-00-000Z-1.json")]);
    } finally {
      await fake.close();
    }
  });

  it("exits 1 when the chain is incomplete", async () => {
    const providers = stubHiringProviders();
    const fake = await startFakeVllm();
    try {
      // HR's script is replaced by one that never hires.
      const { ScriptedProvider, textResponse } = await import("../src/models/stub.js");
      providers.local = new ScriptedProvider([textResponse("Not today.")]);
      const env = { VLLM_BASE_URL: fake.baseUrl, VLLM_MODEL: "qwen" };
      const code = await main(["hiring"], { out, env, now, providers, writeReport: async () => undefined, run: async () => undefined });
      expect(code).toBe(1);
      expect(lines.find((l) => l.includes("INCOMPLETE"))).toMatch(/HR did not hire a Project Manager/);
    } finally {
      await fake.close();
    }
  });
});
