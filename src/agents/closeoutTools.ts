import type { AgentRecord } from "./registry.js";
import type { ToolHandler } from "./loop.js";
import type { Company } from "../sim/company.js";
import type { LedgerWorld } from "../world/ledger.js";

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;
const actorOf = (a: AgentRecord) => `${a.role}#${a.id}`;
const err = (content: string) => ({ content, isError: true });

/** submit_invoice (Bookkeeper): the final invoice to the government. */
export function submitInvoiceTool(c: Company, agent: AgentRecord, ledger: LedgerWorld): ToolHandler {
  return {
    definition: {
      name: "submit_invoice",
      description: "Submit the final invoice to the contracting officer. A wrong amount is returned and delays payment.",
      inputSchema: { properties: { amount_usd: { type: "number" } }, required: ["amount_usd"], additionalProperties: false },
    },
    async handle(input) {
      const amount = input.amount_usd;
      if (typeof amount !== "number" || !(amount > 0)) return err("amount_usd must be a positive number");
      const result = ledger.submitInvoice(Math.round(amount));
      c.event("invoice_submitted", actorOf(agent), { amountUsd: Math.round(amount), accepted: result.accepted, reason: result.reason });
      return result.accepted ? { content: result.reason } : err(result.reason);
    },
  };
}

/** list_bills and pay_bills (Bookkeeper). Paying is an owner gate. */
export function payablesTools(c: Company, agent: AgentRecord, ledger: LedgerWorld): ToolHandler[] {
  return [
    {
      definition: { name: "list_bills", description: "List the bills still unpaid.", inputSchema: { properties: {}, additionalProperties: false } },
      async handle() {
        const open = ledger.unpaidBills();
        return { content: open.length === 0 ? "No unpaid bills." : open.map((b) => `${b.billId}: ${b.payee}, ${usd(b.amountUsd)} (${b.description})`).join("\n") };
      },
    },
    {
      definition: {
        name: "pay_bills",
        description: "Propose a payment run for these bills. The owner approves it before any money moves.",
        inputSchema: {
          properties: { bill_ids: { type: "array", items: { type: "string" } } },
          required: ["bill_ids"],
          additionalProperties: false,
        },
      },
      async handle(input) {
        const ids = input.bill_ids;
        if (!Array.isArray(ids) || ids.length === 0 || !ids.every((i) => typeof i === "string")) return err("bill_ids must list at least one bill");
        const open = new Map(ledger.unpaidBills().map((b) => [b.billId, b]));
        const bad = (ids as string[]).find((i) => !open.has(i));
        if (bad !== undefined) return err(`${bad} is not an unpaid bill`);
        if (new Set(ids).size !== ids.length) return err("Each bill can appear once");
        const bills = (ids as string[]).map((i) => open.get(i)!);
        const total = bills.reduce((a, b) => a + b.amountUsd, 0);
        const req = await c.askOwner({
          gate: "release_payment",
          requestedBy: actorOf(agent),
          summary: `Pay ${bills.length} bills totaling ${usd(total)}: ${bills.map((b) => `${b.payee} ${usd(b.amountUsd)}`).join("; ")}.`,
          amountUsd: total,
        });
        if (req.status !== "approved") return err(`The owner did not release the payment${req.reason ? `: ${req.reason}` : ""}.`);
        ledger.pay(ids as string[]);
        c.event("bills_paid", "owner", { billIds: ids, totalUsd: total });
        return { content: `Paid ${bills.length} bills totaling ${usd(total)}. ${ledger.unpaidBills().length} still unpaid.` };
      },
    },
  ];
}

/** resolve_receivable (Bookkeeper): answers a late or short payment. */
export function resolveReceivableTool(c: Company, agent: AgentRecord, ledger: LedgerWorld): ToolHandler {
  const issues = ledger.receivableIssues();
  return {
    definition: {
      name: "resolve_receivable",
      description: "Choose how to handle a late or short payment from the government.",
      inputSchema: {
        properties: {
          issue_id: { type: "string", enum: issues.map((i) => i.id) },
          option_id: { type: "string", enum: issues.flatMap((i) => i.options.map((o) => o.id)) },
        },
        required: ["issue_id", "option_id"],
        additionalProperties: false,
      },
    },
    async handle(input) {
      const problem = ledger.settle(String(input.issue_id), String(input.option_id));
      if (problem) return err(problem);
      c.event("receivable_resolved", actorOf(agent), { issue: input.issue_id, option: input.option_id });
      return { content: `Recorded ${String(input.option_id)} for ${String(input.issue_id)}.` };
    },
  };
}

/** close_project (PM): closes the job once it is billed, paid and settled. An owner gate. */
export function closeProjectTool(c: Company, agent: AgentRecord, ledger: LedgerWorld): ToolHandler {
  return {
    definition: {
      name: "close_project",
      description: "Ask the owner to close the project. Needs the final invoice accepted, every bill paid and every receivable issue settled.",
      inputSchema: { properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false },
    },
    async handle(input) {
      if (!ledger.invoiced()) return err("The final invoice has not been accepted.");
      const unpaid = ledger.unpaidBills();
      if (unpaid.length > 0) return err(`${unpaid.length} bills are unpaid: ${unpaid.map((b) => b.billId).join(", ")}`);
      const settled = new Set(ledger.settlements().map((s) => s.issueId));
      const open = ledger.receivableIssues().filter((i) => !settled.has(i.id));
      if (open.length > 0) return err(`Receivable issues are open: ${open.map((i) => i.id).join(", ")}`);
      const account = ledger.closeoutAccount();
      const req = await c.askOwner({
        gate: "close_project",
        requestedBy: actorOf(agent),
        summary: `Close ${ledger.site.bid.opportunity.noticeId}: received ${usd(account.receivedUsd)}, paid out ${usd(account.paidOutUsd)}, cash profit ${usd(account.cashProfitUsd)}. ${typeof input.summary === "string" ? input.summary : ""}`.trim(),
      });
      if (req.status !== "approved") return err(`The owner did not close the project${req.reason ? `: ${req.reason}` : ""}.`);
      c.event("project_closed", "owner", { ...account });
      return { content: "The owner closed the project." };
    },
  };
}
