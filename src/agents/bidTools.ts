import type { AgentRecord } from "./registry.js";
import type { ToolHandler } from "./loop.js";
import type { Company } from "../sim/company.js";
import { TRADES, isTrade, type BidWorld, type Trade } from "../world/market.js";

export interface EstimateLine {
  trade: Trade;
  scope: string;
  costUsd: number;
}

/** What the agents have produced so far in one bid. */
export interface BidState {
  decision?: { pursue: boolean; rationale: string; ownerApproved?: boolean; ownerReason?: string };
  estimate?: { lines: EstimateLine[]; notes: string };
  bid?: { priceUsd: number; assumptions: string; ownerApproved: boolean; ownerReason?: string };
}

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;
const actorOf = (a: AgentRecord) => `${a.role}#${a.id}`;
const err = (content: string) => ({ content, isError: true });

/** decide_opportunity (President): pursue or no-bid. Pursuing needs the owner's approval. */
export function decideOpportunityTool(c: Company, agent: AgentRecord, world: BidWorld, state: BidState): ToolHandler {
  return {
    definition: {
      name: "decide_opportunity",
      description: "Record the go/no-go decision on this solicitation. A decision to pursue goes to the owner for approval.",
      inputSchema: {
        properties: {
          decision: { type: "string", enum: ["pursue", "no_bid"] },
          rationale: { type: "string", description: "Why, in a few sentences: fit, risk, capacity, value." },
        },
        required: ["decision", "rationale"],
        additionalProperties: false,
      },
    },
    async handle(input) {
      const { decision, rationale } = input;
      if (decision !== "pursue" && decision !== "no_bid") return err('decision must be "pursue" or "no_bid"');
      if (typeof rationale !== "string" || rationale.trim().length < 10) return err("rationale must explain the decision");
      if (state.decision?.ownerApproved) return err("The owner already approved pursuing this job.");
      if (decision === "no_bid") {
        state.decision = { pursue: false, rationale };
        c.event("opportunity_decided", actorOf(agent), { noticeId: world.opportunity.noticeId, decision, rationale });
        return { content: "Recorded: no bid." };
      }
      const req = await c.askOwner({
        gate: "pursue_opportunity",
        requestedBy: actorOf(agent),
        summary: `Pursue ${world.opportunity.noticeId} "${world.opportunity.title}". ${rationale}`,
      });
      const approved = req.status === "approved";
      state.decision = { pursue: true, rationale, ownerApproved: approved, ...(req.reason ? { ownerReason: req.reason } : {}) };
      c.event("opportunity_decided", actorOf(agent), { noticeId: world.opportunity.noticeId, decision, rationale, ownerApproved: approved });
      return approved
        ? { content: "The owner approved pursuing this job. Estimating starts next." }
        : err(`The owner declined to pursue${req.reason ? `: ${req.reason}` : ""}.`);
    },
  };
}

/** submit_estimate (Estimator): the trade breakdown with costs. Resubmitting replaces it. */
export function submitEstimateTool(c: Company, agent: AgentRecord, state: BidState): ToolHandler {
  return {
    definition: {
      name: "submit_estimate",
      description: "Submit the estimate as one line per subcontracted trade. Resubmitting replaces the earlier estimate.",
      inputSchema: {
        properties: {
          line_items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                trade: { type: "string", enum: [...TRADES] },
                scope: { type: "string", description: "What this trade does on this job." },
                cost_usd: { type: "number", description: "Your estimate of the subcontract cost." },
              },
              required: ["trade", "scope", "cost_usd"],
              additionalProperties: false,
            },
          },
          notes: { type: "string", description: "Assumptions, exclusions and risks." },
        },
        required: ["line_items", "notes"],
        additionalProperties: false,
      },
    },
    async handle(input) {
      const items = input.line_items;
      if (!Array.isArray(items) || items.length === 0) return err("line_items must list at least one trade");
      const lines: EstimateLine[] = [];
      for (const raw of items as Array<Record<string, unknown>>) {
        const { trade, scope, cost_usd: cost } = raw ?? {};
        if (typeof trade !== "string" || !isTrade(trade)) return err(`Unknown trade "${String(trade)}"; use one of: ${TRADES.join(", ")}`);
        if (lines.some((l) => l.trade === trade)) return err(`${trade} is listed twice; combine it into one line`);
        if (typeof cost !== "number" || !(cost > 0)) return err(`cost_usd for ${trade} must be a positive number`);
        lines.push({ trade, scope: typeof scope === "string" ? scope : "", costUsd: Math.round(cost) });
      }
      state.estimate = { lines, notes: typeof input.notes === "string" ? input.notes : "" };
      const total = lines.reduce((a, l) => a + l.costUsd, 0);
      c.event("estimate_submitted", actorOf(agent), { lines: lines.map((l) => ({ ...l })), totalUsd: total });
      return { content: `Estimate recorded: ${lines.length} trades, ${usd(total)} in subcontract cost.` };
    },
  };
}

