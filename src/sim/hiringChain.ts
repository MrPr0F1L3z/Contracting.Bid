import { Company, hireInitialStaff, type BaseReport, type CompanyOptions } from "./company.js";

export { HR_SYSTEM, PRESIDENT_SYSTEM, pmRequestFromPresident, systemFor } from "./company.js";

export type HiringChainOptions = CompanyOptions;

export interface HiringReport extends BaseReport {
  outcome: "complete" | "incomplete";
  reason: string;
}

/**
 * Slice 1 of the POC: the owner appoints the President, the President hires
 * HR, and HR hires the Project Manager. Both hires are automatic by the
 * owner's rule; any other hire an agent proposes goes to `approver`.
 */
export async function runHiringChain(o: HiringChainOptions): Promise<HiringReport> {
  const c = new Company(o);
  c.event("run_started", "owner", { seed: o.seed, slice: "hiring" });
  const president = c.appointPresident();
  const staffed = await hireInitialStaff(c, president);
  const [outcome, reason] = staffed.ok
    ? (["complete", "The President hired HR and HR hired the Project Manager."] as const)
    : (["incomplete", staffed.reason] as const);
  c.event("run_finished", "owner", { outcome, reason, spentUsd: c.runBudget.spentUsd() });
  return { ...c.baseReport(), outcome, reason };
}
