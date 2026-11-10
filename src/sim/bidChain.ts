import { decideOpportunityTool, procurementTools, submitBidTool, submitEstimateTool, type BidState, type EstimateLine } from "../agents/bidTools.js";
import { pickOpportunity } from "../opportunities/pick.js";
import { STUB_OPPORTUNITIES } from "../opportunities/stub.js";
import type { Complexity, Opportunity } from "../opportunities/types.js";
import { TRADES, BidWorld, type Award, type Quote, type Trade } from "../world/market.js";
import { Company, HR_SYSTEM, PRESIDENT_SYSTEM, hireInitialStaff, hireRequestFromPresident, systemFor, type BaseReport, type CompanyOptions } from "./company.js";
import { drawProblems } from "./problems.js";
import { SeededRng } from "./rng.js";

export const ESTIMATOR_SYSTEM = `You are the Estimator of a general contracting company run entirely by AI agents. \
The company subcontracts all field work. From a solicitation's scope you work out every trade the job needs and \
estimate each trade's subcontract cost. Missing a trade makes the bid non-responsive; padding wastes the bid. \
Record the estimate with submit_estimate, using only these trade names: ${TRADES.join(", ")}.`;

export const PROCUREMENT_SYSTEM = `You are the Procurement agent of a general contracting company run entirely by AI agents. \
You get subcontractor quotes for every trade in the estimate and select the best value for each, one quote per trade. \
Quotes can expire or change; check the result of each selection and use procurement_status before you finish.`;

export const PM_SYSTEM = `You are the Project Manager of a general contracting company run entirely by AI agents. \
You turn the estimate and the selected subcontractor quotes into a bid price that covers subcontract cost, \
overhead and profit, and is low enough to win a lowest-price-technically-acceptable award. \
The owner approves every bid before it goes to the contracting officer.`;

export interface BidChainOptions extends CompanyOptions {
  /** Where jobs come from. Defaults to the stub solicitations. */
  opportunities?: readonly Opportunity[];
  /** Bid this job instead of picking one by seed. */
  noticeId?: string;
  /** Pick only among jobs at this complexity. */
  complexity?: Complexity;
}

export type BidOutcome = "awarded" | "lost" | "no_bid" | "owner_declined" | "incomplete";

export interface BidReport extends BaseReport {
  outcome: BidOutcome;
  reason: string;
  opportunity: { noticeId: string; title: string; complexity: Complexity | null } | null;
  /** The problems drawn for this run, by id. Only the bidding ones act in this slice. */
  problems: string[];
  injected: { id: string; trade: Trade } | null;
  estimate: BidState["estimate"] | null;
  selected: Array<Quote & { repricedFromUsd?: number }>;
  bid: BidState["bid"] | null;
  /** Sum of the selected quotes: what the company would pay its subs. */
  quotedCostUsd: number;
  /** Bid price less the selected quotes; negative means the bid is below cost. Null with no bid. */
  marginUsd: number | null;
  award: Award | null;
}

/** The solicitation as the agents see it. Never shows the world's hidden costs. */
export function opportunityBrief(o: Opportunity): string {
  const value = o.estimatedValueUsd
    ? `$${o.estimatedValueUsd.min.toLocaleString("en-US")} to $${o.estimatedValueUsd.max.toLocaleString("en-US")}`
    : "not stated";
  return [
    `Solicitation ${o.noticeId}: ${o.title}`,
    `Agency: ${o.agency}`,
    `Place of performance: ${o.placeOfPerformance.city}, ${o.placeOfPerformance.state}`,
    `NAICS: ${o.naicsCode}. Set-aside: ${o.setAside ?? "none"}. Responses due ${o.responseDeadline}.`,
    `Government estimate: ${value}`,
    `Scope: ${o.scopeSummary}`,
  ].join("\n");
}

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

/** What the PM sees: the estimate next to the selected quotes, trade by trade. */
export function bidPackage(o: Opportunity, lines: readonly EstimateLine[], notes: string, world: BidWorld): string {
  const selected = world.selected();
  const rows = lines.map((l) => {
    const s = selected.get(l.trade);
    return `- ${l.trade}: estimate ${usd(l.costUsd)}; ${s ? `quote ${s.quote.quoteId} from ${s.quote.subcontractor} at ${usd(s.quote.priceUsd)}` : "NO QUOTE SELECTED"}`;
  });
  const extra = [...selected.values()].filter((s) => !lines.some((l) => l.trade === s.quote.trade));
  const quoted = [...selected.values()].reduce((a, s) => a + s.quote.priceUsd, 0);
  return [
    opportunityBrief(o),
    "",
    "Bid package:",
    ...rows,
    ...extra.map((s) => `- ${s.quote.trade}: not in the estimate; quote ${s.quote.quoteId} at ${usd(s.quote.priceUsd)}`),
    `Total of selected quotes: ${usd(quoted)}`,
    `Estimator's notes: ${notes || "none"}`,
    "",
    "Set the bid price with submit_bid.",
  ].join("\n");
}

/**
 * Slice 2 of the POC: from a staffed company to an award decision.
 * The President decides whether to pursue a job, HR hires an Estimator and a
 * Procurement agent, the Estimator prices the trades, Procurement selects
 * subcontractor quotes, the PM sets the bid price, and the simulated
 * contracting officer awards on lowest price technically acceptable.
 * Pursuing, each later hire and the bid all go to the owner.
 */
