import { describe, expect, it } from "vitest";
import { ApprovalQueue, type ApprovalRequest } from "../src/approvals/approvals.js";
import { terminalApprover } from "../src/cli/sim.js";
import { payablesTools, submitInvoiceTool } from "../src/agents/closeoutTools.js";
import { ModelRouter } from "../src/models/router.js";
import { ScriptedProvider } from "../src/models/stub.js";
import { STUB_OPPORTUNITIES } from "../src/opportunities/stub.js";
import { Company } from "../src/sim/company.js";
import { SeededRng } from "../src/sim/rng.js";
import { LedgerWorld } from "../src/world/ledger.js";
import { BidWorld } from "../src/world/market.js";
import { SiteWorld } from "../src/world/site.js";
import type { Approver } from "../src/agents/hiringTools.js";

const items = [{ id: "a", label: "Sub A", amountUsd: 10 }, { id: "b", label: "Sub B", amountUsd: 20 }];

describe("ApprovalQueue batches", () => {
  it("approves every item by default, or only the chosen ones, in item order", () => {
    const q = new ApprovalQueue();
    const all = q.request({ gate: "sign_commitment", requestedBy: "pm", summary: "s", items });
    expect(q.decide(all.id, true, "owner").approvedItems).toEqual(["a", "b"]);
    const some = q.request({ gate: "sign_commitment", requestedBy: "pm", summary: "s", items });
    expect(q.decide(some.id, true, "owner", "b only", ["b"])).toMatchObject({ status: "approved", approvedItems: ["b"], reason: "b only" });
    const none = q.request({ gate: "release_payment", requestedBy: "bk", summary: "s", items });
    expect(q.decide(none.id, true, "owner", undefined, [])).toMatchObject({ status: "rejected" });
    expect(q.get(none.id)?.approvedItems).toBeUndefined();
  });
  it("rejects item choices that do not fit the request", () => {
    const q = new ApprovalQueue();
    const plain = q.request({ gate: "submit_bid", requestedBy: "pm", summary: "s" });
    expect(() => q.decide(plain.id, true, "owner", undefined, ["a"])).toThrow(`Approval ${plain.id} has no items`);
    const batch = q.request({ gate: "release_payment", requestedBy: "bk", summary: "s", items });
    expect(() => q.decide(batch.id, true, "owner", undefined, ["z"])).toThrow(`Approval ${batch.id} has no item z`);
    expect(q.get(batch.id)?.status).toBe("pending");
  });
  it("an auto-approved batch covers every item", () => {
    const q = new ApprovalQueue(new Set(["release_payment"]));
    expect(q.request({ gate: "release_payment", requestedBy: "bk", summary: "s", items }).approvedItems).toEqual(["a", "b"]);
  });
});

describe("terminalApprover with items", () => {
  const req = { id: 7, gate: "release_payment", requestedBy: "bookkeeper#6", amountUsd: 30, summary: "Pay 2 bills.", items } as ApprovalRequest;
  const answers = (...a: string[]) => {
    const asked: string[] = [];
    return { asked, ask: async (q: string) => (asked.push(q), a.shift() ?? "") };
  };
  it("lists the items and approves all on y", async () => {
    const t = answers("y");
    expect(await terminalApprover(t.ask)(req)).toEqual({ approve: true });
    expect(t.asked[0]).toContain("Pay 2 bills.\n  a: Sub A, $10\n  b: Sub B, $20\n[y = approve all, i = choose items, N or a reason to reject] ");
  });
  it("asks item by item on i", async () => {
    const t = answers("i", "n", "y");
    expect(await terminalApprover(t.ask)(req)).toEqual({ approve: true, items: ["b"] });
    expect(t.asked.slice(1)).toEqual(["  Approve a (Sub A)? [y/N] ", "  Approve b (Sub B)? [y/N] "]);
    expect(await terminalApprover(answers("i", "n", "").ask)(req)).toEqual({ approve: false, reason: "No items approved" });
  });
  it("rejects with a reason, and treats i as a reason when there are no items", async () => {
    expect(await terminalApprover(answers("not this week").ask)(req)).toEqual({ approve: false, reason: "not this week" });
    expect(await terminalApprover(answers("i").ask)({ ...req, items: undefined })).toEqual({ approve: false, reason: "i" });
  });
});

describe("closeout under the owner rules", () => {
  function setup(approver: Approver) {
    const asked: ApprovalRequest[] = [];
    const c = new Company({
      runId: "r", seed: 1, router: new ModelRouter({ claude: new ScriptedProvider([]), local: new ScriptedProvider([]) }),
      approver: async (r) => (asked.push({ ...r }), approver(r)), runBudgetUsd: 5,
    });
    const agent = c.appointPresident();
    const bid = new BidWorld(STUB_OPPORTUNITIES.find((o) => o.noticeId === "STUB-E02")!, new SeededRng(1));
    for (const t of bid.requiredTrades) bid.select(bid.quotesFor(t)[0]!.quoteId);
    const site = new SiteWorld(bid, 100_000, new SeededRng(1), []);
    site.setSchedule(["painting", "flooring"]);
    return { c, agent, ledger: new LedgerWorld(site, new SeededRng(1), []), asked };
  }

  it("sends no final invoice without the owner's approval", async () => {
    const { c, agent, ledger, asked } = setup(async () => ({ approve: false, reason: "check the LDs" }));
    const t = submitInvoiceTool(c, agent, ledger);
    expect(await t.handle({ amount_usd: ledger.amountDue() })).toEqual({ isError: true, content: "The owner did not approve the invoice: check the LDs." });
    expect(asked[0]).toMatchObject({ gate: "submit_invoice", amountUsd: ledger.amountDue(), summary: `Send the final invoice for STUB-E02: $${ledger.amountDue().toLocaleString("en-US")}.` });
    expect(ledger.invoiced()).toBeNull();
  });

  it("refuses a second invoice without asking again", async () => {
    const { c, agent, ledger, asked } = setup(async () => ({ approve: true }));
    const t = submitInvoiceTool(c, agent, ledger);
    await t.handle({ amount_usd: ledger.amountDue() });
    expect(await t.handle({ amount_usd: ledger.amountDue() })).toMatchObject({ isError: true, content: "The final invoice was already accepted." });
    expect(asked).toHaveLength(1);
  });

  it("pays only the bills the owner picks from a payment run", async () => {
    const { c, agent, ledger, asked } = setup(async () => ({ approve: true, items: ["B-2"], reason: "dispute on B-1" }));
    const pay = payablesTools(c, agent, ledger).find((t) => t.definition.name === "pay_bills")!;
    const [b1, b2] = ledger.bills();
    const res = await pay.handle({ bill_ids: ["B-1", "B-2"] });
    expect(res.content).toBe(`Paid 1 bills totaling $${b2!.amountUsd.toLocaleString("en-US")}. The owner held back B-1 (dispute on B-1). 1 still unpaid.`);
    expect(asked[0]!.items).toEqual([
      { id: "B-1", label: `${b1!.payee} (Subcontract for painting)`, amountUsd: b1!.amountUsd },
      { id: "B-2", label: `${b2!.payee} (Subcontract for flooring)`, amountUsd: b2!.amountUsd },
    ]);
    expect(ledger.unpaidBills().map((b) => b.billId)).toEqual(["B-1"]);
  });
});
