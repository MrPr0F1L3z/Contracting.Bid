import type { ModelTarget } from "../config/roles.js";
import { ScriptedProvider, textResponse, toolCallResponse } from "../models/stub.js";

/** Standing instructions the scripted President gives HR. */
export const STUB_HR_INSTRUCTIONS =
  "Run the hiring pipeline. Hire a Project Manager first, then the estimator, procurement, scheduler and bookkeeper " +
  "as the President asks. Write clear standing instructions for each hire and keep budgets small.";

/** Standing instructions the scripted HR gives the Project Manager. */
export const STUB_PM_INSTRUCTIONS =
  "Run each awarded job from kickoff to closeout: schedule subcontractors, track cost and changes, and escalate " +
  "anything that commits money or a legal obligation to the President for owner approval.";

/**
 * Scripted models for a dry run of the hiring chain with no API key or GPU:
 * Claude plays the President and the local model plays HR.
 */
export function stubHiringProviders(): Record<ModelTarget, ScriptedProvider> {
  return {
    claude: new ScriptedProvider(
      [
        toolCallResponse("propose_hire", { role: "hr", instructions: STUB_HR_INSTRUCTIONS, budget_usd: 0.5, justification: "HR runs all hiring." }, "p1", "stub-claude"),
        textResponse("HR is hired and will run the hiring pipeline, starting with a Project Manager.", "stub-claude"),
      ],
      "stub-claude",
    ),
    local: new ScriptedProvider(
      [
        toolCallResponse("propose_hire", { role: "project_manager", instructions: STUB_PM_INSTRUCTIONS, budget_usd: 1, justification: "Needed before bidding." }, "h1", "stub-local"),
        textResponse("The Project Manager is hired and reports to the President.", "stub-local"),
      ],
      "stub-local",
    ),
  };
}
