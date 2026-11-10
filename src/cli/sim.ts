import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Approver } from "../agents/hiringTools.js";
import { loadConfig, type AppConfig } from "../config/config.js";
import { PROFILES, isProfile, roleModelsFor, usesGpu, type Profile } from "../config/profiles.js";
import type { ModelTarget } from "../config/roles.js";
import { shellRunner, type CommandRunner } from "../gpu/hooks.js";
import { ensureVllm, type FetchLike } from "../gpu/vllmProbe.js";
import { AnthropicProvider } from "../models/anthropic.js";
import { LimitedProvider, Semaphore } from "../models/limiter.js";
import { OpenAiCompatibleProvider } from "../models/openaiCompatible.js";
import { ModelRouter } from "../models/router.js";
import type { ModelProvider } from "../models/types.js";
import { formatBench, summarizeBench } from "../sim/bench.js";
import { runHiringChain, type HiringReport } from "../sim/hiringChain.js";
import { newSeed } from "../sim/rng.js";
import { stubHiringProviders } from "../sim/stubHiring.js";

export const USAGE = `Usage:
  pnpm sim hiring [--models hybrid|cloud] [--stub] [--seed N] [--out DIR]
  pnpm sim bench  [--models hybrid,cloud] [--runs N] [--stub] [--out DIR]

  --models   hybrid: President and PM on Claude, other roles on your local vLLM model (default)
             cloud:  President and PM on Claude, other roles on a cheaper Claude
                     model (CLAUDE_WORKER_MODEL, default claude-sonnet-5-5); no GPU
  --runs N   bench only: runs per profile (default 3), alternating profiles
  --stub     scripted models: no API key, GPU or cost (a dry run)
  --seed N   hiring only: seed to record with the run (random if left out)
  --out DIR  where to write reports (default: runs)

Hybrid runs check vLLM first and restart it if it is busy or slow (see pnpm gpu).
The President→HR and HR→PM hires are automatic. In "hiring", any other hire asks
you here; in "bench", other hires are declined so runs stay comparable.`;

export interface SimArgs {
  command: "hiring" | "bench";
  profiles: Profile[];
  runs: number;
  stub: boolean;
  seed?: number;
  out: string;
}

function parseCount(flag: string, value: string, min: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new Error(`${flag} must be a whole number of at least ${min}, got "${value}"`);
  return n;
}

/** Parses a sim command line. Throws on anything unknown. */
export function parseSimArgs(argv: string[]): SimArgs {
  const [command, ...args] = argv;
  if (command !== "hiring" && command !== "bench") throw new Error(`Unknown command "${command ?? ""}"`);
  const parsed: SimArgs = {
    command,
    profiles: command === "bench" ? [...PROFILES] : ["hybrid"],
    runs: 3,
    stub: false,
    out: "runs",
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--stub") {
      parsed.stub = true;
      continue;
    }
    if (!["--models", "--runs", "--seed", "--out"].includes(arg)) throw new Error(`Unknown option "${arg}"`);
    const value = args[++i];
    if (value === undefined) throw new Error(`${arg} needs a value`);
    if (arg === "--out") parsed.out = value;
    else if (arg === "--seed") parsed.seed = parseCount("--seed", value, 0);
    else if (arg === "--runs") {
      if (command !== "bench") throw new Error("--runs is only for bench");
      parsed.runs = parseCount("--runs", value, 1);
    } else {
      const names = value.split(",").map((v) => v.trim());
      const bad = names.find((n) => !isProfile(n));
      if (bad !== undefined) throw new Error(`Unknown model profile "${bad}"; use ${PROFILES.join(" or ")}`);
      if (command === "hiring" && names.length !== 1) throw new Error("hiring takes one profile");
      parsed.profiles = [...new Set(names)] as Profile[];
    }
  }
  return parsed;
}

/** Asks the owner in the terminal: y approves, anything else rejects (with the text as the reason). */
export function terminalApprover(ask: (question: string) => Promise<string>): Approver {
  return async (request, proposal) => {
    const answer = (await ask(`\nApprove hire #${request.id}: ${proposal.role}, $${proposal.budgetUsd} budget?\n${request.summary}\n[y/N, or a reason to reject] `)).trim();
    return /^y(es)?$/i.test(answer) ? { approve: true } : { approve: false, reason: answer || "Rejected by owner" };
  };
}

/** Bench approver: declines every hire beyond the automatic ones, so runs do the same work. */
export const benchApprover: Approver = async () => ({ approve: false, reason: "Benchmark run: only the initial hires are made" });

