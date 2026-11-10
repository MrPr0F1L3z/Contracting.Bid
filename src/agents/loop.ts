import { costOf } from "../budget/budget.js";
import type { Budget } from "../budget/budget.js";
import type { EventLog } from "../events/eventLog.js";
import {
  assistantMessage,
  type ChatMessage,
  type ContentPart,
  type ModelProvider,
  type ToolDefinition,
} from "../models/types.js";

export interface ToolResult {
  content: string;
  isError?: boolean;
}

/** A tool an agent can call: its definition and the code that runs it. */
export interface ToolHandler {
  definition: ToolDefinition;
  handle(input: Record<string, unknown>): Promise<ToolResult>;
}

export type TaskStop = "done" | "max_steps" | "budget" | "refusal" | "max_tokens";

export interface TaskResult {
  stop: TaskStop;
  finalText: string;
  steps: number;
  spentUsd: number;
}

export interface AgentTaskOptions {
  runId: string;
  /** Who is acting, as written to the event log, e.g. "president#1". */
  actor: string;
  provider: ModelProvider;
  system: string;
  task: string;
  tools: ToolHandler[];
  /** The run's shared budget; the loop stops when it is used up. */
  runBudget: Budget;
  /** The agent's own budget, if it has one; the loop also stops when it is spent. */
  agentBudget?: Budget;
  log: EventLog;
  simTime?: () => number;
  /** Model calls allowed for this task. */
  maxSteps?: number;
  maxTokens?: number;
}

/**
 * Runs one agent on one task: calls the model, runs the tools it asks for,
 * and repeats until it stops calling tools, the step limit is reached, or
 * the run budget is spent. Every model call and tool call is logged.
 */
export async function runAgentTask(o: AgentTaskOptions): Promise<TaskResult> {
  const maxSteps = o.maxSteps ?? 8;
  const now = o.simTime ?? (() => 0);
  const handlers = new Map(o.tools.map((t) => [t.definition.name, t]));
  const definitions = o.tools.map((t) => t.definition);
  const messages: ChatMessage[] = [{ role: "user", content: [{ type: "text", text: o.task }] }];
  let spent = 0;
  let finalText = "";

  for (let step = 1; step <= maxSteps; step++) {
    if (!o.runBudget.canSpend() || (o.agentBudget && !o.agentBudget.canSpend())) return finish("budget", step - 1);
    const response = await o.provider.complete({
      system: o.system,
      messages: [...messages], // a snapshot, so recorded requests stay as sent
      tools: definitions,
      ...(o.maxTokens !== undefined ? { maxTokens: o.maxTokens } : {}),
    });
    const cost = costOf(response.model, response.usage);
    spent += cost;
    const budgetStatus = o.runBudget.charge(cost);
    o.agentBudget?.charge(cost);
    o.log.append({
      runId: o.runId,
      type: "model_call",
      actor: o.actor,
      simTime: now(),
      payload: { model: response.model, usage: { ...response.usage }, costUsd: cost, stopReason: response.stopReason, budget: budgetStatus },
    });
    if (response.text) finalText = response.text;
    if (response.stopReason === "refusal") return finish("refusal", step);
    messages.push(assistantMessage(response, o.provider.name));
    if (response.toolCalls.length === 0) return finish(response.stopReason === "max_tokens" ? "max_tokens" : "done", step);

    // Run every call, then return all results in one user message.
    const results: ContentPart[] = [];
    for (const call of response.toolCalls) {
      const handler = handlers.get(call.name);
      let result: ToolResult;
      try {
        result = handler ? await handler.handle(call.input) : { content: `Unknown tool "${call.name}"`, isError: true };
      } catch (err) {
        result = { content: err instanceof Error ? err.message : String(err), isError: true };
      }
      o.log.append({
        runId: o.runId,
        type: "tool_call",
        actor: o.actor,
        simTime: now(),
        payload: { tool: call.name, input: call.input, result: result.content, isError: result.isError ?? false },
      });
      results.push({ type: "tool_result", toolCallId: call.id, content: result.content, ...(result.isError ? { isError: true } : {}) });
    }
    messages.push({ role: "user", content: results });
  }
  return finish("max_steps", maxSteps);

  function finish(stop: TaskStop, steps: number): TaskResult {
    o.log.append({ runId: o.runId, type: "task_finished", actor: o.actor, simTime: now(), payload: { stop, steps, spentUsd: spent } });
    return { stop, finalText, steps, spentUsd: spent };
  }
}
