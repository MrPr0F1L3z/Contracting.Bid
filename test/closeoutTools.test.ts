import { describe, expect, it } from "vitest";
import { closeProjectTool, payablesTools, resolveReceivableTool, submitInvoiceTool } from "../src/agents/closeoutTools.js";
import type { Approver } from "../src/agents/hiringTools.js";
import type { ApprovalRequest } from "../src/approvals/approvals.js";
import { ModelRouter } from "../src/models/router.js";
import { ScriptedProvider } from "../src/models/stub.js";
import { STUB_OPPORTUNITIES } from "../src/opportunities/stub.js";
import { Company } from "../src/sim/company.js";
import { PROBLEM_CATALOG } from "../src/sim/problems.js";
import { SeededRng } from "../src/sim/rng.js";
import { LedgerWorld } from "../src/world/ledger.js";
import { BidWorld } from "../src/world/market.js";
import { SiteWorld } from "../src/world/site.js";

const e02 = STUB_OPPORTUNITIES.find((o) => o.noticeId === "STUB-E02")!;

function setup(approver: Approver = async () => ({ approve: true }), late = false) {
  const asked: ApprovalRequest[] = [];
  const c = new Company({
    runId: "r", seed: 1, router: new ModelRouter({ claude: new ScriptedProvider([]), local: new ScriptedProvider([]) }),
    approver: async (req) => (asked.push({ ...req }), approver(req)), runBudgetUsd: 5,
  });
  const agent = c.appointPresident();
  const bid = new BidWorld(e02, new SeededRng(1));
  for (const t of bid.requiredTrades) bid.select(bid.quotesFor(t)[0]!.quoteId);
  const site = new SiteWorld(bid, 100_000, new SeededRng(1), []);
  site.setSchedule(["painting", "flooring"]);
  const problems = late ? [{ problem: PROBLEM_CATALOG.find((p) => p.id === "late-payment")!, phaseProgress: 0 }] : [];
  const ledger = new LedgerWorld(site, new SeededRng(1), problems);
  return { c, agent, ledger, asked, types: () => c.log.list().map((e) => e.type) };
}
const byName = (tools: ReturnType<typeof payablesTools>) => Object.fromEntries(tools.map((t) => [t.definition.name, t]));

describe("submit_invoice", () => {
  it("validates, rounds, and reports the contracting officer's answer", async () => {
    const { c, agent, ledger, types } = setup();
    const t = submitInvoiceTool(c, agent, ledger);
    expect(await t.handle({ amount_usd: -5 })).toMatchObject({ isError: true, content: "amount_usd must be a positive number" });
    expect(await t.handle({ amount_usd: ledger.amountDue() + 500 })).toMatchObject({ isError: true, content: expect.stringContaining("Returned") });
    expect(await t.handle({ amount_usd: ledger.amountDue() + 0.4 })).toEqual({ content: "Accepted. Payment is due in 30 days." });
    expect(types().filter((x) => x === "invoice_submitted")).toHaveLength(2);
  });
});

describe("payables tools", () => {
  it("lists unpaid bills and pays a run through the owner", async () => {
    const { c, agent, ledger, asked, types } = setup();
    const t = byName(payablesTools(c, agent, ledger));
    const [b1, b2] = ledger.bills();
    expect((await t.list_bills!.handle({})).content.split("\n")[0]).toBe(`B-1: ${b1!.payee}, $${b1!.amountUsd.toLocaleString("en-US")} (Subcontract for painting)`);
    expect(await t.pay_bills!.handle({ bill_ids: [] })).toMatchObject({ isError: true, content: "bill_ids must list at least one bill" });
    expect(await t.pay_bills!.handle({ bill_ids: ["B-7"] })).toMatchObject({ isError: true, content: "B-7 is not an unpaid bill" });
    expect(await t.pay_bills!.handle({ bill_ids: ["B-1", "B-1"] })).toMatchObject({ isError: true, content: "Each bill can appear once" });
    expect(asked).toEqual([]);
    const res = await t.pay_bills!.handle({ bill_ids: ["B-1"] });
    expect(res.content).toBe(`Paid 1 bills totaling $${b1!.amountUsd.toLocaleString("en-US")}. 1 still unpaid.`);
    expect(asked[0]).toMatchObject({ gate: "release_payment", amountUsd: b1!.amountUsd });
    expect(await t.pay_bills!.handle({ bill_ids: ["B-1"] })).toMatchObject({ isError: true, content: "B-1 is not an unpaid bill" });
    await t.pay_bills!.handle({ bill_ids: ["B-2"] });
    expect((await t.list_bills!.handle({})).content).toBe("No unpaid bills.");
    expect(types()).toContain("bills_paid");
    expect(b2).toBeDefined();
  });

  it("pays nothing when the owner refuses", async () => {
    const { c, agent, ledger } = setup(async () => ({ approve: false, reason: "cash is tight" }));
    const t = byName(payablesTools(c, agent, ledger));
    expect(await t.pay_bills!.handle({ bill_ids: ["B-1"] })).toEqual({ isError: true, content: "The owner did not release the payment: cash is tight." });
    expect(ledger.unpaidBills()).toHaveLength(2);
  });
});

describe("resolve_receivable", () => {
  it("offers the open issues and records a choice", async () => {
    const { c, agent, ledger } = setup(undefined, true);
    ledger.submitInvoice(ledger.amountDue());
    const t = resolveReceivableTool(c, agent, ledger);
    expect(t.definition.inputSchema).toMatchObject({ properties: { issue_id: { enum: ["late-payment", "short-payment"] } } });
    expect(await t.handle({ issue_id: "late-payment", option_id: "x" })).toMatchObject({ isError: true });
    expect(await t.handle({ issue_id: "late-payment", option_id: "claim_interest" })).toEqual({ content: "Recorded claim_interest for late-payment." });
    expect(ledger.settlements()).toHaveLength(1);
  });
});

describe("close_project", () => {
  it("refuses until the job is invoiced, paid and settled, then asks the owner", async () => {
    const { c, agent, ledger, asked, types } = setup(undefined, true);
    const t = closeProjectTool(c, agent, ledger);
    expect(await t.handle({ summary: "" })).toMatchObject({ isError: true, content: "The final invoice has not been accepted." });
    ledger.submitInvoice(ledger.amountDue());
    expect(await t.handle({ summary: "" })).toMatchObject({ isError: true, content: "2 bills are unpaid: B-1, B-2" });
    ledger.pay(["B-1", "B-2"]);
    expect(await t.handle({ summary: "" })).toMatchObject({ isError: true, content: "Receivable issues are open: late-payment, short-payment" });
    ledger.settle("late-payment", "waive_interest");
    ledger.settle("short-payment", "submit_closeout_documents");
    expect(await t.handle({ summary: "All done." })).toEqual({ content: "The owner closed the project." });
    expect(asked[0]).toMatchObject({ gate: "close_project" });
    expect(asked[0]!.summary).toMatch(/^Close STUB-E02: received \$[\d,]+, paid out \$[\d,]+, cash profit -?\$[\d,-]+\. All done\.$/);
    expect(types()).toContain("project_closed");
  });

  it("reports the owner's refusal", async () => {
    const { c, agent, ledger } = setup(async () => ({ approve: false }));
    ledger.submitInvoice(ledger.amountDue());
    ledger.pay(["B-1", "B-2"]);
    expect(await closeProjectTool(c, agent, ledger).handle({ summary: "x" })).toEqual({ isError: true, content: "The owner did not close the project." });
  });
});
