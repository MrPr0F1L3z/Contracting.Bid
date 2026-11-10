import { DEFAULT_ROLE_MODELS, type ModelTarget, type Role, type SimActor } from "./roles.js";

/**
 * Model profiles to benchmark against each other:
 * - hybrid: Claude runs the President and PM; the local vLLM model runs the rest.
 * - cloud: Claude runs every role; the local GPU is not used at all.
 */
export const PROFILES = ["hybrid", "cloud"] as const;
export type Profile = (typeof PROFILES)[number];

export function isProfile(value: string): value is Profile {
  return (PROFILES as readonly string[]).includes(value);
}

/** Which model family runs each role under a profile. */
export function roleModelsFor(profile: Profile): Record<Role | SimActor, ModelTarget> {
  if (profile === "hybrid") return { ...DEFAULT_ROLE_MODELS };
  const all = {} as Record<Role | SimActor, ModelTarget>;
  for (const key of Object.keys(DEFAULT_ROLE_MODELS) as Array<Role | SimActor>) all[key] = "claude";
  return all;
}

/** True when any role in the map runs on the local GPU. */
export function usesLocal(roleModels: Record<string, ModelTarget>): boolean {
  return Object.values(roleModels).includes("local");
}
