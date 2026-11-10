import type { ScheduledProblem } from "../sim/problems.js";
import type { SeededRng } from "../sim/rng.js";
import type { Trade } from "./market.js";
import type { JobAccount, SiteWorld } from "./site.js";

/** A bill the company owes a subcontractor or vendor. */
export interface Bill {
  billId: string;
  payee: string;
  trade: Trade | null;
  amountUsd: number;
  description: string;
}

/** A receivable problem with fixed options, raised when the government pays. */
export interface ReceivableIssue {
  id: "late-payment" | "short-payment";
  description: string;
  options: Array<{ id: string; label: string; recoversUsd: number; days: number }>;
}

export interface InvoiceResult {
  accepted: boolean;
  reason: string;
}

/** What the government paid, and when, once the invoice is accepted. */
export interface Payment {
  /** Days after the invoice was accepted. */
  paidOnDay: number;
  paidUsd: number;
  withheldUsd: number;
  daysLate: number;
}

/** Days the government has to pay a proper invoice. */
export const PAYMENT_TERMS_DAYS = 30;
/** Simple annual rate for Prompt Payment Act interest in the simulation. */
export const INTEREST_RATE = 0.05;

const round100 = (usd: number) => Math.round(usd / 100) * 100;
const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

/**
 * The simulated money side of closeout for one finished job: the bills the
 * company owes, and the government's handling of the final invoice. The
 * `late-payment` problem makes the government pay late and short.
 */
export class LedgerWorld {
  readonly account: JobAccount;
  private readonly billList: Bill[];
  private readonly paid = new Set<string>();
  private invoice: { amountUsd: number; rejections: number } | null = null;
  private readonly late: { days: number; withholdShare: number } | null;
  private readonly settled = new Map<ReceivableIssue["id"], { option: string; recoversUsd: number; days: number }>();
  private rejections = 0;

  constructor(
    readonly site: SiteWorld,
    rng: SeededRng,
    problems: readonly ScheduledProblem[],
  ) {
    this.account = site.finalAccount();
    const r = rng.fork("ledger");
    this.late = problems.some((p) => p.problem.id === "late-payment") ? { days: r.int(15, 45), withholdShare: 0.02 + r.next() * 0.03 } : null;
    const bills: Bill[] = [...site.subcontracts.values()].map((q) => ({
      billId: "",
      payee: q.subcontractor,
      trade: q.trade,
      amountUsd: q.priceUsd,
      description: `Subcontract for ${q.trade.replace(/_/g, " ")}`,
    }));
    for (const res of site.resolved()) {
      if (res.costUsd <= 0) continue;
      const sub = site.subcontracts.get(res.trade);
      const changeWork = res.choice === "change_order" || res.choice === "disputed";
      bills.push({
        billId: "",
        payee: changeWork ? (sub?.subcontractor ?? "Change work subcontractor") : `${res.problemId} vendor`,
        trade: res.trade,
        amountUsd: res.costUsd,
        description: changeWork ? `Change work for ${res.problemId} (${res.choice})` : `${res.problemId}: ${res.choice}`,
      });
    }
    this.billList = bills.map((b, i) => ({ ...b, billId: `B-${i + 1}` }));
  }

  /** What the final invoice must ask for: contract price plus change orders, less liquidated damages. */
  amountDue(): number {
    return this.account.revenueUsd;
  }

  bills(): Bill[] {
    return this.billList.map((b) => ({ ...b }));
  }

  unpaidBills(): Bill[] {
    return this.bills().filter((b) => !this.paid.has(b.billId));
  }

  /** Marks bills paid. Throws on an unknown or already paid bill, and pays none of them then. */
  pay(billIds: readonly string[]): Bill[] {
    const seen = new Set<string>();
    for (const id of billIds) {
      if (!this.billList.some((b) => b.billId === id)) throw new Error(`Unknown bill ${id}`);
      if (this.paid.has(id) || seen.has(id)) throw new Error(`${id} is already paid`);
      seen.add(id);
    }
    for (const id of billIds) this.paid.add(id);
    return this.billList.filter((b) => seen.has(b.billId)).map((b) => ({ ...b }));
  }

  /**
   * The contracting officer checks the final invoice. It must match the
   * amount due exactly; a wrong invoice is returned and the payment clock
   * restarts, so each rejection delays payment by 10 days.
   */
  submitInvoice(amountUsd: number): InvoiceResult {
    if (this.invoice) return { accepted: false, reason: "The final invoice was already accepted." };
    const due = this.amountDue();
    if (amountUsd !== due) {
      this.rejections++;
      return {
        accepted: false,
        reason: amountUsd > due
          ? "Returned: the invoice is more than the contract value after change orders and liquidated damages."
          : "Returned: the invoice is less than the amount due; the government accepts only a correct final invoice.",
      };
    }
    this.invoice = { amountUsd, rejections: this.rejections };
    return { accepted: true, reason: `Accepted. Payment is due in ${PAYMENT_TERMS_DAYS} days.` };
  }