export async function runBidChain(o: BidChainOptions): Promise<BidReport> {
  const c = new Company(o);
  const rng = new SeededRng(o.seed);
  const problems = drawProblems(rng);
  c.event("run_started", "owner", { seed: o.seed, slice: "bidding", problems: problems.map((p) => p.problem.id) });

  let world: BidWorld | null = null;
  const state: BidState = {};
  const finish = (outcome: BidOutcome, reason: string, award: Award | null = null): BidReport => {
    c.event("run_finished", "owner", { outcome, reason, spentUsd: c.runBudget.spentUsd() });
    const opp = world?.opportunity;
    const selected = world ? [...world.selected().values()] : [];
    const quotedCostUsd = selected.reduce((a, s) => a + s.quote.priceUsd, 0);
    return {
      ...c.baseReport(),
      outcome,
      reason,
      opportunity: opp ? { noticeId: opp.noticeId, title: opp.title, complexity: opp.complexity } : null,
      problems: problems.map((p) => p.problem.id),
      injected: world?.injectedProblem() ?? null,
      estimate: state.estimate ?? null,
      selected: selected.map((s) => ({ ...s.quote, ...(s.repricedFromUsd !== undefined ? { repricedFromUsd: s.repricedFromUsd } : {}) })),
      bid: state.bid ?? null,
      quotedCostUsd,
      marginUsd: state.bid ? state.bid.priceUsd - quotedCostUsd : null,
      award,
    };
  };

  const president = c.appointPresident();
  const staffed = await hireInitialStaff(c, president);
  if (!staffed.ok) return finish("incomplete", staffed.reason);

  const all = o.opportunities ?? STUB_OPPORTUNITIES;
  let opportunity: Opportunity;
  if (o.noticeId !== undefined) {
    const found = all.find((x) => x.noticeId === o.noticeId);
    if (!found) throw new Error(`No solicitation ${o.noticeId}`);
    opportunity = found;
  } else {
    opportunity = pickOpportunity([...all], rng, o.complexity ? { complexity: o.complexity } : {});
  }
  world = new BidWorld(opportunity, rng, problems);
  c.event("opportunity_found", "world", { noticeId: opportunity.noticeId, title: opportunity.title, complexity: opportunity.complexity });

  // 1. The President decides whether to pursue.
  const decideResult = await c.runTask(
    president,
    `${PRESIDENT_SYSTEM}\n\nA new solicitation has come in. Decide whether the company should pursue it, weighing fit, risk, \
capacity and value, and record the decision with decide_opportunity. Pursuing goes to the owner for approval.`,
    opportunityBrief(opportunity),
    [decideOpportunityTool(c, president, world, state)],
  );
  if (!state.decision) return finish("incomplete", `The President made no decision (task stopped: ${decideResult.stop}).`);
  if (!state.decision.pursue) return finish("no_bid", `The President chose not to bid: ${state.decision.rationale}`);
  if (!state.decision.ownerApproved) return finish("owner_declined", `The owner declined to pursue${state.decision.ownerReason ? `: ${state.decision.ownerReason}` : "."}`);

  // 2. HR hires the bid team. These hires go to the owner.
  const hr = c.staff("hr");
  const request = hireRequestFromPresident(
    president.id,
    ["an Estimator", "a Procurement agent"],
    `we are bidding ${opportunity.noticeId} and need the trades estimated and subcontractor quotes selected.`,
    c.hiring.maxAgentBudgetUsd,
  );
  const hrResult = await c.runTask(hr, systemFor(HR_SYSTEM, hr), request, c.hiringTools(hr));
  const estimator = c.registry.byRole("estimator");
  const procurement = c.registry.byRole("procurement");
  if (!estimator || !procurement) {
    const missing = [!estimator && "an Estimator", !procurement && "a Procurement agent"].filter(Boolean).join(" or ");
    return finish("incomplete", `HR did not hire ${missing} (task stopped: ${hrResult.stop}).`);
  }

  // 3. The Estimator prices the trades.
  const estResult = await c.runTask(
    estimator,
    systemFor(ESTIMATOR_SYSTEM, estimator),
    `${opportunityBrief(opportunity)}\n\nEstimate this job.`,
    [submitEstimateTool(c, estimator, state)],
  );
  const estimate = state.estimate;
  if (!estimate) return finish("incomplete", `The Estimator submitted no estimate (task stopped: ${estResult.stop}).`);

  // 4. Procurement selects a quote per trade: about three tool calls per trade.
  const trades = estimate.lines.map((l) => l.trade);
  await c.runTask(
    procurement,
    systemFor(PROCUREMENT_SYSTEM, procurement),
    `Get quotes and select one subcontractor for each trade in the estimate for ${opportunity.noticeId}: ${trades.join(", ")}.`,
    procurementTools(c, procurement, world, state),
    3 * trades.length + 4,
  );

  // 5. The PM sets the price; the owner approves it before submission.
  const pm = c.staff("project_manager");
  const bidResult = await c.runTask(pm, systemFor(PM_SYSTEM, pm), bidPackage(opportunity, estimate.lines, estimate.notes, world), [
    submitBidTool(c, pm, world, state),
  ]);
  if (!state.bid) return finish("incomplete", `The PM proposed no bid (task stopped: ${bidResult.stop}).`);
  if (!state.bid.ownerApproved) return finish("owner_declined", `The owner rejected the bid${state.bid.ownerReason ? `: ${state.bid.ownerReason}` : "."}`);

  // 6. The contracting officer awards.
  c.event("bid_submitted", `project_manager#${pm.id}`, { noticeId: opportunity.noticeId, priceUsd: state.bid.priceUsd });
  const award = world.evaluate(state.bid.priceUsd);
  c.event("award_decided", "contracting_officer", { ...award });
  return finish(award.awarded ? "awarded" : "lost", award.reason, award);
}
