import { kickoffTools, priceChangeOrderTool, problemBrief, resolveProblemTool, setScheduleTool, type JobState } from "../agents/jobTools.js";
import { SiteWorld, type JobAccount, type Resolution, type ScheduleLine, type SiteProblem } from "../world/site.js";
import { bidFields, bidStage, type BidChainOptions, type BidOutcome, type BidReport, type BidStage } from "./bidChain.js";
import { Company, HR_SYSTEM, hireRequestFromPresident, systemFor, type BaseReport } from "./company.js";
import { drawProblems, type ScheduledProblem } from "./problems.js";
import { SeededRng } from "./rng.js";

export const JOB_PM_SYSTEM = `You are the Project Manager of a general contracting company run entirely by AI agents. \
You run each awarded job from kickoff to closeout. The company subcontracts all field work. You protect the \
company's profit and the contract schedule: every working day past the contract time costs liquidated damages. \
The owner signs contracts and subcontracts and approves change orders; you prepare them.`;

export const SCHEDULER_SYSTEM = `You are the Scheduler of a general contracting company run entirely by AI agents. \
You sequence each job's subcontracted trades in construction order, so each trade starts only when the work it \
depends on is done. Record the sequence with set_schedule.`;

export interface JobChainOptions extends BidChainOptions {
  /**
   * Simulation only: when the bid is responsive but loses on price, award it
   * anyway so execution can be exercised. Recorded in the report.
   */
  forceAward?: boolean;
}

export type JobOutcome = Exclude<BidOutcome, "awarded"> | "completed";

export interface JobReport extends BaseReport, Omit<BidReport, keyof BaseReport | "outcome"> {
  outcome: JobOutcome;
  awardForced: boolean;
  schedule: ScheduleLine[] | null;
  siteProblems: Array<Pick<SiteProblem, "id" | "trade" | "day" | "description">>;
  resolutions: Resolution[];
  account: JobAccount | null;
}

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

/**
 * Slice 3 of the POC: bid a job (slices 1 and 2) and, if it is awarded, run
 * it. The PM gets the prime contract and subcontracts signed, HR hires a
 * Scheduler who sequences the trades, and the PM resolves each site problem
 * the seed brings. The run ends with the job's final account.
 */
export async function runJobChain(o: JobChainOptions): Promise<JobReport> {
  const c = new Company(o);
  const rng = new SeededRng(o.seed);
  const problems = drawProblems(rng);
  c.event("run_started", "owner", { seed: o.seed, slice: "execution", problems: problems.map((p) => p.problem.id) });
  const stage = await jobStage(c, o, rng, problems);
  c.event("run_finished", "owner", { outcome: stage.outcome, reason: stage.reason, spentUsd: c.runBudget.spentUsd() });
  return { ...c.baseReport(), ...jobFields(stage, problems) };
}

/** Where the job stage ended, with the bid stage before it and the site, if the job started. */
export interface JobStage {
  outcome: JobOutcome;
  reason: string;
  bid: BidStage;
  awardForced: boolean;
  site: SiteWorld | null;
  siteProblems: SiteProblem[];
  state: JobState;
}

/** The bid and job fields of a report, from a finished job stage. */
export function jobFields(j: JobStage, problems: readonly ScheduledProblem[]): Omit<JobReport, keyof BaseReport> {
  return {
    ...bidFields(j.bid, problems),
    outcome: j.outcome,
    reason: j.reason,
    awardForced: j.awardForced,
    schedule: j.site?.scheduled() ?? null,
    siteProblems: j.siteProblems.map(({ id, trade, day, description }) => ({ id, trade, day, description })),
    resolutions: j.site?.resolved() ?? [],
    account: j.site && j.site.scheduled() && j.state.subcontractsIssued ? j.site.finalAccount() : null,
  };
}

