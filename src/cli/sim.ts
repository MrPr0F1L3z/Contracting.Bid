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
import { runBidChain, type BidReport } from "../sim/bidChain.js";
import { runJobChain, type JobReport } from "../sim/jobChain.js";
import { stubJobProviders } from "../sim/stubJob.js";
import { COMPLEXITIES, type Complexity } from "../opportunities/types.js";
import { newSeed } from "../sim/rng.js";
import { STUB_BID_JOB, stubBidProviders } from "../sim/stubBid.js";
import { stubHiringProviders } from "../sim/stubHiring.js";

export const USAGE = `Usage:
  pnpm sim hiring [--models hybrid|cloud] [--stub] [--seed N] [--out DIR]
  pnpm sim bench  [--models hybrid,cloud] [--runs N] [--stub] [--out DIR]
  pnpm sim bid    [--models hybrid|cloud] [--job ID | --complexity easy|moderate|complex]
                  [--auto-approve] [--stub] [--seed N] [--out DIR]
  pnpm sim job    the same flags as bid, plus [--force-award]

  --models   hybrid: President and PM on Claude, other roles on your local vLLM model
             cloud:  President and PM on Claude, other roles on a cheaper Claude
                     model (CLAUDE_WORKER_MODEL, default claude-sonnet-5-5); no GPU (default)
  --runs N   bench only: runs per profile (default 3), alternating profiles
  --stub     scripted models: no API key, GPU or cost (a dry run)
  --seed N   hiring and bid: the run's seed (random if left out); a bid run replays from it
  --job ID   bid only: bid this solicitation (default: picked by seed)
  --complexity  bid only: pick only among jobs at this complexity
  --auto-approve  bid and job: approve every owner gate without asking (simulation only)
  --force-award   job only: if a responsive bid loses on price, award it anyway (simulation only)
  --out DIR  where to write reports (default: runs)

Hybrid runs (opt in with --models hybrid) check vLLM first and restart it if it is busy or slow (see pnpm gpu).
The President→HR and HR→PM hires are automatic. In "hiring", any other hire asks
you here; in "bench", other hires are declined so runs stay comparable. In "bid", pursuing
the job, each later hire and the bid price ask you here unless you pass --auto-approve.
"job" bids, then runs an awarded job: contracts, a Scheduler hire, and each site problem
the seed brings, ending with the job's final account. A stub bid or job run always bids
${STUB_BID_JOB} and approves every gate.`;

export interface SimArgs {
  command: "hiring" | "bench" | "bid" | "job";
  forceAward?: boolean;
  profiles: Profile[];
  runs: number;
  stub: boolean;
  seed?: number;
  out: string;
  job?: string;
  complexity?: Complexity;
  autoApprove?: boolean;
}

function parseCount(flag: string, value: string, min: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new Error(`${flag} must be a whole number of at least ${min}, got "${value}"`);
  return n;
}

