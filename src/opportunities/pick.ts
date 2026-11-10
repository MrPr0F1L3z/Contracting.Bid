import type { SeededRng } from "../sim/rng.js";
import type { Opportunity } from "./types.js";
import { CONSTRUCTION_NAICS_PREFIXES } from "./types.js";

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
 * True when the job fits under the size cap. A notice with no estimate
 * passes, since there is nothing to judge it by.
 */
export function fitsSizeCap(opp: Opportunity, maxValueUsd?: number): boolean {
  if (maxValueUsd === undefined || opp.estimatedValueUsd === null) return true;
  return opp.estimatedValueUsd.max <= maxValueUsd;
}

/**
 * Picks one opportunity at random (by seed) from the biddable ones under
 * the size cap. Sorting by noticeId first makes the pick independent of
 * the order the source returns them in.
 */
export function pickOpportunity(
  opportunities: Opportunity[],
  rng: SeededRng,
  options: { maxValueUsd?: number } = {},
): Opportunity {
  const candidates = opportunities
    .filter((o) => isBiddableConstruction(o) && fitsSizeCap(o, options.maxValueUsd))
    .sort((a, b) => a.noticeId.localeCompare(b.noticeId));
  if (candidates.length === 0) {
    throw new Error("No active construction solicitations to pick from");
  }
  return rng.fork("opportunity").pick(candidates);
}