/** One-line-per-item summary of a run, for the terminal. */
export function formatReport(report: HiringReport): string[] {
  return [
    `Run ${report.runId} (${report.profile}, seed ${report.seed}): ${report.outcome.toUpperCase()} in ${(report.durationMs / 1000).toFixed(1)}s. ${report.reason}`,
    ...report.agents.map(
      (a) => `  #${a.id} ${a.role}: ${a.status}, reports to ${a.managerId === null ? "owner" : `#${a.managerId}`}, budget $${a.budgetUsd}`,
    ),
    ...report.tasks.map(
      (t) => `  task ${t.actor} on ${t.model}: ${t.stop} after ${t.steps} model calls, ${(t.durationMs / 1000).toFixed(1)}s`,
    ),
    `  Claude spend: $${report.spentUsd.toFixed(4)}; ${report.approvals.length} approvals (${report.approvals.filter((a) => a.autoApproved).length} automatic); ${report.eventCount} events`,
  ];
}

export interface SimDeps {
  env?: Record<string, string | undefined>;
  out?: (line: string) => void;
  /** Providers by model target, for real (non-stub) runs; tests inject fakes. */
  providers?: Record<ModelTarget, ModelProvider>;
  approver?: Approver;
  fetchImpl?: FetchLike;
  run?: CommandRunner;
  writeReport?: (path: string, json: string) => Promise<void>;
  now?: () => Date;
}

async function defaultWrite(path: string, json: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, json);
}

/** The real providers for a profile. Cloud never builds a vLLM client. */
export function realProviders(config: AppConfig, profile: Profile): Record<ModelTarget, ModelProvider> {
  const claude = new AnthropicProvider(config.claudeModel);
  if (profile === "cloud") return { claude, local: new AnthropicProvider(config.claudeWorkerModel) };
  return {
    claude,
    local: new LimitedProvider(
      new OpenAiCompatibleProvider(config.vllmModel, { baseURL: config.vllmBaseUrl, apiKey: config.vllmApiKey }),
      new Semaphore(config.vllm.maxLanes),
    ),
  };
}

/** Runs one sim command. Returns the process exit code. */
export async function main(argv: string[], deps: SimDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  if (argv.length === 0 || argv[0] === "help") {
    out(USAGE);
    return 0;
  }
  let args: SimArgs;
  try {
    args = parseSimArgs(argv);
  } catch (err) {
    out(err instanceof Error ? err.message : String(err));
    out(USAGE);
    return 2;
  }

  const config = loadConfig(deps.env ?? process.env);
  const write = deps.writeReport ?? defaultWrite;
  const stamp = (deps.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, "-");

  if (!args.stub && args.profiles.some(usesGpu)) {
    await ensureVllm({
      baseUrl: config.vllmBaseUrl,
      model: config.vllmModel,
      stopCommand: config.vllm.stopCommand,
      startCommand: config.vllm.startCommand,
      thresholds: config.vllm,
      fetchImpl: deps.fetchImpl ?? (fetch as unknown as FetchLike),
      run: deps.run ?? shellRunner,
      log: out,
    });
  }

  const runOnce = (profile: Profile, seed: number, approver: Approver) => {
    const providers = args.stub ? stubHiringProviders(profile) : (deps.providers ?? realProviders(config, profile));
    return runHiringChain({
      runId: `hiring-${profile}-${stamp}-${seed}`,
      seed,
      profile,
      router: new ModelRouter(providers, roleModelsFor(profile)),
      approver,
      runBudgetUsd: config.runBudgetUsd,
    });
  };

  if (args.command === "bench") {
    out(`Benchmark: ${args.runs} runs each of ${args.profiles.join(", ")}${args.stub ? " with scripted models" : ""}. Claude budget: $${config.runBudgetUsd} per run.`);
    const reports: HiringReport[] = [];
    for (let i = 1; i <= args.runs; i++) {
      for (const profile of args.profiles) {
        const report = await runOnce(profile, newSeed(), deps.approver ?? benchApprover);
        reports.push(report);
        out(`  ${profile} run ${i}: ${report.outcome} in ${(report.durationMs / 1000).toFixed(1)}s, $${report.spentUsd.toFixed(4)}`);
      }
    }
    const summaries = summarizeBench(reports);
    for (const line of formatBench(summaries)) out(line);
    const path = join(args.out, `bench-${stamp}.json`);
    await write(path, JSON.stringify({ summaries, reports }, null, 2));
    out(`Report: ${path}`);
    return reports.every((r) => r.outcome === "complete") ? 0 : 1;
  }

  const profile = args.profiles[0]!;
  const seed = args.seed ?? newSeed();
  let rl: ReturnType<typeof createInterface> | undefined;
  const approver =
    deps.approver ??
    terminalApprover((q) => {
      rl ??= createInterface({ input: process.stdin, output: process.stdout });
      return rl.question(q);
    });
  out(`Starting a ${profile} hiring run${args.stub ? " with scripted models" : ""}. Claude budget: $${config.runBudgetUsd}.`);
  try {
    const report = await runOnce(profile, seed, approver);
    const path = join(args.out, `${report.runId}.json`);
    await write(path, JSON.stringify(report, null, 2));
    for (const line of formatReport(report)) out(line);
    out(`Report: ${path}`);
    return report.outcome === "complete" ? 0 : 1;
  } finally {
    rl?.close();
  }
}

// Run when invoked directly: node dist/src/cli/sim.js hiring
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
