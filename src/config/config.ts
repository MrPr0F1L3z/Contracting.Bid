import { DEFAULT_CLAUDE_MODEL } from "../models/anthropic.js";

export interface GpuHook {
  pause: string;
  resume: string;
}

export interface AppConfig {
  claudeModel: string;
  vllmBaseUrl: string;
  vllmApiKey: string;
  vllmModel: string;
  databaseUrl: string;
  runBudgetUsd: number;
  gpuHooks: GpuHook[];
  vllm: {
    maxLanes: number;
    maxResponseSec: number;
    minTokensPerSec: number;
    stopCommand: string;
    startCommand: string;
  };
}

/**
 * Reads configuration from environment variables, with defaults for local
 * development. Throws with a clear message on invalid values.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const budget = Number(env.RUN_BUDGET_USD ?? "5");
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new Error(`RUN_BUDGET_USD must be a positive number, got "${env.RUN_BUDGET_USD}"`);
  }
  return {
    claudeModel: env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL,
    vllmBaseUrl: env.VLLM_BASE_URL || "http://localhost:8000/v1",
    vllmApiKey: env.VLLM_API_KEY || "not-needed",
    vllmModel: env.VLLM_MODEL || "Qwen/Qwen2.5-32B-Instruct-AWQ",
    databaseUrl: env.DATABASE_URL || "postgres://contracting:contracting@localhost:5432/contracting",
    runBudgetUsd: budget,
    gpuHooks: parseGpuHooks(env.GPU_PAUSE_HOOKS),
    vllm: {
      maxLanes: positive("VLLM_MAX_LANES", env.VLLM_MAX_LANES, 4),
      maxResponseSec: positive("VLLM_MAX_RESPONSE_SEC", env.VLLM_MAX_RESPONSE_SEC, 60),
      minTokensPerSec: positive("VLLM_MIN_TOKENS_PER_SEC", env.VLLM_MIN_TOKENS_PER_SEC, 5),
      stopCommand: env.VLLM_STOP_CMD || "vllm stop",
      startCommand: env.VLLM_START_CMD || "vllm start big",
    },
  };
}

/** Parses GPU_PAUSE_HOOKS: a JSON list of {pause, resume} shell commands. */
export function parseGpuHooks(raw: string | undefined): GpuHook[] {
  if (!raw || raw.trim() === "") return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("GPU_PAUSE_HOOKS must be valid JSON");
  }
  if (!Array.isArray(value)) throw new Error("GPU_PAUSE_HOOKS must be a JSON list");
  return value.map((item, i) => {
    if (
      item === null ||
      typeof item !== "object" ||
      typeof (item as GpuHook).pause !== "string" ||
      typeof (item as GpuHook).resume !== "string"
    ) {
      throw new Error(`GPU_PAUSE_HOOKS[${i}] needs string "pause" and "resume" commands`);
    }
    return { pause: (item as GpuHook).pause, resume: (item as GpuHook).resume };
  });
}

/** Parses a positive number with a default when unset. */
export function positive(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
  return value;
}
