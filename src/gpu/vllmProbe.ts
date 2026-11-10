import type { CommandRunner } from "./hooks.js";

/**
 * Checks whether the owner's running vLLM server can take simulation work,
 * and restarts it fresh when it can't. A server is reusable when it has a
 * free "lane" (concurrent request slot) and answers a short probe fast
 * enough. Otherwise the runner stops it and starts the big model again.
 */

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export interface ProbeThresholds {
  /** Concurrent request slots the server is started with (vLLM --max-num-seqs). */
  maxLanes: number;
  /** A probe slower than this means the server is overloaded. */
  maxResponseSec: number;
  /** A probe slower than this many generated tokens per second means overloaded. */
  minTokensPerSec: number;
}

export const DEFAULT_THRESHOLDS: ProbeThresholds = { maxLanes: 4, maxResponseSec: 60, minTokensPerSec: 5 };

export interface LaneUsage {
  running: number;
  waiting: number;
}

/**
 * Reads vLLM's Prometheus metrics text and sums the running and waiting
 * request gauges across models. Returns null when the gauges are missing.
 */
export function parseLaneUsage(metricsText: string): LaneUsage | null {
  let running: number | null = null;
  let waiting: number | null = null;
  for (const line of metricsText.split("\n")) {
    if (line.startsWith("#") || line.trim() === "") continue;
    const match = /^([a-zA-Z_:][\w:]*)(\{[^}]*\})?\s+(\S+)/.exec(line);
    if (!match) continue;
    const value = Number(match[3]);
    if (!Number.isFinite(value)) continue;
    if (match[1] === "vllm:num_requests_running") running = (running ?? 0) + value;
    if (match[1] === "vllm:num_requests_waiting") waiting = (waiting ?? 0) + value;
  }
  return running === null ? null : { running, waiting: waiting ?? 0 };
}

export interface ProbeResult {
  ok: boolean;
  seconds: number;
  completionTokens: number;
  tokensPerSec: number;
  error?: string;
}

/** Tokens per second, guarding against zero elapsed time. */
export function tokensPerSecond(tokens: number, seconds: number): number {
  return seconds > 0 ? tokens / seconds : 0;
}

/**
 * Sends one chat request and times it. Aborts at `timeoutSec` so a stuck
 * server can't hang the runner.
 */
export async function timeRequest(
  fetchImpl: FetchLike,
  baseUrl: string,
  model: string,
  prompt: string,
  options: { maxTokens?: number; timeoutSec?: number; now?: () => number } = {},
): Promise<ProbeResult> {
  const now = options.now ?? (() => performance.now());
  const timeoutSec = options.timeoutSec ?? 60;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  const start = now();
  try {
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: options.maxTokens ?? 64,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });
    const seconds = (now() - start) / 1000;
    if (!res.ok) return { ok: false, seconds, completionTokens: 0, tokensPerSec: 0, error: `HTTP ${res.status}` };
    const body = (await res.json()) as { usage?: { completion_tokens?: number } };
    const completionTokens = body.usage?.completion_tokens ?? 0;
    return { ok: true, seconds, completionTokens, tokensPerSec: tokensPerSecond(completionTokens, seconds) };
  } catch (err) {
    const seconds = (now() - start) / 1000;
    const error = controller.signal.aborted ? `timed out after ${timeoutSec}s` : describeError(err);
    return { ok: false, seconds, completionTokens: 0, tokensPerSec: 0, error };
  } finally {
    clearTimeout(timer);
  }
}

export type Verdict = { reuse: true; reason: string } | { reuse: false; reason: string };