/** Parses a sim command line. Throws on anything unknown. */
export function parseSimArgs(argv: string[]): SimArgs {
  const [command, ...args] = argv;
  if (command !== "hiring" && command !== "bench" && command !== "bid" && command !== "job") throw new Error(`Unknown command "${command ?? ""}"`);
  const bidLike = command === "bid" || command === "job";
  const parsed: SimArgs = {
    command,
    profiles: command === "bench" ? [...PROFILES] : ["cloud"],
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
    if (arg === "--force-award") {
      if (command !== "job") throw new Error("--force-award is only for job");
      parsed.forceAward = true;
      continue;
    }
    if (arg === "--auto-approve") {
      if (!bidLike) throw new Error("--auto-approve is only for bid and job");
      parsed.autoApprove = true;
      continue;
    }
    if (!["--models", "--runs", "--seed", "--out", "--job", "--complexity"].includes(arg)) throw new Error(`Unknown option "${arg}"`);
    const value = args[++i];
    if (value === undefined) throw new Error(`${arg} needs a value`);
    if (arg === "--out") parsed.out = value;
    else if (arg === "--job" || arg === "--complexity") {
      if (!bidLike) throw new Error(`${arg} is only for bid and job`);
      if (arg === "--job") parsed.job = value;
      else if ((COMPLEXITIES as readonly string[]).includes(value)) parsed.complexity = value as Complexity;
      else throw new Error(`Unknown complexity "${value}"; use ${COMPLEXITIES.join(", ")}`);
    }
    else if (arg === "--seed") parsed.seed = parseCount("--seed", value, 0);
    else if (arg === "--runs") {
      if (command !== "bench") throw new Error("--runs is only for bench");
      parsed.runs = parseCount("--runs", value, 1);
    } else {
      const names = value.split(",").map((v) => v.trim());
      const bad = names.find((n) => !isProfile(n));
      if (bad !== undefined) throw new Error(`Unknown model profile "${bad}"; use ${PROFILES.join(" or ")}`);
      if (command !== "bench" && names.length !== 1) throw new Error(`${command} takes one profile`);
      parsed.profiles = [...new Set(names)] as Profile[];
    }
  }
  if (parsed.job !== undefined && parsed.complexity !== undefined) throw new Error("Use --job or --complexity, not both");
  if (parsed.stub && bidLike) {
    if (parsed.job !== undefined && parsed.job !== STUB_BID_JOB) throw new Error(`A stub bid run only bids ${STUB_BID_JOB}`);
    if (parsed.complexity !== undefined && parsed.complexity !== "easy") throw new Error(`A stub bid run only bids ${STUB_BID_JOB} (easy)`);
  }
  return parsed;
}

