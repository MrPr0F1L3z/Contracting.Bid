import type { Usage } from "../models/types.js";

/** US dollars per million tokens. Local models cost nothing per call. */
export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const MODEL_PRICING: Record<string, Pricing> = {
  "claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20 },
  "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-haiku-5-5": { inputPerMTok: 0.1, outputPerMTok: 0.5 },
};

const FREE: Pricing = { inputPerMTok: 0, outputPerMTok: 0 };

/** Cost of one call in US dollars. Unknown (local) models are free. */
export function costOf(model: string, usage: Usage, pricing: Record<string, Pricing> = MODEL_PRICING): number {
  const p = pricing[model] ?? FREE;
  return (usage.inputTokens * p.inputPerMTok + usage.outputTokens * p.outputPerMTok) / 1_000_000;
}

export type BudgetStatus = "ok" | "warning" | "exceeded";

/**
 * A spending limit for an agent or a whole run. Warns at `warnAt` of the
 * limit and reports "exceeded" at 100%, at which point the caller must stop
 * and escalate.
 */
export class Budget {
  private spent = 0;

  constructor(
    readonly limitUsd: number,
    readonly warnAt = 0.8,
  ) {
    if (!(limitUsd > 0)) throw new Error(`Budget limit must be positive, got ${limitUsd}`);
    if (!(warnAt > 0 && warnAt < 1)) throw new Error(`warnAt must be between 0 and 1, got ${warnAt}`);
  }

  spentUsd(): number {
    return this.spent;
  }

  remainingUsd(): number {
    return Math.max(0, this.limitUsd - this.spent);
  }

  status(): BudgetStatus {
    if (this.spent >= this.limitUsd) return "exceeded";
    if (this.spent >= this.limitUsd * this.warnAt) return "warning";
    return "ok";
  }

  /** Records spending and returns the new status. */
  charge(usd: number): BudgetStatus {
    if (!(usd >= 0)) throw new Error(`Cannot charge ${usd}`);
    this.spent += usd;
    return this.status();
  }

  /** True when another call is allowed. */
  canSpend(): boolean {
    return this.status() !== "exceeded";
  }
}
