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
import { runCloseoutChain, type CloseoutReport } from "../sim/closeoutChain.js";
import { DashboardServer } from "../dashboard/server.js";
import { dashboardOptions, runUserCommand, USER_USAGE, type UserCommandDeps } from "./dashboardCli.js";
import { openDb, type Db } from "../db/db.js";
import { loadMigrations, migrationsDir, requireMigrated } from "../db/migrate.js";
import { PgUserStore, RunStore, type PersistentEventLog, type StoredReport } from "../db/stores.js";
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
  pnpm sim closeout  the same flags as job
  pnpm sim dashboard [--out DIR]   open the owner dashboard on saved reports
  pnpm sim user add|passwd|reset-code|remove NAME, or pnpm sim user list   manage dashboard logins

  --models   hybrid: President and PM on Claude, other roles on your local vLLM model
             cloud:  President and PM on Claude, other roles on a cheaper Claude
                     model (CLAUDE_WORKER_MODEL, default claude-sonnet-5-5); no GPU (default)
  --runs N   bench only: runs per profile (default 3), alternating profiles
  --stub     scripted models: no API key, GPU or cost (a dry run)
  --seed N   hiring and bid: the run's seed (random if left out); a bid run replays from it
  --job ID   bid only: bid this solicitation (default: picked by seed)
  --complexity  bid only: pick only among jobs at this complexity
  --auto-approve  bid and job: approve every owner gate without asking (simulation only)
  --dashboard     bid, job and closeout: answer approvals and watch the run in the owner dashboard
  --force-award   job and closeout: if a responsive bid loses on price, award it anyway (simulation only)
  --out DIR  where to write reports (default: runs)

Hybrid runs (opt in with --models hybrid) check vLLM first and restart it if it is busy or slow (see pnpm gpu).
The President→HR and HR→PM hires are automatic. In "hiring", any other hire asks
you here; in "bench", other hires are declined so runs stay comparable. In "bid", pursuing
the job, each later hire and the bid price ask you here unless you pass --auto-approve.
"job" bids, then runs an awarded job: contracts, a Scheduler hire, and each site problem
the seed brings, ending with the job's final account. "closeout" runs the job, then a
Bookkeeper invoices, pays every bill and collects, and the PM closes the project. A stub
bid, job or closeout run always bids ${STUB_BID_JOB} and approves every gate.`;

export interface SimArgs {
  command: "hiring" | "bench" | "bid" | "job" | "closeout" | "dashboard";
  dashboard?: boolean;
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
  if (command !== "hiring" && command !== "bench" && command !== "bid" && command !== "job" && command !== "closeout" && command !== "dashboard") throw new Error(`Unknown command "${command ?? ""}"`);
  const bidLike = command === "bid" || command === "job" || command === "closeout";
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
    if (arg === "--dashboard") {
      if (!bidLike) throw new Error("--dashboard is only for bid, job and closeout");
      parsed.dashboard = true;
      continue;
    }
    if (arg === "--force-award") {
      if (command !== "job" && command !== "closeout") throw new Error("--force-award is only for job and closeout");
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
  if (command === "dashboard" && argv.slice(1).some((a, i, all) => a.startsWith("--") && a !== "--out" && all[i - 1] !== "--out")) {
    throw new Error("dashboard takes only --out");
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
    const items = request.items ?? [];
    const lines = items.map((i) => `  ${i.id}: ${i.label}${i.amountUsd === undefined ? "" : `, $${i.amountUsd.toLocaleString("en-US")}`}`);
    const choices = items.length > 0 ? "[y = approve all, i = choose items, N or a reason to reject]" : "[y/N, or a reason to reject]";
    const answer = (await ask(`\nApprove ${request.gate} #${request.id} from ${request.requestedBy}${amount}?\n${request.summary}\n${lines.map((l) => `${l}\n`).join("")}${choices} `)).trim();
    if (/^y(es)?$/i.test(answer)) return { approve: true };
    if (items.length > 0 && /^i$/i.test(answer)) {
      const chosen: string[] = [];
      for (const item of items) {
        if (/^y(es)?$/i.test((await ask(`  Approve ${item.id} (${item.label})? [y/N] `)).trim())) chosen.push(item.id);
      }
      return chosen.length > 0 ? { approve: true, items: chosen } : { approve: false, reason: "No items approved" };
    }
    return { approve: false, reason: answer || "Rejected by owner" };
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

