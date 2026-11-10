import { describe, expect, it } from "vitest";
import { EXECUTION_PROBLEMS, JOB_DURATION_DAYS, SiteWorld, TRADE_RANK, isExecutionProblem } from "../src/world/site.js";
import { BidWorld, JOB_SCOPES, TRADES } from "../src/world/market.js";
import { STUB_OPPORTUNITIES } from "../src/opportunities/stub.js";
import { PROBLEM_CATALOG, type ScheduledProblem } from "../src/sim/problems.js";
import { SeededRng } from "../src/sim/rng.js";

const job = (id: string) => STUB_OPPORTUNITIES.find((o) => o.noticeId === id)!;
const sched = (...ids: Array<[string, number]>): ScheduledProblem[] =>
  ids.map(([id, phaseProgress]) => ({ problem: PROBLEM_CATALOG.find((p) => p.id === id)!, phaseProgress }));

/** A site for a job with the first quote selected in every required trade. */
function site(id = "STUB-E02", seed = 1, problems: ScheduledProblem[] = [], price = 100_000) {
  const bid = new BidWorld(job(id), new SeededRng(seed));
  for (const t of bid.requiredTrades) bid.select(bid.quotesFor(t)[0]!.quoteId);
  return new SiteWorld(bid, price, new SeededRng(seed), problems);
}

describe("site constants", () => {
  it("has a duration for every scoped job and a rank for every trade", () => {
    expect(Object.keys(JOB_DURATION_DAYS).sort()).toEqual(Object.keys(JOB_SCOPES).sort());
    expect(Object.keys(TRADE_RANK).sort()).toEqual([...TRADES].sort());
  });
  it("knows which problems act during execution", () => {
    expect(EXECUTION_PROBLEMS.every((id) => PROBLEM_CATALOG.some((p) => p.id === id && p.phase === "execute"))).toBe(true);
    expect(isExecutionProblem("weather-delay")).toBe(true);
    expect(isExecutionProblem("late-payment")).toBe(false);
  });
});

