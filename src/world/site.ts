import type { ScheduledProblem } from "../sim/problems.js";
import type { SeededRng } from "../sim/rng.js";
import type { BidWorld, Quote, Trade } from "./market.js";

/** Contract duration of each stub job, in working days, from its scope text. */
export const JOB_DURATION_DAYS: Readonly<Record<string, number>> = {
  "STUB-E01": 10,
  "STUB-E02": 15,
  "STUB-M01": 30,
  "STUB-M02": 40,
  "STUB-C01": 195,
  "STUB-C02": 150,
};

/**
 * Sequencing rank: a trade may not start before every trade with a lower
 * rank. Trades with the same rank can go in any order.
 */
export const TRADE_RANK: Readonly<Record<Trade, number>> = {
  abatement: 0,
  demolition: 1,
  sitework: 1,
  concrete: 2,
  metal_building: 3,
  rigging: 3,
  roofing: 4,
  framing_drywall: 4,
  plumbing: 5,
  medical_gas: 5,
  fire_protection: 5,
  hvac: 5,
  electrical: 5,
  controls: 6,
  equipment: 6,
  painting: 7,
  flooring: 8,
  asphalt_paving: 8,
  striping: 9,
};

/** The execution problems this simulator acts on. Others belong to other phases. */
export const EXECUTION_PROBLEMS = [
  "late-delivery",
  "weather-delay",
  "sub-no-show",
  "double-booked",
  "failed-inspection",
  "change-order",
  "hidden-conditions",
] as const;
export type ExecutionProblemId = (typeof EXECUTION_PROBLEMS)[number];

export function isExecutionProblem(id: string): id is ExecutionProblemId {
  return (EXECUTION_PROBLEMS as readonly string[]).includes(id);
}

/** One way to resolve a problem, with its cost to the company and delay in working days. */
export interface ProblemOption {
  id: string;
  label: string;
  costUsd: number;
  days: number;
}

/** A change in scope. Its true cost and days are hidden; the PM prices it for the contracting officer. */
export interface ScopeChange {
  initiatedBy: "government" | "contractor";
  description: string;
  /** What the change costs the company: the subcontractor's quote for it, shown to the PM. */
  costUsd: number;
  /** How many working days it adds, as the subcontractor quotes them. */
  days: number;
}

export interface SiteProblem {
  id: ExecutionProblemId;
  trade: Trade;
  /** Working day of the job the problem appears on. */
  day: number;
  description: string;
  /** Fixed choices; empty for a scope change, which is priced instead. */
  options: ProblemOption[];
  change: ScopeChange | null;
}

export interface Resolution {
  problemId: ExecutionProblemId;
  trade: Trade;
  choice: string;
  costUsd: number;
  days: number;
  /** Set for a scope change: what the government agreed to pay and extend, if anything. */
  changeOrder?: { priceUsd: number; days: number } | null;
}

export interface ScheduleLine {
  trade: Trade;
  startDay: number;
  days: number;
}

export interface ChangeOrderDecision {
  accepted: boolean;
  reason: string;
}

const round100 = (usd: number) => Math.round(usd / 100) * 100;
const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

/**
 * The simulated job site for one awarded job. It knows the subcontracts,
 * the real durations, and which execution problems fire on which day.
 * Every draw is seeded, so a replay sees the same job.
 */
export class SiteWorld {
  readonly contractDays: number;
  /** Liquidated damages per working day late. */
  readonly ldPerDayUsd: number;
  readonly subcontracts: ReadonlyMap<Trade, Quote>;
  private readonly durations: Map<Trade, number>;
  private readonly rng: SeededRng;
  private readonly problems: ScheduledProblem[];
  private schedule: ScheduleLine[] | null = null;
  private readonly resolutions: Resolution[] = [];
  private extendedDays = 0;
  private changeRevenue = 0;

  constructor(
    readonly bid: BidWorld,
    readonly contractPriceUsd: number,
    rng: SeededRng,
    problems: readonly ScheduledProblem[],
  ) {
    const days = JOB_DURATION_DAYS[bid.opportunity.noticeId];
    if (days === undefined) throw new Error(`No simulated duration for ${bid.opportunity.noticeId}`);
    this.rng = rng.fork("site");
    this.contractDays = days;
    this.ldPerDayUsd = Math.max(250, round100(contractPriceUsd * 0.002));
    this.subcontracts = new Map([...bid.selected()].map(([t, s]) => [t, { ...s.quote }]));
    // Trades run one after another and use 90% of the contract time, leaving 10% float.
    const total = [...bid.trueCost.values()].reduce((a, b) => a + b, 0);
    this.durations = new Map(
      [...this.subcontracts.keys()].map((t) => [t, Math.max(1, Math.round(((bid.trueCost.get(t) ?? total * 0.05) / total) * days * 0.9))]),
    );
    this.problems = problems.filter((p) => isExecutionProblem(p.problem.id)).sort((a, b) => a.phaseProgress - b.phaseProgress);
  }

