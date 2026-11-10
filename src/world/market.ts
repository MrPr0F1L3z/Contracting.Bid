import type { Opportunity } from "../opportunities/types.js";
import type { ScheduledProblem } from "../sim/problems.js";
import type { SeededRng } from "../sim/rng.js";

/** Trades the simulated subcontractor market quotes. Agents must use these names. */
export const TRADES = [
  "sitework",
  "asphalt_paving",
  "striping",
  "concrete",
  "demolition",
  "abatement",
  "metal_building",
  "framing_drywall",
  "painting",
  "flooring",
  "roofing",
  "rigging",
  "plumbing",
  "medical_gas",
  "fire_protection",
  "hvac",
  "controls",
  "electrical",
  "equipment",
] as const;
export type Trade = (typeof TRADES)[number];

export function isTrade(value: string): value is Trade {
  return (TRADES as readonly string[]).includes(value);
}

/**
 * The trades each stub job really needs, with each trade's share of the
 * subcontracted cost. The world knows this; the Estimator has to work it out
 * from the scope text. A bid that leaves out a required trade is not responsive.
 */
export const JOB_SCOPES: Readonly<Record<string, ReadonlyArray<readonly [Trade, number]>>> = {
  "STUB-E01": [["asphalt_paving", 0.7], ["concrete", 0.2], ["striping", 0.1]],
  "STUB-E02": [["painting", 0.45], ["flooring", 0.55]],
  "STUB-M01": [["demolition", 0.1], ["framing_drywall", 0.35], ["electrical", 0.25], ["painting", 0.12], ["flooring", 0.18]],
  "STUB-M02": [["hvac", 0.6], ["roofing", 0.15], ["controls", 0.1], ["rigging", 0.08], ["electrical", 0.07]],
  "STUB-C01": [
    ["sitework", 0.15], ["concrete", 0.12], ["metal_building", 0.3], ["plumbing", 0.08],
    ["fire_protection", 0.08], ["hvac", 0.1], ["electrical", 0.12], ["equipment", 0.05],
  ],
  "STUB-C02": [
    ["abatement", 0.12], ["demolition", 0.06], ["medical_gas", 0.1], ["plumbing", 0.14], ["hvac", 0.2],
    ["electrical", 0.18], ["framing_drywall", 0.12], ["painting", 0.04], ["flooring", 0.04],
  ],
};

export interface Quote {
  quoteId: string;
  trade: Trade;
  subcontractor: string;
  priceUsd: number;
  validDays: number;
}

export interface Selection {
  quote: Quote;
  /** Set when the quote expired at selection and the sub re-quoted. */
  repricedFromUsd?: number;
}

const SUB_NAMES = ["Apex", "Bluestone", "Cardinal", "Delta", "Evergreen", "Frontier", "Granite", "Harbor", "Ironwood", "Keystone"];

const round100 = (usd: number) => Math.round(usd / 100) * 100;

/**
 * The simulated outside world for one bid: the subcontractor market and the
 * competing bidders. Everything is drawn from the run's seed, so a replay
 * sees the same quotes, competitors and award.
 */
export class BidWorld {
  readonly requiredTrades: Trade[];
  /** What the subcontracted work really costs, by trade. Hidden from agents. */
  readonly trueCost: ReadonlyMap<Trade, number>;
  private readonly quotes = new Map<Trade, Quote[]>();
  private readonly selections = new Map<Trade, Selection>();
  private readonly expiringTrade: Trade | null;
  private readonly rng: SeededRng;

  constructor(
    readonly opportunity: Opportunity,
    rng: SeededRng,
    problems: readonly ScheduledProblem[] = [],
  ) {
    const scope = JOB_SCOPES[opportunity.noticeId];
    if (!scope || !opportunity.estimatedValueUsd) throw new Error(`No simulated scope for ${opportunity.noticeId}`);
    this.rng = rng.fork("market");
    const { min, max } = opportunity.estimatedValueUsd;
    // Sub costs run below the government's range; the GC adds overhead and profit on top.
    const total = ((min + max) / 2) * (0.75 + this.rng.fork("total").next() * 0.15);
    this.requiredTrades = scope.map(([t]) => t);
    this.trueCost = new Map(scope.map(([t, share]) => [t, round100(total * share)]));
    const expires = problems.some((p) => p.problem.id === "quote-expired");
    this.expiringTrade = expires ? this.rng.fork("quote-expired").pick(this.requiredTrades) : null;
  }

