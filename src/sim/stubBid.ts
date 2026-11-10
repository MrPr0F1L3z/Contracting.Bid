import type { Profile } from "../config/profiles.js";
import type { ModelTarget } from "../config/roles.js";
import { ScriptedProvider, textResponse, toolCallResponse } from "../models/stub.js";
import { STUB_HR_INSTRUCTIONS, STUB_PM_INSTRUCTIONS } from "./stubHiring.js";

/** The job the scripted bid run is written for: two trades, painting and flooring. */
export const STUB_BID_JOB = "STUB-E02";

/** The price the scripted PM bids. */
export const STUB_BID_PRICE_USD = 105_000;

export const STUB_ESTIMATOR_INSTRUCTIONS =
  "Estimate every solicitation the President pursues: list each subcontracted trade with its scope and cost, and note assumptions and exclusions.";
export const STUB_PROCUREMENT_INSTRUCTIONS =
  "Get at least two quotes per trade, select the best value, and re-check any quote that changes. Never sign anything.";

const claudeScript = (m: string) => [
  // President hires HR (slice 1).
  toolCallResponse("propose_hire", { role: "hr", instructions: STUB_HR_INSTRUCTIONS, budget_usd: 0.5, justification: "HR runs all hiring." }, "p1", m),
  textResponse("HR is hired.", m),
  // President decides to pursue.
  toolCallResponse("decide_opportunity", { decision: "pursue", rationale: "Small two-trade interior job inside our capacity, with a set-aside that fits us." }, "p2", m),
  textResponse("We are pursuing the job.", m),
  // PM sets the price.
  toolCallResponse("submit_bid", { price_usd: STUB_BID_PRICE_USD, assumptions: "Selected quotes plus 12% overhead and profit; work in two zones while open." }, "pm1", m),
  textResponse("The bid is submitted.", m),
];

const workerScript = (m: string) => [
  // HR hires the PM (slice 1).
  toolCallResponse("propose_hire", { role: "project_manager", instructions: STUB_PM_INSTRUCTIONS, budget_usd: 1, justification: "Needed before bidding." }, "h1", m),
  textResponse("The Project Manager is hired.", m),
  // HR hires the bid team.
  toolCallResponse("propose_hire", { role: "estimator", instructions: STUB_ESTIMATOR_INSTRUCTIONS, budget_usd: 0.5, justification: "Bidding STUB-E02." }, "h2", m),
  toolCallResponse("propose_hire", { role: "procurement", instructions: STUB_PROCUREMENT_INSTRUCTIONS, budget_usd: 0.5, justification: "Bidding STUB-E02." }, "h3", m),
  textResponse("The Estimator and Procurement agent are hired.", m),
  // Estimator.
  toolCallResponse("submit_estimate", {
    line_items: [
      { trade: "painting", scope: "Repaint 6,000 sq ft of walls and ceilings", cost_usd: 38_000 },
      { trade: "flooring", scope: "Replace 3,000 sq ft of carpet tile with LVT", cost_usd: 47_000 },
    ],
    notes: "Two zones while the building stays open; after-hours premium excluded.",
  }, "e1", m),
  textResponse("Estimate submitted.", m),
  // Procurement.
  toolCallResponse("request_quotes", { trade: "painting" }, "q1", m),
  toolCallResponse("request_quotes", { trade: "flooring" }, "q2", m),
  toolCallResponse("select_quote", { quote_id: "Q-painting-1" }, "q3", m),
  toolCallResponse("select_quote", { quote_id: "Q-flooring-1" }, "q4", m),
  toolCallResponse("procurement_status", {}, "q5", m),
  textResponse("Both trades have a selected quote.", m),
];

/**
 * Scripted models for a dry run of the bid chain on STUB-E02. Claude plays
 * the President and the PM; the worker target plays HR, the Estimator and
 * Procurement. The script assumes every owner gate is approved.
 */
export function stubBidProviders(profile: Profile = "cloud"): Record<ModelTarget, ScriptedProvider> {
  const worker = profile === "cloud" ? "stub-claude-worker" : "stub-local";
  return {
    claude: new ScriptedProvider(claudeScript("stub-claude"), "stub-claude"),
    local: new ScriptedProvider(workerScript(worker), worker),
  };
}
