import { DEFAULT_ROLE_MODELS, type ModelTarget, type Role, type SimActor } from "./roles.js";

/**
 * Model profiles to benchmark against each other. Both use the same role map:
 * executive and reasoning-heavy roles (President, PM) on the "claude" target,
 * the rest on the "local" (worker) target. The profile decides what serves
 * the worker target:
 * - hybrid: the local vLLM model on the owner's GPU.
 * - cloud: a cheaper Claude model (CLAUDE_WORKER_MODEL); the GPU is not used.
 */
export const PROFILES = ["hybrid", "cloud"] as const;
export type Profile = (typeof PROFILES)[number];

export function isProfile(value: string): value is Profile {
  return (PROFILES as readonly string[]).includes(value);
}

/** Which model target runs each role under a profile. */
export function roleModelsFor(_profile: Profile): Record<Role | SimActor, ModelTarget> {
  return { ...DEFAULT_ROLE_MODELS };
}

/** True when the profile runs anything on the local GPU. */
export function usesGpu(profile: Profile): boolean {
  return profile === "hybrid";
}
