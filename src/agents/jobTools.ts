import type { AgentRecord } from "./registry.js";
import type { ToolHandler } from "./loop.js";
import type { Company } from "../sim/company.js";
import type { SiteProblem, SiteWorld } from "../world/site.js";

/** What the agents have done so far on one awarded job. */
export interface JobState {
  contractSigned?: boolean;
  /** True once every selected subcontract is signed. */
  subcontractsIssued?: boolean;
  /** Trades whose subcontract the owner has signed. */
  issuedTrades?: string[];
  /** Change order submissions to the contracting officer, by problem id. */
  changeOrderTries: Record<string, number>;
}

/** After this many rejected prices, a change is performed under dispute with no change order. */
export const MAX_CHANGE_ORDER_TRIES = 3;

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;
const actorOf = (a: AgentRecord) => `${a.role}#${a.id}`;
const err = (content: string) => ({ content, isError: true });

/** sign_prime_contract and issue_subcontracts (PM). Both are owner gates. */
export function kickoffTools(c: Company, agent: AgentRecord, site: SiteWorld, state: JobState): ToolHandler[] {
  const job = site.bid.opportunity.noticeId;
  return [
    {
      definition: {
        name: "sign_prime_contract",
        description: "Ask the owner to sign the prime contract with the government for the awarded price.",
        inputSchema: { properties: {}, additionalProperties: false },
      },
      async handle() {
        if (state.contractSigned) return err("The prime contract is already signed.");
        const req = await c.askOwner({
          gate: "sign_contract",
          requestedBy: actorOf(agent),
          summary: `Sign the prime contract for ${job} at ${usd(site.contractPriceUsd)}, ${site.contractDays} working days, liquidated damages ${usd(site.ldPerDayUsd)} per day late.`,
          amountUsd: site.contractPriceUsd,
        });
        if (req.status !== "approved") return err(`The owner did not sign${req.reason ? `: ${req.reason}` : ""}.`);
        state.contractSigned = true;
        c.event("contract_signed", "owner", { noticeId: job, priceUsd: site.contractPriceUsd, contractDays: site.contractDays });
        return { content: `The owner signed the prime contract: ${usd(site.contractPriceUsd)}, ${site.contractDays} working days.` };
      },
    },
    {
      definition: {
        name: "issue_subcontracts",
        description: "Ask the owner to sign the selected subcontracts not yet signed, at their quoted prices. The owner may sign all or only some. Needs the prime contract signed first.",
        inputSchema: { properties: {}, additionalProperties: false },
      },
      async handle() {
        if (!state.contractSigned) return err("Sign the prime contract first.");
        if (state.subcontractsIssued) return err("The subcontracts are already issued.");
        const issued = state.issuedTrades ?? [];
        const subs = [...site.subcontracts.values()].filter((q) => !issued.includes(q.trade));
        const total = subs.reduce((a, q) => a + q.priceUsd, 0);
        const req = await c.askOwner({
          gate: "sign_commitment",
          requestedBy: actorOf(agent),
          summary: `Issue ${subs.length} subcontracts for ${job} totaling ${usd(total)}.`,
          amountUsd: total,
          items: subs.map((q) => ({ id: q.trade, label: `${q.subcontractor} for ${q.trade}`, amountUsd: q.priceUsd })),
        });
        if (req.status !== "approved") return err(`The owner did not sign the subcontracts${req.reason ? `: ${req.reason}` : ""}.`);
        const signed = subs.filter((q) => req.approvedItems?.includes(q.trade) ?? true);
        state.issuedTrades = [...issued, ...signed.map((q) => q.trade)];
        const signedUsd = signed.reduce((a, q) => a + q.priceUsd, 0);
        c.event("subcontracts_issued", "owner", { noticeId: job, trades: signed.map((q) => q.trade), totalUsd: signedUsd });
        const left = subs.filter((q) => !signed.includes(q));
        if (left.length === 0) {
          state.subcontractsIssued = true;
          return { content: `The owner signed ${signed.length} subcontracts totaling ${usd(signedUsd)}. Every subcontract is signed.` };
        }
        return err(`The owner signed ${signed.length} of ${subs.length} subcontracts. Not signed: ${left.map((q) => q.trade).join(", ")}${req.reason ? ` (${req.reason})` : ""}. Ask again for those, or escalate.`);
      },
    },
  ];
}

/** set_schedule (Scheduler): the order the trades work in. */
export function setScheduleTool(c: Company, agent: AgentRecord, site: SiteWorld): ToolHandler {
  return {
    definition: {
      name: "set_schedule",
      description: "Set the order the subcontracted trades work in, first to last. Trades work one after another.",
      inputSchema: {
        properties: { sequence: { type: "array", items: { type: "string" }, description: "Every subcontracted trade, once each, in working order." } },
        required: ["sequence"],
        additionalProperties: false,
      },
    },
    async handle(input) {
      const seq = input.sequence;
      if (!Array.isArray(seq) || !seq.every((t) => typeof t === "string")) return err("sequence must be a list of trade names");
      const problem = site.setSchedule(seq as string[]);
      if (problem) return err(problem);
      const lines = site.scheduled()!;
      c.event("schedule_set", actorOf(agent), { lines, plannedDays: site.plannedDays(), contractDays: site.contractDays });
      return {
        content: [
          ...lines.map((l) => `${l.trade}: day ${l.startDay + 1} to ${l.startDay + l.days}`),
          `Planned: ${site.plannedDays()} working days of ${site.contractDays} in the contract.`,
        ].join("\n"),
      };
    },
  };
}

