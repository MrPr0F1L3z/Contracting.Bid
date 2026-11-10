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
  samGovApiKey: string | undefined;
  databaseUrl: string;
  runBudgetUsd: number;
  gpuHooks: GpuHook[];
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
    samGovApiKey: env.SAMGOV_API_KEY || undefined,
    databaseUrl: env.DATABASE_URL || "postgres://contracting:contracting@localhost:5432/contracting",
    runBudgetUsd: budget,
    gpuHooks: parseGpuHooks(env.GPU_PAUSE_HOOKS),
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
