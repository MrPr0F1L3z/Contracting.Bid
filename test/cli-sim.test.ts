import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USAGE, benchApprover, formatReport, main, parseSimArgs, realProviders, terminalApprover } from "../src/cli/sim.js";
import { loadConfig } from "../src/config/config.js";
import { stubHiringProviders } from "../src/sim/stubHiring.js";
import { ScriptedProvider, textResponse } from "../src/models/stub.js";
import type { ApprovalRequest } from "../src/approvals/approvals.js";
import type { AgentRecord } from "../src/agents/registry.js";
import type { HiringReport } from "../src/sim/hiringChain.js";
import type { ProfileSummary } from "../src/sim/bench.js";
import { startFakeVllm } from "./fakeVllm.js";

describe("parseSimArgs", () => {
  it("defaults: hiring uses hybrid, bench compares both profiles 3 times", () => {
    expect(parseSimArgs(["hiring"])).toEqual({ command: "hiring", profiles: ["hybrid"], runs: 3, stub: false, out: "runs" });
    expect(parseSimArgs(["bench"])).toMatchObject({ command: "bench", profiles: ["hybrid", "cloud"], runs: 3 });
  });
  it("reads every flag", () => {
    expect(parseSimArgs(["hiring", "--models", "cloud", "--stub", "--seed", "7", "--out", "x"])).toEqual({
      command: "hiring", profiles: ["cloud"], runs: 3, stub: true, seed: 7, out: "x",
    });
    expect(parseSimArgs(["bench", "--models", "cloud, cloud", "--runs", "5"])).toMatchObject({ profiles: ["cloud"], runs: 5 });
  });
  it("rejects bad commands, flags, values and profiles", () => {
    expect(() => parseSimArgs(["bidding"])).toThrow('Unknown command "bidding"');
    expect(() => parseSimArgs(["hiring", "--fast"])).toThrow('Unknown option "--fast"');
    expect(() => parseSimArgs(["hiring", "--seed"])).toThrow("needs a value");
    expect(() => parseSimArgs(["hiring", "--seed", "-1"])).toThrow("at least 0");
    expect(() => parseSimArgs(["bench", "--runs", "0"])).toThrow("at least 1");
    expect(() => parseSimArgs(["hiring", "--runs", "2"])).toThrow("only for bench");
    expect(() => parseSimArgs(["hiring", "--models", "gpu"])).toThrow('Unknown model profile "gpu"');
    expect(() => parseSimArgs(["hiring", "--models", "hybrid,cloud"])).toThrow("one profile");
  });
});

describe("approvers", () => {
  const req = { id: 3, summary: "Hire bookkeeper" } as ApprovalRequest;
  const rec = { role: "bookkeeper", budgetUsd: 1 } as AgentRecord;
  it("terminalApprover approves on y or yes, in any case", async () => {
    for (const a of ["y", "YES", " y "]) expect(await terminalApprover(async () => a)(req, rec)).toEqual({ approve: true });
  });
  it("terminalApprover rejects otherwise, using the answer as the reason, and shows the hire", async () => {
    expect(await terminalApprover(async () => "")(req, rec)).toEqual({ approve: false, reason: "Rejected by owner" });
    let asked = "";
    expect(await terminalApprover(async (q) => ((asked = q), "too costly"))(req, rec)).toEqual({ approve: false, reason: "too costly" });
    expect(asked).toContain("Approve hire #3: bookkeeper, $1 budget?");
  });
  it("benchApprover declines every extra hire", async () => {
    expect(await benchApprover(req, rec)).toMatchObject({ approve: false });
  });
});

describe("realProviders", () => {
  const config = loadConfig({ ANTHROPIC_API_KEY: "test" });
  it("cloud puts the worker target on the cheaper Claude model and never builds a vLLM client", () => {
    const p = realProviders(config, "cloud");
    expect([p.claude.name, p.claude.model]).toEqual(["anthropic", "claude-opus-5-5"]);
    expect([p.local.name, p.local.model]).toEqual(["anthropic", "claude-sonnet-5-5"]);
    expect(realProviders(loadConfig({ CLAUDE_WORKER_MODEL: "claude-haiku-5-5" }), "cloud").local.model).toBe("claude-haiku-5-5");
  });
  it("hybrid puts the local target on the lane-limited vLLM model", () => {
    const p = realProviders(config, "hybrid");
    expect(p.local.name).toBe("vllm");
    expect(p.local.model).toBe(config.vllmModel);
  });
});

