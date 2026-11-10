import { describe, expect, it } from "vitest";
import { INTEREST_RATE, LedgerWorld, PAYMENT_TERMS_DAYS } from "../src/world/ledger.js";
import { BidWorld } from "../src/world/market.js";
import { SiteWorld } from "../src/world/site.js";
import { STUB_OPPORTUNITIES } from "../src/opportunities/stub.js";
import { PROBLEM_CATALOG } from "../src/sim/problems.js";
import { SeededRng } from "../src/sim/rng.js";

const e02 = STUB_OPPORTUNITIES.find((o) => o.noticeId === "STUB-E02")!;
const latePayment = [{ problem: PROBLEM_CATALOG.find((p) => p.id === "late-payment")!, phaseProgress: 0.5 }];

function ledger(late = false, resolve = true, seed = 1) {
  const bid = new BidWorld(e02, new SeededRng(seed));
  for (const t of bid.requiredTrades) bid.select(bid.quotesFor(t)[0]!.quoteId);
  const site = new SiteWorld(bid, 100_000, new SeededRng(seed), []);
  site.setSchedule(["painting", "flooring"]);
  if (resolve) {
    site.record({ problemId: "late-delivery", trade: "painting", choice: "expedite", costUsd: 1_500, days: 0 });
    site.record({ problemId: "weather-delay", trade: "flooring", choice: "accept_delay", costUsd: 0, days: 2 });
    site.record({ problemId: "change-order", trade: "flooring", choice: "change_order", costUsd: 4_000, days: 1, changeOrder: { priceUsd: 5_000, days: 1 } });
  }
  return new LedgerWorld(site, new SeededRng(seed), late ? latePayment : []);
}

describe("LedgerWorld", () => {
  it("bills each subcontract and each problem cost, and nothing for free choices", () => {
    const l = ledger();
    const subs = [...l.site.subcontracts.values()];
    expect(l.bills()).toEqual([
      { billId: "B-1", payee: subs[0]!.subcontractor, trade: "painting", amountUsd: subs[0]!.priceUsd, description: "Subcontract for painting" },
      { billId: "B-2", payee: subs[1]!.subcontractor, trade: "flooring", amountUsd: subs[1]!.priceUsd, description: "Subcontract for flooring" },
      { billId: "B-3", payee: "late-delivery vendor", trade: "painting", amountUsd: 1_500, description: "late-delivery: expedite" },
      { billId: "B-4", payee: subs[1]!.subcontractor, trade: "flooring", amountUsd: 4_000, description: "Change work for change-order (change_order)" },
    ]);
    expect(l.bills().reduce((a, b) => a + b.amountUsd, 0)).toBe(l.account.costUsd);
    expect(l.amountDue()).toBe(l.account.revenueUsd);
    expect(l.amountDue()).toBe(105_000 - l.account.liquidatedDamagesUsd);
  });

  it("pays bills once each, all or none", () => {
    const l = ledger();
    expect(() => l.pay(["B-1", "B-9"])).toThrow("Unknown bill B-9");
    expect(() => l.pay(["B-1", "B-1"])).toThrow("B-1 is already paid");
    expect(l.unpaidBills()).toHaveLength(4);
    expect(l.pay(["B-1", "B-3"]).map((b) => b.billId)).toEqual(["B-1", "B-3"]);
    expect(() => l.pay(["B-3"])).toThrow("B-3 is already paid");
    expect(l.unpaidBills().map((b) => b.billId)).toEqual(["B-2", "B-4"]);
  });

  it("accepts only the exact final invoice, and each returned invoice delays payment 10 days", () => {
    const l = ledger();
    expect(() => l.payment()).toThrow("No accepted invoice");
    const due = l.amountDue();
    expect(l.submitInvoice(due + 1).reason).toMatch(/more than the contract value/);
    expect(l.submitInvoice(due - 1).reason).toMatch(/less than the amount due/);
    expect(l.submitInvoice(due)).toEqual({ accepted: true, reason: `Accepted. Payment is due in ${PAYMENT_TERMS_DAYS} days.` });
    expect(l.submitInvoice(due)).toEqual({ accepted: false, reason: "The final invoice was already accepted." });
    expect(l.invoiced()).toEqual({ amountUsd: due, rejections: 2 });
    expect(l.payment()).toEqual({ paidOnDay: 50, paidUsd: due, withheldUsd: 0, daysLate: 0 });
    expect(l.receivableIssues()).toEqual([]);
  });

  it("pays late and short when the late-payment problem is drawn", () => {
    const l = ledger(true);
    l.submitInvoice(l.amountDue());
    const p = l.payment();
    expect(p.daysLate).toBeGreaterThanOrEqual(15);
    expect(p.daysLate).toBeLessThanOrEqual(45);
    expect(p.paidOnDay).toBe(PAYMENT_TERMS_DAYS + p.daysLate);
    expect(p.withheldUsd).toBeGreaterThanOrEqual(l.amountDue() * 0.02 - 100);
    expect(p.withheldUsd).toBeLessThanOrEqual(l.amountDue() * 0.05 + 100);
    expect(p.paidUsd + p.withheldUsd).toBe(l.amountDue());
    const [late, short] = l.receivableIssues();
    expect(late!.options[0]).toEqual({ id: "claim_interest", label: expect.stringContaining("Prompt Payment Act"), recoversUsd: Math.round(l.amountDue() * INTEREST_RATE * (p.daysLate / 365)), days: 14 });
    expect(short!.options.map((o) => [o.id, o.recoversUsd])).toEqual([["submit_closeout_documents", p.withheldUsd], ["write_off", 0]]);
  });

  it("settles each receivable issue once, with a known option", () => {
    const l = ledger(true);
    l.submitInvoice(l.amountDue());
    expect(l.settle("bonus", "x")).toBe('No open receivable issue "bonus"');
    expect(l.settle("late-payment", "sue")).toBe('Unknown option "sue"; use claim_interest or waive_interest');
    expect(l.settle("late-payment", "claim_interest")).toBeNull();
    expect(l.settle("late-payment", "waive_interest")).toBe("late-payment is already settled");
    expect(l.settle("short-payment", "write_off")).toBeNull();
    expect(l.settlements().map((s) => [s.issueId, s.option])).toEqual([["late-payment", "claim_interest"], ["short-payment", "write_off"]]);
  });

  it("totals the cash at closeout", () => {
    const l = ledger(true);
    expect(l.closeoutAccount()).toMatchObject({ invoicedUsd: 0, receivedUsd: 0, paidOutUsd: 0, unpaidBills: 4, daysToClose: 0 });
    l.submitInvoice(l.amountDue());
    l.pay(l.bills().map((b) => b.billId));
    l.settle("late-payment", "claim_interest");
    l.settle("short-payment", "write_off");
    const p = l.payment();
    const interest = l.receivableIssues()[0]!.options[0]!.recoversUsd;
    expect(l.closeoutAccount()).toEqual({
      invoicedUsd: l.amountDue(), receivedUsd: p.paidUsd + interest, interestUsd: interest, writtenOffUsd: p.withheldUsd,
      billsUsd: l.account.costUsd, paidOutUsd: l.account.costUsd, unpaidBills: 0,
      cashProfitUsd: p.paidUsd + interest - l.account.costUsd, daysToClose: p.paidOnDay + 14,
    });
  });

  it("is the same ledger for the same seed", () => {
    const a = ledger(true, false, 4);
    const b = ledger(true, false, 4);
    a.submitInvoice(a.amountDue());
    b.submitInvoice(b.amountDue());
    expect(a.payment()).toEqual(b.payment());
    expect(a.bills()).toHaveLength(2);
  });
});