/** Asks the owner in the terminal: y approves, anything else rejects (with the text as the reason). */
export function terminalApprover(ask: (question: string) => Promise<string>): Approver {
  return async (request) => {
    const amount = request.amountUsd === undefined ? "" : `, $${request.amountUsd.toLocaleString("en-US")}`;
    const answer = (await ask(`\nApprove ${request.gate} #${request.id} from ${request.requestedBy}${amount}?\n${request.summary}\n[y/N, or a reason to reject] `)).trim();
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

/** Approves every gate. Only for simulations the owner opts into with --auto-approve. */
export const autoApprover: Approver = async () => ({ approve: true, reason: "Auto-approved by the owner (--auto-approve)" });

const money = (n: number) => `$${n.toLocaleString("en-US")}`;

/** One-line-per-item summary of a bid run, for the terminal. */
export function formatBidReport(report: BidReport): string[] {
  const opp = report.opportunity;
  const lines = [
    `Run ${report.runId} (${report.profile}, seed ${report.seed}): ${report.outcome.toUpperCase().replace("_", " ")} in ${(report.durationMs / 1000).toFixed(1)}s. ${report.reason}`,
    opp ? `  Job: ${opp.noticeId} "${opp.title}" (${opp.complexity ?? "unrated"})` : "  Job: none picked",
    `  Problems drawn: ${report.problems.join(", ") || "none"}${report.injected ? `; in bidding: ${report.injected.id} on ${report.injected.trade}` : ""}`,
  ];
  if (report.estimate) {
    const total = report.estimate.lines.reduce((a, l) => a + l.costUsd, 0);
    lines.push(`  Estimate: ${report.estimate.lines.map((l) => l.trade).join(", ")}; ${money(total)}`);
  }
  if (report.selected.length > 0) {
    lines.push(`  Quotes: ${report.selected.map((q) => `${q.quoteId} ${money(q.priceUsd)}${q.repricedFromUsd !== undefined ? ` (re-quoted from ${money(q.repricedFromUsd)})` : ""}`).join("; ")}`);
  }
  if (report.bid) {
    const margin = report.marginUsd ?? 0;
    lines.push(`  Bid: ${money(report.bid.priceUsd)}, ${report.bid.ownerApproved ? "approved" : "rejected"} by owner; ${margin >= 0 ? "margin" : "BELOW COST by"} ${money(Math.abs(margin))} over selected quotes`);
  }
  if (report.award) lines.push(`  Competitors: ${report.award.competitors.map(money).join(", ")}`);
  lines.push(`  Claude spend: $${report.spentUsd.toFixed(4)}; ${report.approvals.length} approvals (${report.approvals.filter((a) => a.autoApproved).length} automatic); ${report.eventCount} events`);
  return lines;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One-line-per-item summary of a job run: the bid lines, then the job's execution and final account. */
export function formatJobReport(report: JobReport): string[] {
  const bidLines = formatBidReport({ ...report, outcome: report.outcome === "completed" ? "awarded" : report.outcome } as BidReport);
  const head = bidLines[0]!.replace(/: AWARDED in/, ": COMPLETED in");
  const lines = [head, ...bidLines.slice(1, -1)];
  if (report.awardForced) lines.push("  Award FORCED for simulation: the bid lost on price");
  if (report.schedule) lines.push(`  Schedule: ${report.schedule.map((l) => `${l.trade} ${plural(l.days, "day")}`).join(", ")}`);
  for (const r of report.resolutions) {
    const co = r.changeOrder ? `; change order ${money(r.changeOrder.priceUsd)} and ${plural(r.changeOrder.days, "day")}` : r.changeOrder === null ? "; no change order" : "";
    lines.push(`  Problem ${r.problemId} (${r.trade}): ${r.choice}, cost ${money(r.costUsd)}, ${plural(r.days, "day")}${co}`);
  }
  const a = report.account;
  if (a) {
    lines.push(`  Time: ${a.actualDays} of ${a.contractDays} working days${a.daysLate > 0 ? `, ${plural(a.daysLate, "day")} late (${money(a.liquidatedDamagesUsd)} liquidated damages)` : ", on time"}`);
    lines.push(`  Money: revenue ${money(a.revenueUsd)}, cost ${money(a.costUsd)}, profit ${a.profitUsd < 0 ? "-" : ""}${money(Math.abs(a.profitUsd))}`);
  }
  lines.push(bidLines.at(-1)!);
  return lines;
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
  if (args.command === "bid" || args.command === "job") return runBid(args, profile, seed, config, stamp, write, out, deps);
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

async function runBid(
  args: SimArgs,
  profile: Profile,
  seed: number,
  config: AppConfig,
  stamp: string,
  write: (path: string, json: string) => Promise<void>,
  out: (line: string) => void,
  deps: SimDeps,
): Promise<number> {
  const isJob = args.command === "job";
  const stubs = isJob ? stubJobProviders(profile) : stubBidProviders(profile);
  const providers = args.stub ? stubs : (deps.providers ?? realProviders(config, profile));
  let rl: ReturnType<typeof createInterface> | undefined;
  const approver =
    args.stub || args.autoApprove
      ? autoApprover
      : (deps.approver ??
        terminalApprover((q) => {
          rl ??= createInterface({ input: process.stdin, output: process.stdout });
          return rl.question(q);
        }));
  const job = args.stub ? STUB_BID_JOB : args.job;
  out(`Starting a ${profile} ${args.command} run${args.stub ? " with scripted models" : ""}, seed ${seed}. Claude budget: $${config.runBudgetUsd}.`);
  try {
    const options = {
      runId: `${args.command}-${profile}-${stamp}-${seed}`,
      seed,
      profile,
      router: new ModelRouter(providers, roleModelsFor(profile)),
      approver,
      runBudgetUsd: config.runBudgetUsd,
      ...(job !== undefined ? { noticeId: job } : {}),
      ...(args.complexity !== undefined ? { complexity: args.complexity } : {}),
    };
    const report = isJob ? await runJobChain({ ...options, forceAward: args.forceAward ?? false }) : await runBidChain(options);
    const path = join(args.out, `${report.runId}.json`);
    await write(path, JSON.stringify(report, null, 2));
    const lines = isJob ? formatJobReport(report as JobReport) : formatBidReport(report as BidReport);
    for (const line of lines) out(line);
    out(`Report: ${path}`);
    return report.outcome === "incomplete" ? 1 : 0;
  } finally {
    rl?.close();
  }
}
