import { loadConfig } from "../config/config.js";
import { shellRunner, type CommandRunner } from "../gpu/hooks.js";
import { runLoadTest } from "../gpu/loadTest.js";
import { decide, ensureVllm, readLaneUsage, timeRequest, type FetchLike } from "../gpu/vllmProbe.js";
import { SeededRng, newSeed } from "../sim/rng.js";
import { loadDotEnv } from "../config/dotenv.js";

export const USAGE = `Usage: pnpm gpu <command>
  check                 Report lane usage and probe speed; change nothing
  ensure                Reuse vLLM if it has room, otherwise run VLLM_STOP_CMD and VLLM_START_CMD
  loadtest [bg] [fg]    Keep [bg] requests running (default 3) and time [fg] more (default 3)`;

export interface CliDeps {
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  run?: CommandRunner;
  out?: (line: string) => void;
}

/** Runs one CLI command. Returns the process exit code. */
export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  const config = loadConfig(deps.env ?? process.env);
  const out = deps.out ?? ((l: string) => console.log(l));
  const fetchImpl = deps.fetchImpl ?? (fetch as unknown as FetchLike);
  const t = config.vllm;
  const [command, ...rest] = argv;

  switch (command) {
    case "check": {
      const lanes = await readLaneUsage(fetchImpl, config.vllmBaseUrl);
      const probe = await timeRequest(fetchImpl, config.vllmBaseUrl, config.vllmModel, "Reply with the word ready.", {
        timeoutSec: t.maxResponseSec,
      });
      out(`Lanes: ${lanes ? `${lanes.running} running, ${lanes.waiting} waiting, of ${t.maxLanes}` : "unknown (no /metrics)"}`);
      out(`Probe: ${probe.ok ? `${probe.seconds.toFixed(1)}s, ${probe.tokensPerSec.toFixed(1)} tokens/s` : `failed (${probe.error})`}`);
      const verdict = decide(lanes, probe, t);
      out(`Verdict: ${verdict.reuse ? "reuse" : "restart"} (${verdict.reason})`);
      out(`Server: ${config.vllmBaseUrl}, model ${config.vllmModel}`);
      return 0;
    }
    case "ensure": {
      const result = await ensureVllm({
        baseUrl: config.vllmBaseUrl,
        model: config.vllmModel,
        stopCommand: t.stopCommand,
        startCommand: t.startCommand,
        thresholds: t,
        fetchImpl,
        run: deps.run ?? shellRunner,
        log: out,
      });
      out(result.restarted ? "Restarted vLLM fresh." : "Kept the running vLLM.");
      return 0;
    }
    case "loadtest": {
      const background = Number(rest[0] ?? 3);
      const foreground = Number(rest[1] ?? 3);
      const seed = newSeed();
      out(`Load test: ${background} background, ${foreground} foreground, seed ${seed}`);
      const report = await runLoadTest({
        baseUrl: config.vllmBaseUrl,
        model: config.vllmModel,
        background,
        foreground,
        rng: new SeededRng(seed),
        fetchImpl,
      });
      report.foreground.forEach((r, i) =>
        out(`  timed #${i + 1}: ${r.ok ? `${r.seconds.toFixed(1)}s, ${r.tokensPerSec.toFixed(1)} tokens/s` : `failed (${r.error})`}`),
      );
      const s = report.summary;
      out(`Summary: ${s.ok} ok, ${s.failed} failed, worst ${s.maxSeconds.toFixed(1)}s, slowest ${s.minTokensPerSec.toFixed(1)} tokens/s`);
      const pass = s.failed === 0 && s.maxSeconds <= t.maxResponseSec && s.minTokensPerSec >= t.minTokensPerSec;
      out(pass ? "PASS: the server keeps up with this load." : "FAIL: the server is too slow or failing under this load.");
      return pass ? 0 : 1;
    }
    default:
      out(USAGE);
      return command === undefined || command === "help" ? 0 : 2;
  }
}

// Run when invoked directly: node dist/src/cli/vllm.js <command>
if (import.meta.url === `file://${process.argv[1]}`) {
  loadDotEnv();
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
