import type { Complexity, Opportunity } from "../opportunities/types.js";
import type { SeededRng } from "../sim/rng.js";
import { JOB_SCOPES, type Trade } from "./market.js";
import { JOB_DURATION_DAYS } from "./site.js";

/**
 * What the simulated world needs to know about a job: the trades it really
 * takes and each one's share of the subcontracted cost, the value range the
 * costs are drawn from, and the contract time. The stub jobs have these
 * written out; a real listing gets them inferred from its NAICS code and text.
 */
export interface SimulatedScope {
  trades: Array<readonly [Trade, number]>;
  valueUsd: { min: number; max: number };
  contractDays: number;
}

/** The trades a NAICS code usually means, with rough cost shares. Longest prefix wins. */
const NAICS_TRADES: ReadonlyArray<readonly [prefix: string, trades: ReadonlyArray<readonly [Trade, number]>]> = [
  ["237310", [["asphalt_paving", 0.6], ["concrete", 0.2], ["sitework", 0.15], ["striping", 0.05]]],
  ["2371", [["sitework", 0.5], ["plumbing", 0.3], ["concrete", 0.2]]],
  ["237", [["sitework", 0.55], ["concrete", 0.45]]],
  ["23811", [["concrete", 1]]],
  ["23812", [["metal_building", 0.8], ["rigging", 0.2]]],
  ["23813", [["framing_drywall", 1]]],
  ["23814", [["concrete", 1]]],
  ["23816", [["roofing", 0.85], ["demolition", 0.15]]],
  ["23821", [["electrical", 0.9], ["controls", 0.1]]],
  ["23822", [["hvac", 0.55], ["plumbing", 0.3], ["controls", 0.15]]],
  ["23829", [["equipment", 0.7], ["electrical", 0.3]]],
  ["23831", [["framing_drywall", 0.85], ["painting", 0.15]]],
  ["23832", [["painting", 1]]],
  ["23833", [["flooring", 0.9], ["demolition", 0.1]]],
  ["23835", [["framing_drywall", 1]]],
  ["23891", [["sitework", 0.8], ["demolition", 0.2]]],
  ["238", [["sitework", 0.5], ["concrete", 0.5]]],
  ["236", [
    ["demolition", 0.05], ["concrete", 0.15], ["framing_drywall", 0.2], ["electrical", 0.15], ["plumbing", 0.1],
    ["hvac", 0.15], ["painting", 0.08], ["flooring", 0.07], ["roofing", 0.05],
  ]],
];

/** Words in a notice that point to a trade. */
const TRADE_WORDS: ReadonlyArray<readonly [Trade, RegExp]> = [
  ["roofing", /\broof/i],
  ["hvac", /\b(hvac|air handl|chiller|boiler|heat pump|rooftop unit|ductwork)/i],
  ["painting", /\bpaint/i],
  ["flooring", /\b(floor|carpet|lvt|vinyl tile)/i],
  ["asphalt_paving", /\b(pav(e|ing)|asphalt|mill and overlay)/i],
  ["striping", /\b(striping|restripe|pavement marking)/i],
  ["electrical", /\b(electric|lighting|generator|switchgear)/i],
  ["plumbing", /\b(plumb|restroom|water line|sewer|domestic water)/i],
  ["fire_protection", /\b(fire alarm|sprinkler|fire protection|fire suppression)/i],
  ["abatement", /\b(asbestos|abatement|lead[- ]based paint|hazardous material)/i],
  ["demolition", /\b(demolition|demolish|demo of)/i],
  ["concrete", /\b(concrete|sidewalk|curb|foundation|slab)/i],
  ["medical_gas", /\bmedical gas/i],
  ["rigging", /\b(crane|rigging)/i],
  ["controls", /\b(building automation|controls upgrade|ddc|bas\b)/i],
  ["sitework", /\b(grading|excavat|site ?work|earthwork|storm ?water|drainage)/i],
  ["framing_drywall", /\b(drywall|framing|partition)/i],
  ["metal_building", /\b(pre-?engineered|metal building)/i],
];

