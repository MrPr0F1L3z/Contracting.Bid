import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Approver } from "../agents/hiringTools.js";
import { loadConfig } from "../config/config.js";
import type { ModelTarget } from "../config/roles.js";
import { shellRunner, type CommandRunner } from "../gpu/hooks.js";
import { ensureVllm, type FetchLike } from "../gpu/vllmProbe.js";
import { AnthropicProvider } from "../models/anthropic.js";
import { LimitedProvider, Semaphore } from "../models/limiter.js";
import { OpenAiCompatibleProvider } from "../models/openaiCompatible.js";
import { ModelRouter } from "../models/router.js";
import type { ModelProvider } from "../models/types.js";
import { runHiringChain, type HiringReport } from "../sim/hiringChain.js";
import { newSeed } from "../sim/rng.js";
import { stubHiringProviders } from "../sim/stubHiring.js";

export const USAGE = `Usage: pnpm sim hiring [--stub] [--seed N] [--out DIR]
  --stub     scripted models: no API key, GPU or cost (a dry run of the chain)
  --seed N   seed to record with the run (random if left out)
  --out DIR  where to write the run report (default: runs)

Without --stub, the President runs on Claude and HR on your local vLLM model.
vLLM is checked first and restarted if it is busy or slow (see pnpm gpu).
The President→HR and HR→PM hires are automatic; any other hire asks you here.`;

export interface SimArgs {
  stub: boolean;
  seed?: number;
  out: string;
}

/** Parses the flags after "hiring". Throws on anything unknown. */
export function parseSimArgs(args: string[]): SimArgs {
  const parsed: SimArgs = { stub: false, out: "runs" };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--stub") parsed.stub = true;
    else if (arg === "--seed" || arg === "--out") {
      const value = args[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      if (arg === "--out") parsed.out = value;
      else {
        const seed = Number(value);
        if (!Number.isInteger(seed) || seed < 0) throw new Error(`--seed must be a whole number, got "${value}"`);
        parsed.seed = seed;
      }
    } else throw new Error(`Unknown option "${arg}"`);
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

/** One-line-per-item summary of a run, for the terminal. */
export function formatReport(report: HiringReport): string[] {
  return [
    `Run ${report.runId} (seed ${report.seed}): ${report.outcome.toUpperCase()}. ${report.reason}`,
    ...report.agents.map(
      (a) => `  #${a.id} ${a.role}: ${a.status}, reports to ${a.managerId === null ? "owner" : `#${a.managerId}`}, budget $${a.budgetUsd}`,
    ),
    ...report.tasks.map((t) => `  task ${t.actor} on ${t.model}: ${t.stop} after ${t.steps} model calls`),
    `  Claude spend: $${report.spentUsd.toFixed(4)}; ${report.approvals.length} approvals (${report.approvals.filter((a) => a.autoApproved).length} automatic); ${report.eventCount} events`,
  ];
}

export interface SimDeps {
  env?: Record<string, string | undefined>;
  out?: (line: string) => void;
  /** Real providers by model target; tests inject fakes. */
  providers?: Record<ModelTarget, ModelProvider>;
  approver?: Approver;
  fetchImpl?: FetchLike;
  run?: CommandRunner;
  writeReport?: (path: string, json: string) => Promise<void>;
  now?: () => Date;
}

async function defaultWrite(path: string, json: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, json);
}

/** Runs one sim command. Returns the process exit code. */
export async function main(argv: string[], deps: SimDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const [command, ...rest] = argv;
  if (command !== "hiring") {
    out(USAGE);
    return command === undefined || command === "help" ? 0 : 2;
  }
  let args: SimArgs;
  try {
    args = parseSimArgs(rest);
  } catch (err) {
    out(err instanceof Error ? err.message : String(err));
    out(USAGE);
    return 2;
  }

  const config = loadConfig(deps.env ?? process.env);
  let providers: Record<ModelTarget, ModelProvider>;
  if (args.stub) {
    providers = stubHiringProviders();
  } else {
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
    providers = deps.providers ?? {
      claude: new AnthropicProvider(config.claudeModel),
      local: new LimitedProvider(
        new OpenAiCompatibleProvider(config.vllmModel, { baseURL: config.vllmBaseUrl, apiKey: config.vllmApiKey }),
        new Semaphore(config.vllm.maxLanes),
      ),
    };
  }

  const seed = args.seed ?? newSeed();
  const stamp = (deps.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, "-");
  const runId = `hiring-${stamp}-${seed}`;
  let rl: ReturnType<typeof createInterface> | undefined;
  const approver =
    deps.approver ??
    terminalApprover((q) => {
      rl ??= createInterface({ input: process.stdin, output: process.stdout });
      return rl.question(q);
    });
  out(`Starting ${runId}${args.stub ? " with scripted models" : ""}. Claude budget: $${config.runBudgetUsd}.`);
  try {
    const report = await runHiringChain({ runId, seed, router: new ModelRouter(providers), approver, runBudgetUsd: config.runBudgetUsd });
    const path = join(args.out, `${runId}.json`);
    await (deps.writeReport ?? defaultWrite)(path, JSON.stringify(report, null, 2));
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
