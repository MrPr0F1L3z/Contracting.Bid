import type { SeededRng } from "../sim/rng.js";
import type { Complexity, Opportunity } from "./types.js";
import { COMPLEXITIES, CONSTRUCTION_NAICS_PREFIXES } from "./types.js";

const BIDDABLE_TYPES: ReadonlySet<Opportunity["type"]> = new Set([
  "solicitation",
  "combined_synopsis_solicitation",
]);

/** True when an opportunity is an active, biddable construction solicitation. */
export function isBiddableConstruction(opp: Opportunity): boolean {
  const naicsOk = CONSTRUCTION_NAICS_PREFIXES.some((p) => opp.naicsCode.startsWith(p));
  return opp.active && naicsOk && BIDDABLE_TYPES.has(opp.type);
}

/**
 * Picks one biddable opportunity at random (by seed), optionally only at a
 * given complexity. There is no cap on estimated value. Sorting by noticeId
 * first makes the pick independent of the order the source returns them in.
 */
export function pickOpportunity(
  opportunities: Opportunity[],
  rng: SeededRng,
  options: { complexity?: Complexity } = {},
): Opportunity {
  const candidates = opportunities
    .filter((o) => isBiddableConstruction(o))
    .filter((o) => options.complexity === undefined || o.complexity === options.complexity)
    .sort((a, b) => a.noticeId.localeCompare(b.noticeId));
  if (candidates.length === 0) {
    const which = options.complexity ? ` at ${options.complexity} complexity` : "";
    throw new Error(`No active construction solicitations${which} to pick from`);
  }
  return rng.fork("opportunity").pick(candidates);
}

/**
 * Plans the complexity for each run in a batch so every level is covered
 * as evenly as possible: each block of three runs holds one easy, one
 * moderate and one complex job, in a seeded order.
 */
export function planComplexityCoverage(runs: number, rng: SeededRng): Complexity[] {
  if (!Number.isInteger(runs) || runs < 0) throw new Error(`Invalid run count ${runs}`);
  const stream = rng.fork("complexity-plan");
  const plan: Complexity[] = [];
  while (plan.length < runs) {
    plan.push(...stream.sample(COMPLEXITIES, COMPLEXITIES.length));
  }
  return plan.slice(0, runs);
}
