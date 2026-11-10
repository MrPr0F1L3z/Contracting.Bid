import type { Role, SimActor, ModelTarget } from "../config/roles.js";
import { DEFAULT_ROLE_MODELS } from "../config/roles.js";
import type { ModelProvider } from "./types.js";

/** Picks the provider for each role, from a role-to-target map. */
export class ModelRouter {
  constructor(
    private readonly providers: Record<ModelTarget, ModelProvider>,
    private readonly roleModels: Record<Role | SimActor, ModelTarget> = DEFAULT_ROLE_MODELS,
  ) {}

  providerFor(role: Role | SimActor): ModelProvider {
    const target = this.roleModels[role];
    if (!target) throw new Error(`No model configured for role "${role}"`);
    return this.providers[target];
  }
}