  invoiced(): { amountUsd: number; rejections: number } | null {
    return this.invoice ? { ...this.invoice } : null;
  }

  /** The government's payment. Needs an accepted invoice. */
  payment(): Payment {
    if (!this.invoice) throw new Error("No accepted invoice");
    const delay = this.invoice.rejections * 10;
    if (!this.late) return { paidOnDay: PAYMENT_TERMS_DAYS + delay, paidUsd: this.invoice.amountUsd, withheldUsd: 0, daysLate: 0 };
    const withheld = round100(this.invoice.amountUsd * this.late.withholdShare);
    return { paidOnDay: PAYMENT_TERMS_DAYS + delay + this.late.days, paidUsd: this.invoice.amountUsd - withheld, withheldUsd: withheld, daysLate: this.late.days };
  }

  /** The receivable problems the payment raises, if any. */
  receivableIssues(): ReceivableIssue[] {
    const p = this.payment();
    if (p.daysLate === 0) return [];
    const interest = Math.round(this.invoice!.amountUsd * INTEREST_RATE * (p.daysLate / 365));
    return [
      {
        id: "late-payment",
        description: `The government paid ${p.daysLate} days late.`,
        options: [
          { id: "claim_interest", label: `Claim Prompt Payment Act interest of ${usd(interest)}`, recoversUsd: interest, days: 14 },
          { id: "waive_interest", label: "Waive the interest", recoversUsd: 0, days: 0 },
        ],
      },
      {
        id: "short-payment",
        description: `The government withheld ${usd(p.withheldUsd)} pending closeout documents (as-builts, warranties and lien releases).`,
        options: [
          { id: "submit_closeout_documents", label: `Submit the closeout documents to release the ${usd(p.withheldUsd)}`, recoversUsd: p.withheldUsd, days: 21 },
          { id: "write_off", label: `Write off the ${usd(p.withheldUsd)}`, recoversUsd: 0, days: 0 },
        ],
      },
    ];
  }

  /** Records a choice for a receivable issue. Returns an error message, or null. */
  settle(issueId: string, optionId: string): string | null {
    const issue = this.receivableIssues().find((i) => i.id === issueId);
    if (!issue) return `No open receivable issue "${issueId}"`;
    if (this.settled.has(issue.id)) return `${issue.id} is already settled`;
    const option = issue.options.find((o) => o.id === optionId);
    if (!option) return `Unknown option "${optionId}"; use ${issue.options.map((o) => o.id).join(" or ")}`;
    this.settled.set(issue.id, { option: option.id, recoversUsd: option.recoversUsd, days: option.days });
    return null;
  }

  settlements(): Array<{ issueId: ReceivableIssue["id"]; option: string; recoversUsd: number; days: number }> {
    return [...this.settled].map(([issueId, s]) => ({ issueId, ...s }));
  }

  /** The job's cash position at closeout. */
  closeoutAccount(): CloseoutAccount {
    const payment = this.invoice ? this.payment() : null;
    const settlements = this.settlements();
    const received = (payment?.paidUsd ?? 0) + settlements.reduce((a, s) => a + s.recoversUsd, 0);
    const recovered = settlements.find((s) => s.issueId === "short-payment")?.recoversUsd ?? 0;
    const interest = settlements.find((s) => s.issueId === "late-payment")?.recoversUsd ?? 0;
    const paidOut = this.billList.filter((b) => this.paid.has(b.billId)).reduce((a, b) => a + b.amountUsd, 0);
    const lastDay = (payment?.paidOnDay ?? 0) + Math.max(0, ...settlements.map((s) => s.days));
    return {
      invoicedUsd: this.invoice?.amountUsd ?? 0,
      receivedUsd: received,
      interestUsd: interest,
      writtenOffUsd: (payment?.withheldUsd ?? 0) - recovered,
      billsUsd: this.billList.reduce((a, b) => a + b.amountUsd, 0),
      paidOutUsd: paidOut,
      unpaidBills: this.billList.length - this.paid.size,
      cashProfitUsd: received - paidOut,
      daysToClose: lastDay,
    };
  }
}

export interface CloseoutAccount {
  invoicedUsd: number;
  /** Payment plus anything recovered: released withholding and interest. */
  receivedUsd: number;
  interestUsd: number;
  writtenOffUsd: number;
  billsUsd: number;
  paidOutUsd: number;
  unpaidBills: number;
  /** Cash in less cash out for the job. */
  cashProfitUsd: number;
  /** Days from the invoice to the last receipt. */
  daysToClose: number;
}