  durationOf(trade: Trade): number {
    const d = this.durations.get(trade);
    if (d === undefined) throw new Error(`No subcontract for ${trade}`);
    return d;
  }

  /** Validates and records a trade sequence. Returns an error message, or null when accepted. */
  setSchedule(sequence: readonly string[]): string | null {
    const trades = [...this.subcontracts.keys()];
    const missing = trades.filter((t) => !sequence.includes(t));
    if (missing.length > 0) return `The schedule leaves out ${missing.join(", ")}`;
    const extra = sequence.filter((t) => !this.subcontracts.has(t as Trade));
    if (extra.length > 0) return `No subcontract for ${extra.join(", ")}`;
    if (new Set(sequence).size !== sequence.length) return "Each trade must appear once";
    for (let i = 1; i < sequence.length; i++) {
      const prev = sequence[i - 1] as Trade;
      const cur = sequence[i] as Trade;
      if (TRADE_RANK[cur] < TRADE_RANK[prev]) return `${cur} must come before ${prev}`;
    }
    let day = 0;
    this.schedule = sequence.map((t) => {
      const line = { trade: t as Trade, startDay: day, days: this.durationOf(t as Trade) };
      day += line.days;
      return line;
    });
    return null;
  }

  scheduled(): ScheduleLine[] | null {
    return this.schedule ? this.schedule.map((l) => ({ ...l })) : null;
  }

  plannedDays(): number {
    return (this.schedule ?? []).reduce((a, l) => a + l.days, 0);
  }

  /** The execution problems for this job, in the order they appear. Needs a schedule. */
  siteProblems(): SiteProblem[] {
    const schedule = this.schedule;
    if (!schedule) throw new Error("Set the schedule first");
    const planned = this.plannedDays();
    return this.problems.map((p) => {
      const id = p.problem.id as ExecutionProblemId;
      const r = this.rng.fork(`problem:${id}`);
      const day = Math.min(planned - 1, Math.floor(p.phaseProgress * planned));
      // Hidden conditions show up in the first trade; the rest hit the trade working that day.
      const active = schedule.find((l) => day >= l.startDay && day < l.startDay + l.days) ?? schedule[schedule.length - 1]!;
      const trade = id === "hidden-conditions" ? schedule[0]!.trade : active.trade;
      return this.describe(id, trade, id === "hidden-conditions" ? 0 : day, r);
    }).sort((a, b) => a.day - b.day);
  }

