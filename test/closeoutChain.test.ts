import { describe, expect, it } from "vitest";
import { closeoutBrief, runCloseoutChain } from "../src/sim/closeoutChain.js";
import type { JobChainOptions } from "../src/sim/jobChain.js";
import { stubJobMove, stubJobProviders } from "../src/sim/stubJob.js";
import { STUB_BID_JOB } from "../src/sim/stubBid.js";
import { ModelRouter } from "../src/models/router.js";
import { ReactiveProvider, textResponse, toolCallsResponse } from "../src/models/stub.js";
import type { ModelRequest, ModelResponse } from "../src/models/types.js";
import type { Approver } from "../src/agents/hiringTools.js";
import { STUB_OPPORTUNITIES } from "../src/opportunities/stub.js";
import { SeededRng } from "../src/sim/rng.js";
import { BidWorld } from "../src/world/market.js";
import { SiteWorld } from "../src/world/site.js";
import { LedgerWorld } from "../src/world/ledger.js";

const yes: Approver = async () => ({ approve: true });
const opts = (seed: number, extra: Partial<JobChainOptions> = {}): JobChainOptions => ({
  runId: "close-1", seed, router: new ModelRouter(stubJobProviders()), approver: yes, runBudgetUsd: 5, noticeId: STUB_BID_JOB, forceAward: true, ...extra,
});
const has = (r: ModelRequest, tool: string) => (r.tools ?? []).some((t) => t.name === tool);
function patched(override: (r: ModelRequest) => ModelResponse | undefined) {
  const play = (model: string) => new ReactiveProvider((r) => override(r) ?? stubJobMove(r, model), model);
  return new ModelRouter({ claude: play("stub-claude"), local: play("stub-claude-worker") });
}

describe("closeoutBrief", () => {
  it("lists the invoice figures and every bill", () => {
    const e02 = STUB_OPPORTUNITIES.find((o) => o.noticeId === "STUB-E02")!;
    const bid = new BidWorld(e02, new SeededRng(1));
    for (const t of bid.requiredTrades) bid.select(bid.quotesFor(t)[0]!.quoteId);
    const site = new SiteWorld(bid, 100_000, new SeededRng(1), []);
    site.setSchedule(["painting", "flooring"]);
    const lines = closeoutBrief(new LedgerWorld(site, new SeededRng(1), [])).split("\n");
    expect(lines.slice(0, 5)).toEqual([
      "Close out the books for STUB-E02. The job is finished.",
      "Contract price: $100,000",
      "Approved change orders: $0",
      "Liquidated damages assessed: $0",
      "Bills to pay:",
    ]);
    expect(lines.filter((l) => /^- B-\d+: /.test(l))).toHaveLength(2);
  });
});

describe("runCloseoutChain (functional, scripted models)", () => {
  it("closes an on-time-paid job (seed 1)", async () => {
    const asked: string[] = [];
    const r = await runCloseoutChain(opts(1, { approver: async (q) => (asked.push(q.gate), { approve: true }) }));
    expect(r.outcome).toBe("closed");
    expect(r.agents.map((a) => a.role)).toContain("bookkeeper");
    expect(asked.slice(-3)).toEqual(["hire_agent", "release_payment", "close_project"]);
    expect(r.invoice).toEqual({ amountUsd: r.account!.revenueUsd, rejections: 0 });
    expect(r.bills.every((b) => b.paid)).toBe(true);
    expect(r.payment).toMatchObject({ daysLate: 0, withheldUsd: 0, paidOnDay: 30 });
    expect(r.settlements).toEqual([]);
    expect(r.closeout).toMatchObject({ unpaidBills: 0, cashProfitUsd: r.account!.profitUsd, daysToClose: 30 });
    expect(r.reason).toBe(`Closed: cash profit $${r.account!.profitUsd.toLocaleString("en-US")}, final receipt 30 days after the invoice.`);
    expect(r.events.map((e) => e.type)).toEqual(expect.arrayContaining(["invoice_submitted", "bills_paid", "payment_received", "project_closed"]));
  });

  it("collects interest and the withheld amount after a late, short payment (seed 3)", async () => {
    const r = await runCloseoutChain(opts(3));
    expect(r.problems).toContain("late-payment");
    expect(r.payment!.daysLate).toBeGreaterThan(0);
    expect(r.settlements.map((s) => s.option)).toEqual(["claim_interest", "submit_closeout_documents"]);
    expect(r.closeout!.writtenOffUsd).toBe(0);
    expect(r.closeout!.cashProfitUsd).toBe(r.account!.profitUsd + r.closeout!.interestUsd);
  });

  it("writes off what the Bookkeeper does not pursue", async () => {
    const router = patched((q) => (has(q, "resolve_receivable") ? textResponse("Not worth it.") : undefined));
    const r = await runCloseoutChain(opts(3, { router }));
    expect(r.outcome).toBe("closed");
    expect(r.settlements.map((s) => s.option)).toEqual(["waive_interest", "write_off"]);
    expect(r.closeout!.writtenOffUsd).toBe(r.payment!.withheldUsd);
    expect(r.events.filter((e) => e.type === "problem_unresolved" && String(e.payload.problem).includes("pay"))).toHaveLength(2);
  });

  it("stops before closeout when the job did not run", async () => {
    const r = await runCloseoutChain(opts(2, { forceAward: false }));
    expect(r).toMatchObject({ outcome: "lost", bills: [], invoice: null, payment: null, closeout: null });
  });

  it("is incomplete without a Bookkeeper or an accepted invoice", async () => {
    const noHire = patched((q) => {
      const first = q.messages[0]?.content[0];
      return has(q, "propose_hire") && first?.type === "text" && first.text.includes("Bookkeeper") ? textResponse("No.") : undefined;
    });
    expect(await runCloseoutChain(opts(1, { router: noHire }))).toMatchObject({ outcome: "incomplete", reason: "HR did not hire a Bookkeeper (task stopped: done)." });
    const badInvoice = patched((q) => (has(q, "submit_invoice") ? (q.messages.length === 1 ? toolCallsResponse([{ name: "submit_invoice", input: { amount_usd: 1 }, id: "i" }]) : textResponse("Hmm.")) : undefined));
    const r = await runCloseoutChain(opts(1, { router: badInvoice }));
    expect(r).toMatchObject({ outcome: "incomplete", reason: "The Bookkeeper did not get the final invoice accepted (task stopped: done)." });
    expect(r.invoice).toBeNull();
  });

  it("cannot close with unpaid bills, and reports an owner who will not close", async () => {
    const noPay = patched((q) => (has(q, "submit_invoice") && q.messages.length > 1 ? textResponse("Bills can wait.") : undefined));
    expect(await runCloseoutChain(opts(1, { router: noPay }))).toMatchObject({ outcome: "incomplete", reason: expect.stringMatching(/^\d+ bills were left unpaid, so the project could not close\.$/) });
    const keepOpen: Approver = async (q) => ({ approve: q.gate !== "close_project", reason: "not yet" });
    expect(await runCloseoutChain(opts(1, { approver: keepOpen }))).toMatchObject({ outcome: "owner_declined", reason: "The owner did not close the project.", closeout: null });
    const noClose = patched((q) => (has(q, "close_project") ? textResponse("Later.") : undefined));
    expect(await runCloseoutChain(opts(1, { router: noClose }))).toMatchObject({ outcome: "incomplete", reason: "The PM did not close the project (task stopped: done)." });
  });
});
