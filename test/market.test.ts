import { describe, expect, it } from "vitest";
import { BidWorld, JOB_SCOPES, TRADES, isTrade } from "../src/world/market.js";
import { STUB_OPPORTUNITIES } from "../src/opportunities/stub.js";
import { isBiddableConstruction } from "../src/opportunities/pick.js";
import { SeededRng } from "../src/sim/rng.js";
import { PROBLEM_CATALOG, type ScheduledProblem } from "../src/sim/problems.js";
import type { Opportunity } from "../src/opportunities/types.js";

const job = (id: string) => STUB_OPPORTUNITIES.find((o) => o.noticeId === id)!;
const expired: ScheduledProblem[] = [{ problem: PROBLEM_CATALOG.find((p) => p.id === "quote-expired")!, phaseProgress: 0.5 }];

describe("isTrade", () => {
  it("accepts only the market's trade names", () => {
    expect(isTrade("painting")).toBe(true);
    expect(isTrade("Painting")).toBe(false);
    expect(isTrade("carpentry")).toBe(false);
  });
});

describe("JOB_SCOPES", () => {
  it("covers every biddable stub job, with known trades and shares that sum to 1", () => {
    const biddable = STUB_OPPORTUNITIES.filter(isBiddableConstruction).map((o) => o.noticeId).sort();
    expect(Object.keys(JOB_SCOPES).sort()).toEqual(biddable);
    for (const scope of Object.values(JOB_SCOPES)) {
      expect(scope.every(([t]) => (TRADES as readonly string[]).includes(t))).toBe(true);
      expect(scope.reduce((a, [, s]) => a + s, 0)).toBeCloseTo(1, 9);
      expect(new Set(scope.map(([t]) => t)).size).toBe(scope.length);
    }
  });
});