/** Words that mark a big, many-trade job however few trades the text names. */
const COMPLEX_WORDS = /\b(new construction|construct (a |an )?new|design[- ]build|multiple award task order|matoc|idiq|facility construction)\b/i;

/** Share given to a trade the text names that the NAICS code did not bring. */
const NAMED_TRADE_SHARE = 0.15;

/**
 * The trades a listing needs, worked out from its NAICS code and the words in
 * its title and scope, with cost shares that add up to 1. The same listing
 * always gives the same answer.
 */
export function inferTrades(o: Pick<Opportunity, "naicsCode" | "title" | "scopeSummary">): Array<readonly [Trade, number]> {
  const base = NAICS_TRADES.find(([prefix]) => o.naicsCode.startsWith(prefix))?.[1] ?? NAICS_TRADES.at(-1)![1];
  const text = `${o.title} ${o.scopeSummary}`;
  const named = TRADE_WORDS.filter(([, re]) => re.test(text)).map(([t]) => t);
  const weights = new Map<Trade, number>();
  // A building job (236) names its trades better than the generic mix does, when it names any.
  const generic = o.naicsCode.startsWith("236") && named.length > 0;
  if (!generic) for (const [t, w] of base) weights.set(t, w);
  for (const t of named) if (!weights.has(t)) weights.set(t, generic ? 1 : NAMED_TRADE_SHARE);
  const total = [...weights.values()].reduce((a, b) => a + b, 0);
  return [...weights].map(([t, w]) => [t, Math.round((w / total) * 1000) / 1000] as const);
}

/** Easy: one or two trades. Moderate: three to five. Complex: six or more, or new construction. */
export function inferComplexity(o: Pick<Opportunity, "naicsCode" | "title" | "scopeSummary">): Complexity {
  if (COMPLEX_WORDS.test(`${o.title} ${o.scopeSummary}`)) return "complex";
  const n = inferTrades(o).length;
  return n <= 2 ? "easy" : n <= 5 ? "moderate" : "complex";
}

/** Value bands (US dollars) and contract days for a job with no stated estimate. */
const BANDS: Record<Complexity, { usd: [number, number]; days: [number, number] }> = {
  easy: { usd: [50_000, 300_000], days: [10, 25] },
  moderate: { usd: [250_000, 1_500_000], days: [30, 60] },
  complex: { usd: [1_000_000, 10_000_000], days: [120, 240] },
};

const round1000 = (usd: number) => Math.round(usd / 1000) * 1000;

/**
 * The world's scope for a job. A stub job uses its written-out scope. A real
 * listing's trades come from inferTrades; its value is the notice's estimate,
 * or else drawn from the seed within its complexity's band, so a replay sees
 * the same value; its contract time is drawn the same way.
 */
export function simulatedScope(o: Opportunity, rng: SeededRng): SimulatedScope {
  const stub = JOB_SCOPES[o.noticeId];
  const stubDays = JOB_DURATION_DAYS[o.noticeId];
  if (stub && stubDays !== undefined && o.estimatedValueUsd) {
    return { trades: stub.map(([t, s]) => [t, s] as const), valueUsd: { ...o.estimatedValueUsd }, contractDays: stubDays };
  }
  const r = rng.fork("scope");
  const band = BANDS[o.complexity ?? inferComplexity(o)];
  let valueUsd = o.estimatedValueUsd ? { ...o.estimatedValueUsd } : null;
  if (!valueUsd) {
    // Log-uniform, so a band from $1M to $10M is not mostly $5M-$10M jobs.
    const [lo, hi] = band.usd;
    const mid = Math.exp(Math.log(lo) + r.fork("value").next() * (Math.log(hi) - Math.log(lo)));
    valueUsd = { min: round1000(mid * 0.8), max: round1000(mid * 1.25) };
  }
  return { trades: inferTrades(o), valueUsd, contractDays: r.fork("days").int(...band.days) };
}