describe("formatReport", () => {
  it("summarises outcome, timing, agents, tasks and spend", () => {
    const report = {
      runId: "r", seed: 1, profile: "cloud", durationMs: 12_340, outcome: "complete", reason: "ok", spentUsd: 0.01234, eventCount: 9,
      agents: [{ id: 1, role: "president", status: "active", managerId: null, budgetUsd: 2 }],
      tasks: [{ actor: "president#1", model: "m", stop: "done", steps: 2, durationMs: 5_000 }],
      approvals: [{ autoApproved: true }, { autoApproved: false }],
    } as unknown as HiringReport;
    expect(formatReport(report)).toEqual([
      "Run r (cloud, seed 1): COMPLETE in 12.3s. ok",
      "  #1 president: active, reports to owner, budget $2",
      "  task president#1 on m: done after 2 model calls, 5.0s",
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

  it("prints usage for help, and exits 2 on bad input", async () => {
    expect(await main([], { out })).toBe(0);
    expect(lines[0]).toBe(USAGE);
    expect(await main(["bidding"], { out })).toBe(2);
    expect(await main(["hiring", "--nope"], { out })).toBe(2);
    expect(lines).toContain('Unknown option "--nope"');
  });

  for (const profile of ["hybrid", "cloud"] as const) {
    it(`runs a ${profile} hiring chain with scripted models and writes the report`, async () => {
      const code = await main(["hiring", "--models", profile, "--stub", "--seed", "9", "--out", dir], { out, env: {}, now });
      expect(code).toBe(0);
      const path = join(dir, `hiring-${profile}-2026-11-10T15-00-00-000Z-9.json`);
      const report = JSON.parse(await readFile(path, "utf8")) as HiringReport;
      expect(report).toMatchObject({ outcome: "complete", seed: 9, profile });
      expect(report.tasks.map((t) => t.model)).toEqual(profile === "cloud" ? ["stub-claude", "stub-claude-worker"] : ["stub-claude", "stub-local"]);
      expect(lines.at(-1)).toBe(`Report: ${path}`);
    });
  }

  it("a cloud run never touches vLLM", async () => {
    const ran: string[] = [];
    let fetched = 0;
    const code = await main(["hiring", "--models", "cloud"], {
      out, env: {}, now,
      providers: stubHiringProviders("cloud"),
      run: async (c) => { ran.push(c); },
      fetchImpl: async () => { fetched++; throw new Error("no GPU calls in cloud mode"); },
      writeReport: async () => undefined,
    });
    expect(code).toBe(0);
    expect(ran).toEqual([]);
    expect(fetched).toBe(0);
  });

  it("a hybrid run checks vLLM first, restarting it when the model is missing", async () => {
    const fake = await startFakeVllm();
    try {
      const ran: string[] = [];
      const writes: string[] = [];
      const env = { VLLM_BASE_URL: fake.baseUrl, VLLM_MODEL: "not-loaded", VLLM_STOP_CMD: "stop-it", VLLM_START_CMD: "start-it" };
      const code = await main(["hiring", "--seed", "1"], {
        out, env, now, providers: stubHiringProviders(), run: async (c) => { ran.push(c); }, writeReport: async (p) => { writes.push(p); },
      });
      expect(code).toBe(0);
      expect(ran).toEqual(["stop-it", "start-it"]);
      expect(writes).toEqual([join("runs", "hiring-hybrid-2026-11-10T15-00-00-000Z-1.json")]);
    } finally {
      await fake.close();
    }
  });

  it("exits 1 when the chain is incomplete", async () => {
    const providers = stubHiringProviders("cloud");
    providers.claude = new ScriptedProvider([textResponse("Not today.")]);
    expect(providers.local.model).toBe("stub-claude-worker");
    const code = await main(["hiring", "--models", "cloud"], { out, env: {}, now, providers, writeReport: async () => undefined });
    expect(code).toBe(1);
    expect(lines.find((l) => l.includes("INCOMPLETE"))).toMatch(/did not hire HR/);
  });

  it("bench alternates profiles, compares them and writes one report", async () => {
    const code = await main(["bench", "--stub", "--runs", "2", "--out", dir], { out, env: {}, now });
    expect(code).toBe(0);
    expect(lines.filter((l) => / run \d: /.test(l)).map((l) => l.trim().split(":")[0])).toEqual([
      "hybrid run 1", "cloud run 1", "hybrid run 2", "cloud run 2",
    ]);
    expect(lines.some((l) => l.startsWith("cloud is "))).toBe(true);
    const saved = JSON.parse(await readFile(join(dir, "bench-2026-11-10T15-00-00-000Z.json"), "utf8")) as {
      summaries: ProfileSummary[];
      reports: HiringReport[];
    };
    expect(saved.summaries.map((s) => [s.profile, s.runs, s.complete])).toEqual([["hybrid", 2, 2], ["cloud", 2, 2]]);
    expect(saved.reports).toHaveLength(4);
  });
});