/** The problem as the PM sees it. Hides a scope change's true cost. */
export function problemBrief(site: SiteWorld, p: SiteProblem): string {
  const header = `Day ${p.day + 1} of ${site.contractDays} on ${site.bid.opportunity.noticeId}: ${p.description}`;
  const terms = `Liquidated damages are ${usd(site.ldPerDayUsd)} per working day past the contract time.`;
  if (p.change) {
    const sub = site.subcontracts.get(p.trade);
    return [
      header,
      `${sub?.subcontractor ?? `The ${p.trade} subcontractor`} quotes ${usd(p.change.costUsd)} and ${p.change.days} working days for the added work.`,
      p.change.initiatedBy === "government"
        ? "The government must pay for directed changes. Price the change order with price_change_order: cost plus reasonable overhead and profit, and the working days it adds."
        : "This is a differing site condition. Request a change order with price_change_order: cost plus reasonable overhead and profit, and the working days it adds.",
      terms,
    ].join("\n");
  }
  return [
    header,
    "Options (choose one with resolve_problem):",
    ...p.options.map((o) => `- ${o.id}: ${o.label}. Cost ${usd(o.costUsd)}, delay ${o.days} working days.`),
    terms,
  ].join("\n");
}

/** resolve_problem (PM): picks one of a site problem's fixed options. */
export function resolveProblemTool(c: Company, agent: AgentRecord, site: SiteWorld, problem: SiteProblem): ToolHandler {
  return {
    definition: {
      name: "resolve_problem",
      description: "Choose how to resolve the site problem. The choice is final.",
      inputSchema: {
        properties: {
          option_id: { type: "string", enum: problem.options.map((o) => o.id) },
          note: { type: "string", description: "Why this option: cost, schedule and risk." },
        },
        required: ["option_id", "note"],
        additionalProperties: false,
      },
    },
    async handle(input) {
      if (site.resolved().some((r) => r.problemId === problem.id)) return err("This problem is already resolved.");
      const option = problem.options.find((o) => o.id === input.option_id);
      if (!option) return err(`Unknown option "${String(input.option_id)}"; use ${problem.options.map((o) => o.id).join(" or ")}`);
      site.record({ problemId: problem.id, trade: problem.trade, choice: option.id, costUsd: option.costUsd, days: option.days });
      c.event("problem_resolved", actorOf(agent), { problem: problem.id, trade: problem.trade, choice: option.id, costUsd: option.costUsd, days: option.days, note: typeof input.note === "string" ? input.note : "" });
      return { content: `Resolved: ${option.label}.` };
    },
  };
}

/**
 * price_change_order (PM): proposes a price and time extension for a scope
 * change. The owner approves it before the contracting officer sees it.
 */
export function priceChangeOrderTool(c: Company, agent: AgentRecord, site: SiteWorld, problem: SiteProblem, state: JobState): ToolHandler {
  const change = problem.change;
  if (!change) throw new Error(`${problem.id} is not a scope change`);
  return {
    definition: {
      name: "price_change_order",
      description: `Propose a change order to the contracting officer. The owner approves it first. After ${MAX_CHANGE_ORDER_TRIES} rejected prices the work goes ahead under dispute, unpaid.`,
      inputSchema: {
        properties: {
          price_usd: { type: "number", description: "Price of the change, including overhead and profit." },
          days: { type: "number", description: "Working days the change adds to the contract." },
          justification: { type: "string" },
        },
        required: ["price_usd", "days", "justification"],
        additionalProperties: false,
      },
    },
    async handle(input) {
      if (site.resolved().some((r) => r.problemId === problem.id)) return err("This change is already settled.");
      const price = input.price_usd;
      const days = input.days;
      if (typeof price !== "number" || !(price > 0)) return err("price_usd must be a positive number");
      if (typeof days !== "number" || !Number.isInteger(days) || days < 0) return err("days must be a whole number of 0 or more");
      const req = await c.askOwner({
        gate: "approve_change_order",
        requestedBy: actorOf(agent),
        summary: `Change order on ${site.bid.opportunity.noticeId}: ${usd(Math.round(price))} and ${days} days. ${problem.description} ${typeof input.justification === "string" ? input.justification : ""}`.trim(),
        amountUsd: Math.round(price),
      });
      if (req.status !== "approved") return err(`The owner rejected this change order${req.reason ? `: ${req.reason}` : ""}. You may revise it.`);
      const tries = (state.changeOrderTries[problem.id] ?? 0) + 1;
      state.changeOrderTries[problem.id] = tries;
      const decision = site.judgeChangeOrder(change, Math.round(price), days);
      c.event("change_order_decided", "contracting_officer", { problem: problem.id, priceUsd: Math.round(price), days, accepted: decision.accepted, reason: decision.reason });
      if (decision.accepted) {
        site.record({ problemId: problem.id, trade: problem.trade, choice: "change_order", costUsd: change.costUsd, days: change.days, changeOrder: { priceUsd: Math.round(price), days } });
        return { content: `The contracting officer accepted the change order: ${usd(Math.round(price))} and ${days} days.` };
      }
      if (tries >= MAX_CHANGE_ORDER_TRIES) {
        site.record({ problemId: problem.id, trade: problem.trade, choice: "disputed", costUsd: change.costUsd, days: change.days, changeOrder: null });
        c.event("change_disputed", actorOf(agent), { problem: problem.id });
        return err(`${decision.reason} That was the last try: the work goes ahead under dispute, with no payment or time extension.`);
      }
      return err(`${decision.reason} You have ${MAX_CHANGE_ORDER_TRIES - tries} tries left.`);
    },
  };
}