  private describe(id: ExecutionProblemId, trade: Trade, day: number, r: SeededRng): SiteProblem {
    const sub = this.subcontracts.get(trade)!;
    const p = sub.priceUsd;
    const d = this.durationOf(trade);
    const name = trade.replace(/_/g, " ");
    const base = { id, trade, day, change: null };
    switch (id) {
      case "late-delivery":
        return { ...base, description: `Material for ${name} is arriving late and partly wrong.`, options: [
          { id: "expedite", label: "Pay to air-freight the right material", costUsd: round100(p * 0.04), days: 0 },
          { id: "accept_delay", label: "Wait for the corrected delivery", costUsd: 0, days: Math.ceil(d * 0.3) + 1 },
        ] };
      case "weather-delay": {
        const lost = r.int(2, 4);
        return { ...base, description: `Weather has stopped deliveries and ${name} work for ${lost} days.`, options: [
          { id: "accept_delay", label: "Wait out the weather", costUsd: 0, days: lost },
          { id: "work_weekends", label: "Make up the time with weekend shifts", costUsd: round100(p * 0.03), days: 1 },
        ] };
      }
      case "sub-no-show": {
        const next = this.bid.quotesFor(trade).filter((q) => q.quoteId !== sub.quoteId).sort((a, b) => a.priceUsd - b.priceUsd)[0];
        const replacement = next ? next.priceUsd : round100(p * 1.15);
        return { ...base, description: `${sub.subcontractor} did not show up and is not answering.`, options: [
          { id: "replace_sub", label: next ? `Replace them with ${next.subcontractor} at ${usd(replacement)}` : `Replace them with a new sub at about ${usd(replacement)}`, costUsd: Math.max(0, replacement - p), days: 3 },
          { id: "wait_for_sub", label: "Wait for them to return", costUsd: 0, days: Math.ceil(d * 0.5) + 3 },
        ] };
      }
      case "double-booked":
        return { ...base, description: `${sub.subcontractor} has double-booked its crew on another job this week.`, options: [
          { id: "pay_overtime", label: "Pay overtime for a second crew", costUsd: round100(p * 0.05), days: 0 },
          { id: "resequence", label: "Wait for the crew", costUsd: 0, days: 2 },
        ] };
      case "failed-inspection":
        return { ...base, description: `The ${name} work failed inspection.`, options: [
          { id: "backcharge_sub", label: "Make the sub fix it at its own cost, then reinspect", costUsd: 0, days: 3 },
          { id: "pay_rework", label: "Pay another crew to fix it at once, then reinspect", costUsd: round100(p * 0.06), days: 1 },
        ] };
      case "change-order":
      case "hidden-conditions": {
        const gov = id === "change-order";
        const total = [...this.subcontracts.values()].reduce((a, q) => a + q.priceUsd, 0);
        const cost = round100(total * (gov ? 0.05 + r.next() * 0.07 : 0.03 + r.next() * 0.05));
        const days = Math.max(1, Math.round(this.contractDays * (0.02 + r.next() * 0.04)));
        const description = gov
          ? `The contracting officer directs added ${name} work beyond the contract scope, about ${Math.round((cost / Math.max(1, p)) * 100)}% of the ${name} subcontract's size.`
          : `Opening up the existing work for ${name} found conditions the drawings did not show: rotted framing and undocumented utilities.`;
        return { ...base, description, options: [], change: { initiatedBy: gov ? "government" : "contractor", description, costUsd: cost, days } };
      }
    }
  }

  /**
   * The contracting officer's answer to a priced change. A fair price is
   * the change's cost plus 15% overhead and profit; the officer accepts up
   * to 10% over that, and up to half again the days the change really takes.
   */
  judgeChangeOrder(change: ScopeChange, priceUsd: number, days: number): ChangeOrderDecision {
    const fair = change.costUsd * 1.15;
    if (priceUsd > fair * 1.1) return { accepted: false, reason: "The price is above the government's estimate for this change." };
    if (days > change.days + Math.ceil(change.days * 0.5)) return { accepted: false, reason: "The time extension is more than the change justifies." };
    return { accepted: true, reason: "Accepted as priced." };
  }

  record(resolution: Resolution): void {
    this.resolutions.push({ ...resolution });
    if (resolution.changeOrder) {
      this.changeRevenue += resolution.changeOrder.priceUsd;
      this.extendedDays += resolution.changeOrder.days;
    }
  }

  resolved(): Resolution[] {
    return this.resolutions.map((r) => ({ ...r }));
  }

  /** The job's money and time once every problem is resolved. */
  finalAccount(): JobAccount {
    const subcontractUsd = [...this.subcontracts.values()].reduce((a, q) => a + q.priceUsd, 0);
    const problemCostUsd = this.resolutions.reduce((a, r) => a + r.costUsd, 0);
    const actualDays = this.plannedDays() + this.resolutions.reduce((a, r) => a + r.days, 0);
    const contractDays = this.contractDays + this.extendedDays;
    const daysLate = Math.max(0, actualDays - contractDays);
    const liquidatedDamagesUsd = daysLate * this.ldPerDayUsd;
    const revenueUsd = this.contractPriceUsd + this.changeRevenue - liquidatedDamagesUsd;
    const costUsd = subcontractUsd + problemCostUsd;
    return {
      contractPriceUsd: this.contractPriceUsd,
      changeOrderRevenueUsd: this.changeRevenue,
      liquidatedDamagesUsd,
      revenueUsd,
      subcontractUsd,
      problemCostUsd,
      costUsd,
      profitUsd: revenueUsd - costUsd,
      plannedDays: this.plannedDays(),
      contractDays,
      actualDays,
      daysLate,
    };
  }
}

export interface JobAccount {
  contractPriceUsd: number;
  changeOrderRevenueUsd: number;
  liquidatedDamagesUsd: number;
  /** Contract price plus accepted change orders, less liquidated damages. */
  revenueUsd: number;
  subcontractUsd: number;
  problemCostUsd: number;
  costUsd: number;
  profitUsd: number;
  plannedDays: number;
  /** Contract days plus extensions granted by change orders. */
  contractDays: number;
  actualDays: number;
  daysLate: number;
}