/** Runs slices 1 to 3 on a company: hires, bid, and the awarded job through its final account. */
export async function jobStage(c: Company, o: JobChainOptions, rng: SeededRng, problems: readonly ScheduledProblem[]): Promise<JobStage> {
  const stage = await bidStage(c, o, rng, problems);
  const state: JobState = { changeOrderTries: {} };
  let site: SiteWorld | null = null;
  let siteProblems: SiteProblem[] = [];
  let awardForced = false;
  const finish = (outcome: JobOutcome, reason: string): JobStage => ({ outcome, reason, bid: stage, awardForced, site, siteProblems, state });

  if (stage.outcome !== "awarded") {
    const responsive = stage.outcome === "lost" && stage.award?.rank !== null;
    if (!(o.forceAward && responsive)) return finish(stage.outcome, stage.reason);
    awardForced = true;
    c.event("award_forced", "owner", { reason: stage.reason });
  }
  const world = stage.world!;
  const price = stage.state.bid!.priceUsd;
  site = new SiteWorld(world, price, rng, problems);
  const s = site;
  const job = world.opportunity.noticeId;

  // 1. Kickoff: the owner signs the prime contract and the subcontracts.
  const pm = c.staff("project_manager");
  const subs = [...s.subcontracts.values()].map((q) => `- ${q.trade}: ${q.subcontractor}, ${usd(q.priceUsd)}`);
  const kickoff = await c.runTask(
    pm,
    systemFor(JOB_PM_SYSTEM, pm),
    [`We won ${job} at ${usd(price)}. Contract time: ${s.contractDays} working days; liquidated damages ${usd(s.ldPerDayUsd)} per day late.`,
      "Selected subcontractors:", ...subs, "", "Get the prime contract signed, then issue the subcontracts."].join("\n"),
    kickoffTools(c, pm, s, state),
  );
  const rejected = (gate: string) => c.approvals.all().some((a) => a.gate === gate && a.status === "rejected");
  if (!state.contractSigned) {
    return rejected("sign_contract")
      ? finish("owner_declined", "The owner did not sign the prime contract.")
      : finish("incomplete", `The PM did not get the prime contract signed (task stopped: ${kickoff.stop}).`);
  }
  if (!state.subcontractsIssued) {
    return rejected("sign_commitment")
      ? finish("owner_declined", "The owner did not sign the subcontracts.")
      : finish("incomplete", `The PM did not issue the subcontracts (task stopped: ${kickoff.stop}).`);
  }

  // 2. HR hires a Scheduler, who sequences the trades.
  const president = c.staff("president");
  const hr = c.staff("hr");
  const hrResult = await c.runTask(
    hr,
    systemFor(HR_SYSTEM, hr),
    hireRequestFromPresident(president.id, ["a Scheduler"], `we won ${job} and need its trades sequenced inside the contract time.`, c.hiring.maxAgentBudgetUsd),
    c.hiringTools(hr),
  );
  const scheduler = c.registry.byRole("scheduler");
  if (!scheduler) return finish("incomplete", `HR did not hire a Scheduler (task stopped: ${hrResult.stop}).`);
  const durations = [...s.subcontracts.keys()].map((t) => `- ${t}: ${s.durationOf(t)} working days`);
  const schedResult = await c.runTask(
    scheduler,
    systemFor(SCHEDULER_SYSTEM, scheduler),
    [`Sequence the trades for ${job}: ${world.opportunity.title}. Contract time: ${s.contractDays} working days.`, ...durations].join("\n"),
    [setScheduleTool(c, scheduler, s)],
  );
  if (!s.scheduled()) return finish("incomplete", `The Scheduler set no schedule (task stopped: ${schedResult.stop}).`);

  // 3. The job runs; the PM resolves each problem as it comes up.
  siteProblems = s.siteProblems();
  for (const p of siteProblems) {
    c.event("problem_injected", "world", { problem: p.id, trade: p.trade, day: p.day });
    const tools = p.change ? [priceChangeOrderTool(c, pm, s, p, state)] : [resolveProblemTool(c, pm, s, p)];
    await c.runTask(pm, systemFor(JOB_PM_SYSTEM, pm), problemBrief(s, p), tools);
    if (!s.resolved().some((r) => r.problemId === p.id)) {
      // No decision: the site waits (the slowest option), or a change goes ahead unpaid.
      const fallback = p.change
        ? { choice: "disputed", costUsd: p.change.costUsd, days: p.change.days, changeOrder: null }
        : (() => {
            const slow = [...p.options].sort((a, b) => b.days - a.days)[0]!;
            return { choice: `none (${slow.id})`, costUsd: slow.costUsd, days: slow.days };
          })();
      s.record({ problemId: p.id, trade: p.trade, ...fallback });
      c.event("problem_unresolved", "world", { problem: p.id, ...fallback });
    }
  }

  // 4. Final account.
  const account = s.finalAccount();
  c.event("job_completed", "world", { ...account });
  const late = account.daysLate > 0 ? `${account.daysLate} day${account.daysLate === 1 ? "" : "s"} late` : "on time";
  return finish("completed", `Finished in ${account.actualDays} of ${account.contractDays} working days (${late}); profit ${account.profitUsd < 0 ? "-" : ""}${usd(Math.abs(account.profitUsd))}.`);
}
