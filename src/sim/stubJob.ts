import type { Profile } from "../config/profiles.js";
import type { ModelTarget } from "../config/roles.js";
import { ReactiveProvider, textResponse, toolCallsResponse } from "../models/stub.js";
import type { ModelRequest, ModelResponse } from "../models/types.js";
import { STUB_BID_PRICE_USD, STUB_ESTIMATOR_INSTRUCTIONS, STUB_PROCUREMENT_INSTRUCTIONS } from "./stubBid.js";
import { STUB_HR_INSTRUCTIONS, STUB_PM_INSTRUCTIONS } from "./stubHiring.js";

export const STUB_SCHEDULER_INSTRUCTIONS =
  "Sequence each awarded job's trades so each starts only when the work it depends on is done, and keep the plan inside the contract time.";

/** The first price the scripted PM asks for a change order; each retry asks 25% less. */
export const STUB_CHANGE_ORDER_USD = 12_000;

const hire = (role: string, instructions: string, budget: number, id: string) => ({
  name: "propose_hire", id, input: { role, instructions, budget_usd: budget, justification: "Requested in writing by the President." },
});

/** The scripted company's next move, from the tools on offer and how many turns the task has taken. */
export function stubJobMove(request: ModelRequest, model: string): ModelResponse {
  const tools = new Set((request.tools ?? []).map((t) => t.name));
  const turn = request.messages.filter((m) => m.role === "assistant").length;
  const first = request.messages[0]?.content[0];
  const task = first?.type === "text" ? first.text : "";
  const calls = (...c: Array<{ name: string; input: Record<string, unknown>; id: string }>) => toolCallsResponse(c, model);
  const done = textResponse("Done.", model);

  if (tools.has("propose_hire")) {
    if (turn > 0) return done;
    if (!task.startsWith("Written request")) return calls(hire("hr", STUB_HR_INSTRUCTIONS, 0.5, "s-hr"));
    if (task.includes("Project Manager")) return calls(hire("project_manager", STUB_PM_INSTRUCTIONS, 1, "s-pm"));
    if (task.includes("Estimator")) {
      return calls(hire("estimator", STUB_ESTIMATOR_INSTRUCTIONS, 0.5, "s-est"), hire("procurement", STUB_PROCUREMENT_INSTRUCTIONS, 0.5, "s-proc"));
    }
    if (task.includes("Scheduler")) return calls(hire("scheduler", STUB_SCHEDULER_INSTRUCTIONS, 0.5, "s-sch"));
    return done;
  }
  if (tools.has("decide_opportunity") && turn === 0) {
    return calls({ name: "decide_opportunity", id: "s-dec", input: { decision: "pursue", rationale: "Small two-trade interior job inside our capacity." } });
  }
  if (tools.has("submit_estimate") && turn === 0) {
    return calls({ name: "submit_estimate", id: "s-est1", input: {
      line_items: [
        { trade: "painting", scope: "Repaint 6,000 sq ft of walls and ceilings", cost_usd: 38_000 },
        { trade: "flooring", scope: "Replace 3,000 sq ft of carpet tile with LVT", cost_usd: 47_000 },
      ],
      notes: "Two zones while the building stays open.",
    } });
  }
  if (tools.has("request_quotes")) {
    if (turn === 0) return calls({ name: "request_quotes", id: "s-q1", input: { trade: "painting" } }, { name: "request_quotes", id: "s-q2", input: { trade: "flooring" } });
    if (turn === 1) return calls({ name: "select_quote", id: "s-q3", input: { quote_id: "Q-painting-1" } }, { name: "select_quote", id: "s-q4", input: { quote_id: "Q-flooring-1" } });
    return done;
  }
  if (tools.has("submit_bid") && turn === 0) {
    return calls({ name: "submit_bid", id: "s-bid", input: { price_usd: STUB_BID_PRICE_USD, assumptions: "Selected quotes plus 12% overhead and profit." } });
  }
  if (tools.has("sign_prime_contract")) {
    if (turn === 0) return calls({ name: "sign_prime_contract", id: "s-k1", input: {} });
    if (turn === 1) return calls({ name: "issue_subcontracts", id: "s-k2", input: {} });
    return done;
  }
  if (tools.has("set_schedule") && turn === 0) {
    return calls({ name: "set_schedule", id: "s-sch1", input: { sequence: ["painting", "flooring"] } });
  }
  if (tools.has("resolve_problem") && turn === 0) {
    const schema = request.tools!.find((t) => t.name === "resolve_problem")!.inputSchema as { properties: { option_id: { enum: string[] } } };
    return calls({ name: "resolve_problem", id: "s-res", input: { option_id: schema.properties.option_id.enum[0], note: "Protect the schedule." } });
  }
  if (tools.has("price_change_order")) {
    const last = request.messages.at(-1)?.content[0];
    const settled = last?.type === "tool_result" && (!last.isError || last.content.includes("last try"));
    if (turn > 0 && settled) return done;
    return calls({ name: "price_change_order", id: `s-co${turn}`, input: { price_usd: Math.round(STUB_CHANGE_ORDER_USD * 0.75 ** turn), days: 2, justification: "Cost plus 15%." } });
  }
  return done;
}

/**
 * Scripted models for a dry run of the whole job on STUB-E02. Unlike the
 * fixed scripts of earlier slices, these answer each request from the tools
 * on offer, because which site problems come up depends on the seed.
 */
export function stubJobProviders(profile: Profile = "cloud"): Record<ModelTarget, ReactiveProvider> {
  const worker = profile === "cloud" ? "stub-claude-worker" : "stub-local";
  return {
    claude: new ReactiveProvider((r) => stubJobMove(r, "stub-claude"), "stub-claude"),
    local: new ReactiveProvider((r) => stubJobMove(r, worker), worker),
  };
}