describe("BidWorld", () => {
  it("refuses a job it has no scope for", () => {
    expect(() => new BidWorld(job("STUB-X01"), new SeededRng(1))).toThrow("No simulated scope for STUB-X01");
    const noValue = { ...job("STUB-E01"), estimatedValueUsd: null } as Opportunity;
    expect(() => new BidWorld(noValue, new SeededRng(1))).toThrow("No simulated scope");
  });

  it("prices the true cost below the government range, by required trade", () => {
    const w = new BidWorld(job("STUB-E02"), new SeededRng(3));
    expect(w.requiredTrades).toEqual(["painting", "flooring"]);
    const total = [...w.trueCost.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(105_000 * 0.75 - 100);
    expect(total).toBeLessThanOrEqual(105_000 * 0.9 + 100);
    expect(w.injectedProblem()).toBeNull();
  });

  it("is the same world for the same seed", () => {
    const a = new BidWorld(job("STUB-M01"), new SeededRng(7));
    const b = new BidWorld(job("STUB-M01"), new SeededRng(7));
    expect([...a.trueCost]).toEqual([...b.trueCost]);
    expect(a.quotesFor("electrical")).toEqual(b.quotesFor("electrical"));
    expect(a.competitorBids()).toEqual(b.competitorBids());
    expect([...new BidWorld(job("STUB-M01"), new SeededRng(8)).trueCost]).not.toEqual([...a.trueCost]);
  });

  it("gives 2 or 3 quotes near the true cost, the same each time, as copies", () => {
    const w = new BidWorld(job("STUB-C01"), new SeededRng(11));
    const quotes = w.quotesFor("hvac");
    expect(quotes.length).toBeGreaterThanOrEqual(2);
    expect(quotes.length).toBeLessThanOrEqual(3);
    const cost = w.trueCost.get("hvac")!;
    for (const [i, q] of quotes.entries()) {
      expect(q).toMatchObject({ quoteId: `Q-hvac-${i + 1}`, trade: "hvac", validDays: 30 });
      expect(q.subcontractor).toMatch(/ hvac$/);
      expect(q.priceUsd).toBeGreaterThanOrEqual(cost * 0.92 - 100);
      expect(q.priceUsd).toBeLessThanOrEqual(cost * 1.3 + 100);
    }
    quotes[0]!.priceUsd = 1;
    expect(w.quotesFor("hvac")[0]!.priceUsd).not.toBe(1);
  });

  it("prices a trade the job does not need off a small allowance", () => {
    const w = new BidWorld(job("STUB-E02"), new SeededRng(2));
    const q = w.quotesFor("roofing");
    expect(q[0]!.priceUsd).toBeGreaterThanOrEqual(3_000 * 0.92 - 100);
    expect(q[0]!.priceUsd).toBeLessThanOrEqual(3_000 * 1.3 + 100);
  });

  it("selects only quotes it has given, one per trade", () => {
    const w = new BidWorld(job("STUB-E02"), new SeededRng(2));
    expect(() => w.select("Q-carpentry-1")).toThrow("Unknown quote Q-carpentry-1");
    expect(() => w.select("Q-painting-1")).toThrow("request quotes for painting first");
    const [first, second] = w.quotesFor("painting");
    expect(w.select(first!.quoteId)).toEqual({ quote: first });
    expect(w.select(second!.quoteId)).toEqual({ quote: second });
    expect([...w.selected().keys()]).toEqual(["painting"]);
    expect(() => w.select("Q-painting-9")).toThrow("Unknown quote Q-painting-9");
  });

  it("re-prices the first selection 8-15% higher in the trade the quote-expired problem targets", () => {
    const w = new BidWorld(job("STUB-E02"), new SeededRng(5), expired);
    const inj = w.injectedProblem();
    expect(inj?.id).toBe("quote-expired");
    const trade = inj!.trade;
    expect(w.requiredTrades).toContain(trade);
    const [q] = w.quotesFor(trade);
    const sel = w.select(q!.quoteId);
    expect(sel.repricedFromUsd).toBe(q!.priceUsd);
    expect(sel.quote.priceUsd).toBeGreaterThanOrEqual(q!.priceUsd * 1.08 - 100);
    expect(sel.quote.priceUsd).toBeLessThanOrEqual(q!.priceUsd * 1.15 + 100);
    // Later quote lists show the new price, and a reselection is not re-priced again.
    expect(w.quotesFor(trade)[0]!.priceUsd).toBe(sel.quote.priceUsd);
    expect(w.select(q!.quoteId).repricedFromUsd).toBeUndefined();
  });

  it("draws 2-4 competitors at 8-35% over the true cost", () => {
    const w = new BidWorld(job("STUB-M02"), new SeededRng(4));
    const cost = [...w.trueCost.values()].reduce((a, b) => a + b, 0);
    const bids = w.competitorBids();
    expect(bids.length).toBeGreaterThanOrEqual(2);
    expect(bids.length).toBeLessThanOrEqual(4);
    for (const b of bids) {
      expect(b).toBeGreaterThanOrEqual(cost * 1.08 - 100);
      expect(b).toBeLessThanOrEqual(cost * 1.35 + 100);
    }
  });

  describe("evaluate", () => {
    const priced = (seed: number) => {
      const w = new BidWorld(job("STUB-E02"), new SeededRng(seed));
      for (const t of w.requiredTrades) w.select(w.quotesFor(t)[0]!.quoteId);
      return w;
    };
    it("is not responsive when a required trade has no selected quote", () => {
      const w = new BidWorld(job("STUB-E02"), new SeededRng(1));
      w.select(w.quotesFor("painting")[0]!.quoteId);
      expect(w.evaluate(1)).toMatchObject({ awarded: false, rank: null, missingTrades: ["flooring"], reason: "Not responsive: no subcontractor priced for flooring" });
    });
    it("awards the lowest responsive bid", () => {
      const w = priced(1);
      const low = Math.min(...w.competitorBids());
      expect(w.evaluate(low - 100)).toMatchObject({ awarded: true, rank: 1, reason: "Lowest responsive bid", bidPriceUsd: low - 100 });
    });
    it("ranks a bid that is not lowest", () => {
      const w = priced(1);
      const bids = w.competitorBids();
      const high = Math.max(...bids) + 100;
      expect(w.evaluate(high)).toMatchObject({
        awarded: false,
        rank: bids.length + 1,
        reason: `Bid ranked ${bids.length + 1} of ${bids.length + 1}; lowest was $${Math.min(...bids).toLocaleString("en-US")}`,
        competitors: bids,
      });
    });
    it("a tie with a competitor does not lose", () => {
      const w = priced(1);
      expect(w.evaluate(Math.min(...w.competitorBids())).awarded).toBe(true);
    });
  });
});
