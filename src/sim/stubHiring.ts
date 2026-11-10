import type { Profile } from "../config/profiles.js";
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

const presidentScript = (model: string) => [
  toolCallResponse("propose_hire", { role: "hr", instructions: STUB_HR_INSTRUCTIONS, budget_usd: 0.5, justification: "HR runs all hiring." }, "p1", model),
  textResponse("HR is hired and will run the hiring pipeline, starting with a Project Manager.", model),
];

const hrScript = (model: string) => [
  toolCallResponse("propose_hire", { role: "project_manager", instructions: STUB_PM_INSTRUCTIONS, budget_usd: 1, justification: "Needed before bidding." }, "h1", model),
  textResponse("The Project Manager is hired and reports to the President.", model),
];

/**
 * Scripted models for a dry run of the hiring chain with no API key or GPU.
 * Hybrid: Claude plays the President and the local model plays HR.
 * Cloud: Claude plays both, in order, and the local model is never called.
 */
export function stubHiringProviders(profile: Profile = "hybrid"): Record<ModelTarget, ScriptedProvider> {
  if (profile === "cloud") {
    return {
      claude: new ScriptedProvider([...presidentScript("stub-claude"), ...hrScript("stub-claude")], "stub-claude"),
      local: new ScriptedProvider([], "stub-local"),
    };
  }
  return {
    claude: new ScriptedProvider(presidentScript("stub-claude"), "stub-claude"),
    local: new ScriptedProvider(hrScript("stub-local"), "stub-local"),
  };
}
