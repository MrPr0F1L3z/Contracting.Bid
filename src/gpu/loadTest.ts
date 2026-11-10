import type { SeededRng } from "../sim/rng.js";
import type { FetchLike, ProbeResult } from "./vllmProbe.js";
import { timeRequest } from "./vllmProbe.js";

/** Random construction-office questions used as background load. */
export const BACKGROUND_PROMPTS = [
  "List the trades needed to renovate a 2,500 sq ft office suite and the order they work in.",
  "Draft a short request for a drywall quote for 4,000 sq ft of partitions.",
  "Explain Davis-Bacon certified payroll in plain terms for a subcontractor.",
  "Write a three-week lookahead schedule for a rooftop HVAC replacement.",
  "What should a change order request include? Give a checklist.",
  "Summarize the risks of renovating an occupied clinic wing.",
  "Estimate crew days to mill and overlay 40,000 sq ft of asphalt, with assumptions.",
  "Write a polite email to a vendor whose delivery is three days late.",
] as const;

export interface LoadTestOptions {
  baseUrl: string;
  model: string;
  /** Requests kept running in the background. */
  background: number;
  /** Timed requests sent one after another while the background runs. */
  foreground: number;
  rng: SeededRng;
  fetchImpl?: FetchLike;
  timeoutSec?: number;
}

export interface LoadTestReport {
  background: ProbeResult[];
  foreground: ProbeResult[];
  summary: { ok: number; failed: number; maxSeconds: number; minTokensPerSec: number };
}

/** Summarizes foreground results: how many passed, worst time, slowest rate. */
export function summarize(results: ProbeResult[]): LoadTestReport["summary"] {
  const ok = results.filter((r) => r.ok);
  return {
    ok: ok.length,
    failed: results.length - ok.length,
    maxSeconds: results.reduce((m, r) => Math.max(m, r.seconds), 0),
    minTokensPerSec: ok.length ? Math.min(...ok.map((r) => r.tokensPerSec)) : 0,
  };
}

/**
 * Starts `background` long requests, then times `foreground` short ones
 * while those run. Shows how the server behaves with other work in flight.
 */
export async function runLoadTest(opts: LoadTestOptions): Promise<LoadTestReport> {
  if (opts.background < 0 || opts.foreground < 1) throw new Error("Need background >= 0 and foreground >= 1");
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const timeoutSec = opts.timeoutSec ?? 120;
  const prompts = opts.rng.fork("load-test");
  const backgroundRuns = Array.from({ length: opts.background }, () =>
    timeRequest(fetchImpl, opts.baseUrl, opts.model, prompts.pick(BACKGROUND_PROMPTS), { maxTokens: 512, timeoutSec }),
  );
  const foreground: ProbeResult[] = [];
  for (let i = 0; i < opts.foreground; i++) {
    foreground.push(
      await timeRequest(fetchImpl, opts.baseUrl, opts.model, prompts.pick(BACKGROUND_PROMPTS), { maxTokens: 128, timeoutSec }),
    );
  }
  const background = await Promise.all(backgroundRuns);
  return { background, foreground, summary: summarize(foreground) };
}
