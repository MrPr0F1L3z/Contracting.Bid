import { closeProjectTool, payablesTools, resolveReceivableTool, submitInvoiceTool } from "../agents/closeoutTools.js";
import { LedgerWorld, type Bill, type CloseoutAccount, type Payment } from "../world/ledger.js";
import { Company, HR_SYSTEM, hireRequestFromPresident, systemFor, type BaseReport } from "./company.js";
import { JOB_PM_SYSTEM, jobFields, jobStage, type JobChainOptions, type JobOutcome, type JobReport } from "./jobChain.js";
import { drawProblems } from "./problems.js";
import { SeededRng } from "./rng.js";

export const BOOKKEEPER_SYSTEM = `You are the Bookkeeper of a general contracting company run entirely by AI agents. \
You bill the government, pay subcontractors and vendors, and collect what the company is owed. Every payment \
goes to the owner for approval. Bills must be paid exactly once, and an invoice must be exactly right.`;

export type CloseoutOutcome = Exclude<JobOutcome, "completed"> | "closed";

export interface CloseoutReport extends BaseReport, Omit<JobReport, keyof BaseReport | "outcome"> {
  outcome: CloseoutOutcome;
  bills: Array<Bill & { paid: boolean }>;
  invoice: { amountUsd: number; rejections: number } | null;
  payment: Payment | null;
  settlements: ReturnType<LedgerWorld["settlements"]>;
  closeout: CloseoutAccount | null;
}

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

/** What the Bookkeeper sees: the figures that make up the invoice, and the bills. */
export function closeoutBrief(ledger: LedgerWorld): string {
  const a = ledger.account;
  return [
    `Close out the books for ${ledger.site.bid.opportunity.noticeId}. The job is finished.`,
    `Contract price: ${usd(a.contractPriceUsd)}`,
    `Approved change orders: ${usd(a.changeOrderRevenueUsd)}`,
    `Liquidated damages assessed: ${usd(a.liquidatedDamagesUsd)}`,
    "Bills to pay:",
    ...ledger.bills().map((b) => `- ${b.billId}: ${b.payee}, ${usd(b.amountUsd)} (${b.description})`),
    "",
    "Submit the final invoice for the amount due (contract price plus approved change orders, less liquidated damages), then pay the bills.",
  ].join("\n");
}

/**
 * Slice 4 of the POC: run the job (slices 1 to 3) and close it out. HR hires
 * a Bookkeeper, who invoices the government and pays every bill (each
 * payment run is an owner gate). When the government pays, the Bookkeeper
 * handles a late or short payment, and the PM asks the owner to close the job.
 */
export async function runCloseoutChain(o: JobChainOptions): Promise<CloseoutReport> {
  const c = new Company(o);
  const rng = new SeededRng(o.seed);
  const problems = drawProblems(rng);
  c.event("run_started", "owner", { seed: o.seed, slice: "closeout", problems: problems.map((p) => p.problem.id) });
  const job = await jobStage(c, o, rng, problems);
  let ledger: LedgerWorld | null = null;
  let closed = false;
  const finish = (outcome: CloseoutOutcome, reason: string): CloseoutReport => {
    c.event("run_finished", "owner", { outcome, reason, spentUsd: c.runBudget.spentUsd() });
    const unpaid = new Set(ledger?.unpaidBills().map((b) => b.billId) ?? []);
    const invoice = ledger?.invoiced() ?? null;
    return {
      ...c.baseReport(),
      ...jobFields(job, problems),
      outcome,
      reason,
      bills: (ledger?.bills() ?? []).map((b) => ({ ...b, paid: !unpaid.has(b.billId) })),
      invoice,
      payment: invoice ? ledger!.payment() : null,
      settlements: ledger?.settlements() ?? [],
      closeout: ledger && closed ? ledger.closeoutAccount() : null,
    };
  };
  if (job.outcome !== "completed") return finish(job.outcome, job.reason);
  ledger = new LedgerWorld(job.site!, rng, problems);
  const l = ledger;
  const noticeId = l.site.bid.opportunity.noticeId;

  // 1. HR hires a Bookkeeper.
  const president = c.staff("president");
  const hr = c.staff("hr");
  const hrResult = await c.runTask(
    hr,
    systemFor(HR_SYSTEM, hr),
    hireRequestFromPresident(president.id, ["a Bookkeeper"], `${noticeId} is finished and must be invoiced, its bills paid and the money collected.`, c.hiring.maxAgentBudgetUsd),
    c.hiringTools(hr),
  );
  const bookkeeper = c.registry.byRole("bookkeeper");
  if (!bookkeeper) return finish("incomplete", `HR did not hire a Bookkeeper (task stopped: ${hrResult.stop}).`);

  // 2. The Bookkeeper invoices and pays the bills.
  const billing = await c.runTask(
    bookkeeper,
    systemFor(BOOKKEEPER_SYSTEM, bookkeeper),
    closeoutBrief(l),
    [submitInvoiceTool(c, bookkeeper, l), ...payablesTools(c, bookkeeper, l)],
  );
  if (!l.invoiced()) return finish("incomplete", `The Bookkeeper did not get the final invoice accepted (task stopped: ${billing.stop}).`);

  // 3. The government pays; a late or short payment raises receivable issues.
  const payment = l.payment();
  c.event("payment_received", "contracting_officer", { ...payment });
  const issues = l.receivableIssues();
  if (issues.length > 0) {
    c.event("problem_injected", "world", { problem: "late-payment", daysLate: payment.daysLate, withheldUsd: payment.withheldUsd });
    await c.runTask(
      bookkeeper,
      systemFor(BOOKKEEPER_SYSTEM, bookkeeper),
      [`The government paid ${usd(payment.paidUsd)} of the ${usd(l.invoiced()!.amountUsd)} invoice for ${noticeId}.`,
        ...issues.flatMap((i) => [`${i.id}: ${i.description}`, ...i.options.map((o) => `- ${o.id}: ${o.label}. Takes ${o.days} days.`)]),
        "", "Resolve each issue with resolve_receivable."].join("\n"),
      [resolveReceivableTool(c, bookkeeper, l)],
    );
    for (const i of issues) {
      if (l.settlements().some((s) => s.issueId === i.id)) continue;
      // No decision: nothing is pursued, so the money is not recovered.
      const none = i.options.find((o) => o.recoversUsd === 0)!;
      l.settle(i.id, none.id);
      c.event("problem_unresolved", "world", { problem: i.id, option: none.id });
    }
  }

  // 4. The PM asks the owner to close the job.
  const pm = c.staff("project_manager");
  const closing = await c.runTask(
    pm,
    systemFor(JOB_PM_SYSTEM, pm),
    `${noticeId} is billed and the government has paid. Close the project with close_project once nothing is outstanding; if something is, say what.`,
    [closeProjectTool(c, pm, l)],
  );
  closed = c.log.list({ runId: o.runId, type: "project_closed" }).length > 0;
  if (!closed) {
    const unpaid = l.unpaidBills().length;
    const declined = c.approvals.all().some((a) => a.gate === "close_project" && a.status === "rejected");
    if (declined) return finish("owner_declined", "The owner did not close the project.");
    return finish("incomplete", unpaid > 0 ? `${unpaid} bills were left unpaid, so the project could not close.` : `The PM did not close the project (task stopped: ${closing.stop}).`);
  }
  const account = l.closeoutAccount();
  return finish("closed", `Closed: cash profit ${account.cashProfitUsd < 0 ? "-" : ""}${usd(Math.abs(account.cashProfitUsd))}, final receipt ${account.daysToClose} days after the invoice.`);
}