/** Decides whether the running server can take our work. */
export function decide(lanes: LaneUsage | null, probe: ProbeResult | null, t: ProbeThresholds = DEFAULT_THRESHOLDS): Verdict {
  if (probe === null) return { reuse: false, reason: "vLLM is not responding" };
  if (!probe.ok) return { reuse: false, reason: `probe failed: ${probe.error ?? "unknown error"}` };
  if (lanes && lanes.running >= t.maxLanes) {
    return { reuse: false, reason: `all ${t.maxLanes} lanes busy (${lanes.running} running, ${lanes.waiting} waiting)` };
  }
  if (lanes && lanes.waiting > 0) {
    return { reuse: false, reason: `${lanes.waiting} request(s) already queued` };
  }
  if (probe.seconds > t.maxResponseSec) {
    return { reuse: false, reason: `probe took ${probe.seconds.toFixed(1)}s (limit ${t.maxResponseSec}s)` };
  }
  if (probe.completionTokens > 0 && probe.tokensPerSec < t.minTokensPerSec) {
    return { reuse: false, reason: `only ${probe.tokensPerSec.toFixed(1)} tokens/s (minimum ${t.minTokensPerSec})` };
  }
  const laneText = lanes ? `${lanes.running}/${t.maxLanes} lanes busy` : "lane usage unknown";
  return { reuse: true, reason: `${laneText}, ${probe.seconds.toFixed(1)}s, ${probe.tokensPerSec.toFixed(1)} tokens/s` };
}

/** Root URL of the server (drops a trailing /v1). */
export function serverRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** Reads lane usage from /metrics; null when the endpoint is unreachable. */
export async function readLaneUsage(fetchImpl: FetchLike, baseUrl: string): Promise<LaneUsage | null> {
  try {
    const res = await fetchImpl(`${serverRoot(baseUrl)}/metrics`);
    return res.ok ? parseLaneUsage(await res.text()) : null;
  } catch {
    return null;
  }
}

/** Polls /v1/models until the server answers or the deadline passes. */
export async function waitForReady(
  fetchImpl: FetchLike,
  baseUrl: string,
  options: { timeoutSec?: number; intervalSec?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<boolean> {
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutSec ?? 600) * 1000;
  while (now() <= deadline) {
    try {
      const res = await fetchImpl(`${baseUrl}/models`);
      if (res.ok) return true;
    } catch {
      // Not up yet.
    }
    await sleep((options.intervalSec ?? 5) * 1000);
  }
  return false;
}

export interface EnsureOptions {
  baseUrl: string;
  model: string;
  stopCommand: string;
  startCommand: string;
  thresholds?: ProbeThresholds;
  fetchImpl?: FetchLike;
  run: CommandRunner;
  log?: (msg: string) => void;
  readyTimeoutSec?: number;
  waitOptions?: Parameters<typeof waitForReady>[2];
}

export interface EnsureResult {
  restarted: boolean;
  verdict: Verdict;
}

/**
 * Reuses the running vLLM server when it has room, otherwise stops it and
 * starts the big model fresh, then waits until it answers.
 */
export async function ensureVllm(opts: EnsureOptions): Promise<EnsureResult> {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const log = opts.log ?? (() => {});
  const lanes = await readLaneUsage(fetchImpl, opts.baseUrl);
  const probe = await timeRequest(fetchImpl, opts.baseUrl, opts.model, "Reply with the word ready.", {
    timeoutSec: opts.thresholds?.maxResponseSec ?? DEFAULT_THRESHOLDS.maxResponseSec,
  });
  const verdict = decide(lanes, probe, opts.thresholds);
  log(`${verdict.reuse ? "Reusing" : "Restarting"} vLLM: ${verdict.reason}`);
  if (verdict.reuse) return { restarted: false, verdict };

  log(`Running: ${opts.stopCommand}`);
  try {
    await opts.run(opts.stopCommand);
  } catch (err) {
    // A stop that fails because nothing is running is fine; the start decides.
    log(`Stop command failed (continuing): ${String(err)}`);
  }
  log(`Running: ${opts.startCommand}`);
  await opts.run(opts.startCommand);
  const ready = await waitForReady(fetchImpl, opts.baseUrl, {
    timeoutSec: opts.readyTimeoutSec ?? 600,
    ...opts.waitOptions,
  });
  if (!ready) throw new Error(`vLLM did not come up within ${opts.readyTimeoutSec ?? 600}s after "${opts.startCommand}"`);
  log("vLLM is ready");
  return { restarted: true, verdict };
}

/** Error text with the network cause (for example ECONNREFUSED) that fetch hides. */
export function describeError(err: unknown): string {
  const base = String(err);
  const cause = (err as { cause?: { code?: string; message?: string } } | null)?.cause;
  const detail = cause?.code ?? cause?.message;
  return detail ? `${base} (${detail})` : base;
}
