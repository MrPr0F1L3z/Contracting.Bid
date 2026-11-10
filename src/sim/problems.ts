import type { SeededRng } from "./rng.js";

export type Phase = "staff" | "win" | "contract" | "execute" | "closeout";

export interface ProblemDefinition {
  id: string;
  phase: Phase;
  description: string;
}

/** Real-world problems the simulator can inject. See the POC spec. */
export const PROBLEM_CATALOG: readonly ProblemDefinition[] = [
  { id: "late-delivery", phase: "execute", description: "Material delivery is late or wrong" },
  { id: "quote-expired", phase: "win", description: "A vendor quote expires or the price rises before the order" },
  { id: "sub-no-show", phase: "execute", description: "A subcontractor no-shows, quits mid-job, or does poor work" },
  { id: "change-order", phase: "execute", description: "The contracting officer requests a change order, or disputes one" },
  { id: "failed-inspection", phase: "execute", description: "An inspection fails" },
  { id: "hidden-conditions", phase: "execute", description: "Hidden conditions appear during demolition" },
  { id: "late-payment", phase: "closeout", description: "The client pays late or short" },
  { id: "double-booked", phase: "execute", description: "Two subcontractor crews are double-booked" },
  { id: "weather-delay", phase: "execute", description: "Weather delays a delivery" },
];

export interface ScheduledProblem {
  problem: ProblemDefinition;
  /** 0 to 1: how far through its phase the problem fires. */
  phaseProgress: number;
}

/**
 * Draws between `min` and `max` distinct problems for a run.
 * Uses its own RNG stream so other random choices don't shift the draw.
 */
export function drawProblems(
  rng: SeededRng,
  min = 3,
  max = 5,
  catalog: readonly ProblemDefinition[] = PROBLEM_CATALOG,
): ScheduledProblem[] {
  if (min < 0 || max < min || max > catalog.length) {
    throw new Error(`Invalid problem count range [${min}, ${max}] for ${catalog.length} problems`);
  }
  const stream = rng.fork("problems");
  const count = stream.int(min, max);
  return stream
    .sample(catalog, count)
    .map((problem) => ({ problem, phaseProgress: Math.round(stream.next() * 100) / 100 }))
    .sort((a, b) => a.problem.id.localeCompare(b.problem.id));
}