/** One-line-per-item summary of a closeout run: the job lines, then billing, payables and collection. */
export function formatCloseoutReport(report: CloseoutReport): string[] {
  const jobLines = formatJobReport({ ...report, outcome: report.outcome === "closed" ? "completed" : report.outcome } as JobReport);
  const head = jobLines[0]!.replace(/: COMPLETED in/, ": CLOSED in");
  const lines = [head, ...jobLines.slice(1, -1)];
  if (report.invoice) {
    const back = report.invoice.rejections > 0 ? ` after ${plural(report.invoice.rejections, "returned invoice")}` : "";
    lines.push(`  Invoice: ${money(report.invoice.amountUsd)} accepted${back}`);
  }
  if (report.bills.length > 0) {
    const paid = report.bills.filter((b) => b.paid);
    lines.push(`  Bills: ${paid.length} of ${report.bills.length} paid, ${money(paid.reduce((a, b) => a + b.amountUsd, 0))}`);
  }
  if (report.payment) {
    const p = report.payment;
    lines.push(`  Payment: ${money(p.paidUsd)} on day ${p.paidOnDay}${p.daysLate > 0 ? ` (${plural(p.daysLate, "day")} late)` : ""}${p.withheldUsd > 0 ? `, ${money(p.withheldUsd)} withheld` : ""}`);
  }
  for (const st of report.settlements) lines.push(`  Receivable ${st.issueId}: ${st.option}, recovers ${money(st.recoversUsd)}`);
  const c = report.closeout;
  if (c) lines.push(`  Cash: received ${money(c.receivedUsd)}, paid out ${money(c.paidOutUsd)}, cash profit ${c.cashProfitUsd < 0 ? "-" : ""}${money(Math.abs(c.cashProfitUsd))}`);
  lines.push(jobLines.at(-1)!);
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
  /** Resolves when a standalone dashboard should stop; defaults to Ctrl+C. */
  untilStopped?: () => Promise<void>;
  /** For `pnpm sim user`: prompts and the login store. */
  user?: Omit<UserCommandDeps, "env" | "out">;
  /** The database; left out, DATABASE_URL picks it, and null means none. */
  db?: Db | null;
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

/**
 * Runs one sim command. Returns the process exit code. With DATABASE_URL set,
 * runs, their events and dashboard logins are kept in Postgres too.
 */
export async function main(argv: string[], deps: SimDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  if (argv.length === 0 || argv[0] === "help") {
    out(USAGE);
    return 0;
  }
  const env = deps.env ?? process.env;
  const db = deps.db === undefined ? openDb(env) : deps.db;
  try {
    if (db) {
      try {
        await requireMigrated(db, await loadMigrations(migrationsDir(env)));
      } catch (err) {
        out(`Database: ${err instanceof Error ? err.message : String(err)}`);
        if (!/pnpm db migrate/.test(String(err))) out(databaseHint(env.DATABASE_URL));
        return 2;
      }
    }
    return await runCommand(argv, { ...deps, db }, out);
  } finally {
    if (deps.db === undefined) await db?.close();
  }
}

/** What to check when the database cannot be reached. */
export function databaseHint(url: string | undefined): string {
  const host = /@([^:/]+)/.exec(url ?? "")?.[1];
  return host === "db"
    ? 'DATABASE_URL points at "db", the name only other containers can use. On this machine use localhost, for example postgres://contracting:contracting@localhost:5432/contracting'
    : "Check DATABASE_URL in .env and that Postgres is running (docker compose up -d db), or remove DATABASE_URL to run without a database.";
}

async function runCommand(argv: string[], deps: SimDeps & { db: Db | null }, out: (line: string) => void): Promise<number> {
  if (argv[0] === "user") {
    if (argv[1] === "help" || argv[1] === "--help") {
      out(USER_USAGE);
      return 0;
    }
    return runUserCommand(argv.slice(1), { ...(deps.db ? { store: new PgUserStore(deps.db) } : {}), ...deps.user, env: deps.env ?? process.env, out });
  }
  let args: SimArgs;
  try {
    args = parseSimArgs(argv);
  } catch (err) {
    out(err instanceof Error ? err.message : String(err));
    out(USAGE);
    return 2;
  }

  const env = deps.env ?? process.env;
  const port = Number(env.DASHBOARD_PORT ?? 4100);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    out(`DASHBOARD_PORT must be a port number, not "${env.DASHBOARD_PORT ?? ""}"`);
    return 2;
  }
  if (args.command === "dashboard") {
    let server: DashboardServer;
    try {
      server = new DashboardServer(await dashboardOptions(env, args.out, port, undefined, deps.db));
      out(`Owner dashboard: ${await server.start()}`);
    } catch (err) {
      out(err instanceof Error ? err.message : String(err));
      return 2;
    }
    out("Press Ctrl+C to stop.");
    await (deps.untilStopped ?? (() => new Promise<void>((resolve) => process.once("SIGINT", () => resolve()))))();
    await server.stop();
    return 0;
  }
  const config = loadConfig(env);
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

  const runOnce = (profile: Profile, seed: number, approver: Approver, log?: PersistentEventLog) => {
    const providers = args.stub ? stubHiringProviders(profile) : (deps.providers ?? realProviders(config, profile));
    return runHiringChain({
      runId: hiringRunId(profile, seed),
      seed,
      profile,
      router: new ModelRouter(providers, roleModelsFor(profile)),
      approver,
      runBudgetUsd: config.runBudgetUsd,
      ...(log ? { log } : {}),
    });
  };
  const hiringRunId = (profile: Profile, seed: number) => `hiring-${profile}-${stamp}-${seed}`;

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
  if (args.command === "bid" || args.command === "job" || args.command === "closeout") return runBid(args, profile, seed, config, stamp, write, out, deps, port);
  let rl: ReturnType<typeof createInterface> | undefined;
  const approver =
    deps.approver ??
    terminalApprover((q) => {
      rl ??= createInterface({ input: process.stdin, output: process.stdout });
      return rl.question(q);
    });
  out(`Starting a ${profile} hiring run${args.stub ? " with scripted models" : ""}. Claude budget: $${config.runBudgetUsd}.`);
  try {
    const store = deps.db ? new RunStore(deps.db) : null;
    const log = await store?.start({ runId: hiringRunId(profile, seed), seed, command: "hiring", profile, modelConfig: { ...roleModelsFor(profile) } });
    const report = await runOnce(profile, seed, approver, log);
    const path = join(args.out, `${report.runId}.json`);
    await write(path, JSON.stringify(report, null, 2));
    for (const line of formatReport(report)) out(line);
    out(`Report: ${path}`);
    if (store && log) {
      await store.finish(log, report as unknown as StoredReport);
      out("Saved to the database.");
    }
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
  port = 4100,
): Promise<number> {
  let dashboard: DashboardServer | null = null;
  if (args.dashboard && !args.stub && !args.autoApprove) {
    try {
      dashboard = new DashboardServer(await dashboardOptions(deps.env ?? process.env, args.out, port, undefined, deps.db));
      out(`Owner dashboard: ${await dashboard.start()}`);
    } catch (err) {
      out(err instanceof Error ? err.message : String(err));
      return 2;
    }
    out("Sign in there to answer approvals; the run waits for you.");
  }
  const isJob = args.command === "job" || args.command === "closeout";
  const stubs = stubJobProviders(profile);
  const providers = args.stub ? stubs : (deps.providers ?? realProviders(config, profile));
  let rl: ReturnType<typeof createInterface> | undefined;
  const approver =
    args.stub || args.autoApprove
      ? autoApprover
      : dashboard
        ? dashboard.approver()
        : (deps.approver ??
        terminalApprover((q) => {
          rl ??= createInterface({ input: process.stdin, output: process.stdout });
          return rl.question(q);
        }));
  const job = args.stub ? STUB_BID_JOB : args.job;
  out(`Starting a ${profile} ${args.command} run${args.stub ? " with scripted models" : ""}, seed ${seed}. Claude budget: $${config.runBudgetUsd}.`);
  try {
    const runId = `${args.command}-${profile}-${stamp}-${seed}`;
    const store = deps.db ? new RunStore(deps.db) : null;
    const saved = await store?.start({ runId, seed, command: args.command, profile, modelConfig: { ...roleModelsFor(profile) } });
    const log = dashboard ? dashboard.tee(saved) : saved;
    const options = {
      runId,
      seed,
      profile,
      router: new ModelRouter(providers, roleModelsFor(profile)),
      approver,
      runBudgetUsd: config.runBudgetUsd,
      ...(log ? { log } : {}),
      ...(job !== undefined ? { noticeId: job } : {}),
      ...(args.complexity !== undefined ? { complexity: args.complexity } : {}),
    };
    const forced = { ...options, forceAward: args.forceAward ?? false };
    const report =
      args.command === "closeout" ? await runCloseoutChain(forced) : isJob ? await runJobChain(forced) : await runBidChain(options);
    const path = join(args.out, `${report.runId}.json`);
    await write(path, JSON.stringify(report, null, 2));
    const lines =
      args.command === "closeout"
        ? formatCloseoutReport(report as CloseoutReport)
        : isJob ? formatJobReport(report as JobReport) : formatBidReport(report as BidReport);
    for (const line of lines) out(line);
    out(`Report: ${path}`);
    if (store && saved) {
      await store.finish(saved, report as unknown as StoredReport);
      out("Saved to the database.");
    }
    return report.outcome === "incomplete" ? 1 : 0;
  } finally {
    rl?.close();
    await dashboard?.stop();
  }
}