describe("SiteWorld", () => {
  it("refuses a job with no duration", () => {
    const bid = new BidWorld(job("STUB-E02"), new SeededRng(1));
    const fake = Object.assign(Object.create(Object.getPrototypeOf(bid)), bid, { opportunity: { ...job("STUB-E02"), noticeId: "STUB-ZZ" } });
    expect(() => new SiteWorld(fake, 1, new SeededRng(1), [])).toThrow("No simulated duration for STUB-ZZ");
  });

  it("sets contract time, liquidated damages and durations that leave 10% float", () => {
    const s = site("STUB-E02", 1, [], 100_000);
    expect(s.contractDays).toBe(15);
    expect(s.ldPerDayUsd).toBe(250);
    expect(site("STUB-C01", 1, [], 5_000_000).ldPerDayUsd).toBe(10_000);
    const total = [...s.subcontracts.keys()].reduce((a, t) => a + s.durationOf(t), 0);
    expect(total).toBeGreaterThanOrEqual(12);
    expect(total).toBeLessThanOrEqual(15);
    expect(() => s.durationOf("roofing")).toThrow("No subcontract for roofing");
  });

  describe("setSchedule", () => {
    it("rejects missing, extra, repeated and out-of-order trades", () => {
      const s = site();
      expect(s.setSchedule(["painting"])).toBe("The schedule leaves out flooring");
      expect(s.setSchedule(["painting", "flooring", "roofing"])).toBe("No subcontract for roofing");
      expect(s.setSchedule(["painting", "flooring", "painting"])).toBe("Each trade must appear once");
      expect(s.setSchedule(["flooring", "painting"])).toBe("painting must come before flooring");
      expect(s.scheduled()).toBeNull();
      expect(s.plannedDays()).toBe(0);
    });
    it("lays trades end to end", () => {
      const s = site();
      expect(s.setSchedule(["painting", "flooring"])).toBeNull();
      const p = s.durationOf("painting");
      expect(s.scheduled()).toEqual([
        { trade: "painting", startDay: 0, days: p },
        { trade: "flooring", startDay: p, days: s.durationOf("flooring") },
      ]);
      expect(s.plannedDays()).toBe(p + s.durationOf("flooring"));
    });
  });

  describe("siteProblems", () => {
    it("needs a schedule, and ignores problems from other phases", () => {
      const s = site("STUB-E02", 1, sched(["late-payment", 0.5], ["quote-expired", 0.1]));
      expect(() => s.siteProblems()).toThrow("Set the schedule first");
      s.setSchedule(["painting", "flooring"]);
      expect(s.siteProblems()).toEqual([]);
    });

    it("places each problem on its day and trade, in day order, with hidden conditions first", () => {
      const s = site("STUB-E02", 1, sched(["late-delivery", 0.9], ["hidden-conditions", 0.5], ["weather-delay", 0.0]));
      s.setSchedule(["painting", "flooring"]);
      const ps = s.siteProblems();
      expect(ps.map((p) => [p.id, p.trade])).toEqual([["weather-delay", "painting"], ["hidden-conditions", "painting"], ["late-delivery", "flooring"]]);
      expect(ps.map((p) => p.day)).toEqual([0, 0, Math.floor(0.9 * s.plannedDays())]);
    });

    it("prices each fixed-option problem off the affected subcontract", () => {
      const s = site("STUB-E02", 2, sched(["late-delivery", 0.1], ["weather-delay", 0.2], ["sub-no-show", 0.3], ["double-booked", 0.4], ["failed-inspection", 0.6]));
      s.setSchedule(["painting", "flooring"]);
      const byId = Object.fromEntries(s.siteProblems().map((p) => [p.id, p]));
      for (const p of Object.values(byId)) {
        expect(p.change).toBeNull();
        expect(p.options).toHaveLength(2);
      }
      const price = (t: string) => s.subcontracts.get(t as never)!.priceUsd;
      const late = byId["late-delivery"]!;
      expect(late.options).toEqual([
        expect.objectContaining({ id: "expedite", days: 0, costUsd: Math.round((price(late.trade) * 0.04) / 100) * 100 }),
        expect.objectContaining({ id: "accept_delay", costUsd: 0, days: Math.ceil(s.durationOf(late.trade) * 0.3) + 1 }),
      ]);
      const weather = byId["weather-delay"]!.options[0]!;
      expect(weather.days).toBeGreaterThanOrEqual(2);
      expect(weather.days).toBeLessThanOrEqual(4);
      expect(byId["sub-no-show"]!.options.map((o) => o.id)).toEqual(["replace_sub", "wait_for_sub"]);
      expect(byId["sub-no-show"]!.options[0]!.costUsd).toBeGreaterThanOrEqual(0);
      expect(byId["double-booked"]!.options.map((o) => o.id)).toEqual(["pay_overtime", "resequence"]);
      expect(byId["failed-inspection"]!.options.map((o) => [o.id, o.days])).toEqual([["backcharge_sub", 3], ["pay_rework", 1]]);
    });

    it("prices a sub no-show replacement at 115% when no other quote exists", () => {
      const bid = new BidWorld(job("STUB-E02"), new SeededRng(1));
      for (const t of bid.requiredTrades) bid.select(bid.quotesFor(t)[0]!.quoteId);
      // Hide the other quotes so the replacement has to be priced from scratch.
      (bid as unknown as { quotesFor: () => [] }).quotesFor = () => [];
      const s = new SiteWorld(bid, 100_000, new SeededRng(1), sched(["sub-no-show", 0]));
      s.setSchedule(["painting", "flooring"]);
      const opt = s.siteProblems()[0]!.options[0]!;
      expect(opt.label).toMatch(/^Replace them with a new sub at about \$/);
      expect(opt.costUsd).toBe(Math.round((s.subcontracts.get("painting")!.priceUsd * 1.15) / 100) * 100 - s.subcontracts.get("painting")!.priceUsd);
    });

    it("turns change orders and hidden conditions into scope changes with a hidden cost", () => {
      const s = site("STUB-E02", 3, sched(["change-order", 0.5], ["hidden-conditions", 0.2]));
      s.setSchedule(["painting", "flooring"]);
      const [hidden, co] = s.siteProblems();
      expect(hidden!.change).toMatchObject({ initiatedBy: "contractor" });
      expect(co!.change).toMatchObject({ initiatedBy: "government" });
      const subs = [...s.subcontracts.values()].reduce((a, q) => a + q.priceUsd, 0);
      expect(co!.change!.costUsd).toBeGreaterThanOrEqual(subs * 0.05 - 100);
      expect(co!.change!.costUsd).toBeLessThanOrEqual(subs * 0.12 + 100);
      expect(hidden!.change!.costUsd).toBeLessThanOrEqual(subs * 0.08 + 100);
      expect(co!.options).toEqual([]);
      expect(co!.change!.days).toBeGreaterThanOrEqual(1);
    });

    it("draws the same problems for the same seed", () => {
      const make = () => {
        const s = site("STUB-M01", 5, sched(["change-order", 0.3], ["weather-delay", 0.7]));
        s.setSchedule(["demolition", "framing_drywall", "electrical", "painting", "flooring"]);
        return s.siteProblems();
      };
      expect(make()).toEqual(make());
    });
  });

  describe("judgeChangeOrder", () => {
    const change = { initiatedBy: "government" as const, description: "", costUsd: 10_000, days: 4 };
    it("accepts up to 10% over cost plus 15%, and up to half again the days", () => {
      const s = site();
      expect(s.judgeChangeOrder(change, 12_650, 6)).toEqual({ accepted: true, reason: "Accepted as priced." });
      expect(s.judgeChangeOrder(change, 12_651, 4).accepted).toBe(false);
      expect(s.judgeChangeOrder(change, 12_651, 4).reason).toMatch(/above the government's estimate/);
      expect(s.judgeChangeOrder(change, 10_000, 7)).toEqual({ accepted: false, reason: "The time extension is more than the change justifies." });
    });
  });

  describe("finalAccount", () => {
    it("adds problem costs and delays, change order revenue and extensions, and liquidated damages", () => {
      const s = site("STUB-E02", 1, [], 100_000);
      s.setSchedule(["painting", "flooring"]);
      const planned = s.plannedDays();
      const subs = [...s.subcontracts.values()].reduce((a, q) => a + q.priceUsd, 0);
      expect(s.finalAccount()).toEqual({
        contractPriceUsd: 100_000, changeOrderRevenueUsd: 0, liquidatedDamagesUsd: 0, revenueUsd: 100_000,
        subcontractUsd: subs, problemCostUsd: 0, costUsd: subs, profitUsd: 100_000 - subs,
        plannedDays: planned, contractDays: 15, actualDays: planned, daysLate: 0,
      });
      s.record({ problemId: "weather-delay", trade: "painting", choice: "accept_delay", costUsd: 0, days: 6 });
      s.record({ problemId: "change-order", trade: "flooring", choice: "change_order", costUsd: 5_000, days: 2, changeOrder: { priceUsd: 6_000, days: 1 } });
      const a = s.finalAccount();
      expect(a).toMatchObject({ changeOrderRevenueUsd: 6_000, contractDays: 16, actualDays: planned + 8, problemCostUsd: 5_000 });
      expect(a.daysLate).toBe(Math.max(0, planned + 8 - 16));
      expect(a.liquidatedDamagesUsd).toBe(a.daysLate * 250);
      expect(a.revenueUsd).toBe(106_000 - a.liquidatedDamagesUsd);
      expect(a.profitUsd).toBe(a.revenueUsd - subs - 5_000);
      expect(s.resolved()).toHaveLength(2);
    });
  });
});