  /** The problem this world injects during bidding, if any. */
  injectedProblem(): { id: "quote-expired"; trade: Trade } | null {
    return this.expiringTrade ? { id: "quote-expired", trade: this.expiringTrade } : null;
  }

  /**
   * Quotes from 2 or 3 subs for a trade. A trade the job doesn't need still
   * gets quotes (subs will price anything), priced off a small allowance.
   */
  quotesFor(trade: Trade): Quote[] {
    const cached = this.quotes.get(trade);
    if (cached) return cached.map((q) => ({ ...q }));
    const r = this.rng.fork(`quotes:${trade}`);
    const base = this.trueCost.get(trade) ?? round100((this.opportunity.estimatedValueUsd?.min ?? 50_000) * 0.05);
    const names = r.sample(SUB_NAMES, 3);
    const count = r.int(2, 3);
    const list: Quote[] = Array.from({ length: count }, (_, i) => ({
      quoteId: `Q-${trade}-${i + 1}`,
      trade,
      subcontractor: `${names[i]} ${trade.replace(/_/g, " ")}`,
      priceUsd: round100(base * (0.92 + r.next() * 0.38)),
      validDays: 30,
    }));
    this.quotes.set(trade, list);
    return list.map((q) => ({ ...q }));
  }

  /**
   * Selects a quote. If the quote-expired problem targets this trade, the
   * first selection finds the quote expired and the sub re-quotes 8-15% higher.
   */
  select(quoteId: string): Selection {
    const trade = quoteId.replace(/^Q-/, "").replace(/-\d+$/, "");
    if (!isTrade(trade)) throw new Error(`Unknown quote ${quoteId}`);
    const quote = this.quotes.get(trade)?.find((q) => q.quoteId === quoteId);
    if (!quote) throw new Error(`Unknown quote ${quoteId}; request quotes for ${trade} first`);
    let selection: Selection = { quote: { ...quote } };
    if (trade === this.expiringTrade && !this.selections.has(trade)) {
      const raised = round100(quote.priceUsd * (1.08 + this.rng.fork("requote").next() * 0.07));
      quote.priceUsd = raised;
      selection = { quote: { ...quote }, repricedFromUsd: selection.quote.priceUsd };
    }
    this.selections.set(trade, selection);
    return { ...selection, quote: { ...selection.quote } };
  }

  selected(): Map<Trade, Selection> {
    return new Map(this.selections);
  }

  /** Competing bids, drawn once per world. */
  competitorBids(): number[] {
    const r = this.rng.fork("competitors");
    const cost = [...this.trueCost.values()].reduce((a, b) => a + b, 0);
    return Array.from({ length: r.int(2, 4) }, () => round100(cost * (1.08 + r.next() * 0.27)));
  }

  /**
   * The contracting officer's decision, lowest price technically acceptable:
   * a bid must cover every required trade with a selected quote, and the
   * lowest responsive price wins.
   */
  evaluate(bidPriceUsd: number): Award {
    const competitors = this.competitorBids();
    const missing = this.requiredTrades.filter((t) => !this.selections.has(t));
    if (missing.length > 0) {
      return { awarded: false, reason: `Not responsive: no subcontractor priced for ${missing.join(", ")}`, bidPriceUsd, competitors, rank: null, missingTrades: missing };
    }
    const rank = 1 + competitors.filter((c) => c < bidPriceUsd).length;
    return rank === 1
      ? { awarded: true, reason: "Lowest responsive bid", bidPriceUsd, competitors, rank, missingTrades: [] }
      : { awarded: false, reason: `Bid ranked ${rank} of ${competitors.length + 1}; lowest was $${Math.min(...competitors).toLocaleString("en-US")}`, bidPriceUsd, competitors, rank, missingTrades: [] };
  }
}

export interface Award {
  awarded: boolean;
  reason: string;
  bidPriceUsd: number;
  competitors: number[];
  /** 1 is lowest; null when the bid was not responsive. */
  rank: number | null;
  missingTrades: Trade[];
}