/** request_quotes, select_quote and procurement_status (Procurement). */
export function procurementTools(c: Company, agent: AgentRecord, world: BidWorld, state: BidState): ToolHandler[] {
  return [
    {
      definition: {
        name: "request_quotes",
        description: "Ask the subcontractor market for quotes on one trade.",
        inputSchema: { properties: { trade: { type: "string", enum: [...TRADES] } }, required: ["trade"], additionalProperties: false },
      },
      async handle(input) {
        const trade = input.trade;
        if (typeof trade !== "string" || !isTrade(trade)) return err(`Unknown trade "${String(trade)}"`);
        const quotes = world.quotesFor(trade);
        c.event("quotes_received", actorOf(agent), { trade, quotes: quotes.map((q) => ({ ...q })) });
        return { content: quotes.map((q) => `${q.quoteId}: ${q.subcontractor}, ${usd(q.priceUsd)}, valid ${q.validDays} days`).join("\n") };
      },
    },
    {
      definition: {
        name: "select_quote",
        description: "Select one subcontractor quote to carry in the bid. One per trade; a later selection replaces it.",
        inputSchema: { properties: { quote_id: { type: "string" } }, required: ["quote_id"], additionalProperties: false },
      },
      async handle(input) {
        if (typeof input.quote_id !== "string") return err("quote_id is required");
        let sel;
        try {
          sel = world.select(input.quote_id);
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
        c.event("quote_selected", actorOf(agent), { quoteId: sel.quote.quoteId, trade: sel.quote.trade, priceUsd: sel.quote.priceUsd, repricedFromUsd: sel.repricedFromUsd ?? null });
        if (sel.repricedFromUsd !== undefined) {
          c.event("problem_injected", "world", { problem: "quote-expired", trade: sel.quote.trade, fromUsd: sel.repricedFromUsd, toUsd: sel.quote.priceUsd });
          return {
            content: `${sel.quote.quoteId} had expired. ${sel.quote.subcontractor} re-quoted at ${usd(sel.quote.priceUsd)} (was ${usd(sel.repricedFromUsd)}). ` +
              "The new price is selected; choose another quote if it is no longer the best value.",
          };
        }
        return { content: `Selected ${sel.quote.quoteId}: ${sel.quote.subcontractor} at ${usd(sel.quote.priceUsd)}.` };
      },
    },
    {
      definition: {
        name: "procurement_status",
        description: "Show which estimate trades still have no selected quote.",
        inputSchema: { properties: {}, additionalProperties: false },
      },
      async handle() {
        const selected = world.selected();
        const trades = state.estimate?.lines.map((l) => l.trade) ?? [];
        const open = trades.filter((t) => !selected.has(t));
        const done = [...selected.values()].map((s) => `${s.quote.trade}: ${s.quote.quoteId} ${usd(s.quote.priceUsd)}`);
        return { content: [`Selected: ${done.length > 0 ? done.join("; ") : "none"}`, `Still open: ${open.length > 0 ? open.join(", ") : "none"}`].join("\n") };
      },
    },
  ];
}

/** submit_bid (PM): the bid price. It goes to the owner before it reaches the contracting officer. */
export function submitBidTool(c: Company, agent: AgentRecord, world: BidWorld, state: BidState): ToolHandler {
  return {
    definition: {
      name: "submit_bid",
      description: "Propose the bid price. The owner must approve it before it is submitted to the contracting officer.",
      inputSchema: {
        properties: {
          price_usd: { type: "number", description: "Total bid price, including overhead and profit." },
          assumptions: { type: "string", description: "Key assumptions, exclusions and the markup you applied." },
        },
        required: ["price_usd", "assumptions"],
        additionalProperties: false,
      },
    },
    async handle(input) {
      const price = input.price_usd;
      if (typeof price !== "number" || !(price > 0)) return err("price_usd must be a positive number");
      if (state.bid?.ownerApproved) return err("A bid was already approved and submitted.");
      const assumptions = typeof input.assumptions === "string" ? input.assumptions : "";
      const req = await c.askOwner({
        gate: "submit_bid",
        requestedBy: actorOf(agent),
        summary: `Submit a ${usd(Math.round(price))} bid on ${world.opportunity.noticeId}. ${assumptions}`.trim(),
        amountUsd: Math.round(price),
      });
      const approved = req.status === "approved";
      state.bid = { priceUsd: Math.round(price), assumptions, ownerApproved: approved, ...(req.reason ? { ownerReason: req.reason } : {}) };
      return approved
        ? { content: `The owner approved the ${usd(Math.round(price))} bid. It has been submitted to the contracting officer.` }
        : err(`The owner rejected this bid${req.reason ? `: ${req.reason}` : ""}. You may revise and propose again.`);
    },
  };
}
