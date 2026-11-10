import { describe, expect, it } from "vitest";
import { runAgentTask, type ToolHandler } from "../src/agents/loop.js";
import { Budget } from "../src/budget/budget.js";
import { InMemoryEventLog } from "../src/events/eventLog.js";
import { ScriptedProvider, textResponse, toolCallResponse } from "../src/models/stub.js";
import type { ModelResponse } from "../src/models/types.js";

const echo: ToolHandler = {
  definition: { name: "echo", description: "Echo", inputSchema: { properties: { v: { type: "string" } } } },
  handle: async (input) => ({ content: `echo:${String(input.v)}` }),
};
const failing: ToolHandler = {
  definition: { name: "fail", description: "Throws", inputSchema: {} },
  handle: async () => {
    throw new Error("tool broke");
  },
};

function run(script: ModelResponse[], extra: Partial<Parameters<typeof runAgentTask>[0]> = {}) {
  const provider = new ScriptedProvider(script);
  const log = new InMemoryEventLog();
  const runBudget = new Budget(5);
  const result = runAgentTask({
    runId: "r1", actor: "president#1", provider, system: "sys", task: "Do it", tools: [echo, failing], runBudget, log, ...extra,
  });
  return { provider, log, runBudget, result };
}

describe("runAgentTask", () => {
  it("runs tool calls, feeds results back, and stops when the model stops calling tools", async () => {
    const { provider, log, result } = run([toolCallResponse("echo", { v: "a" }, "c1"), textResponse("All done")]);
    expect(await result).toMatchObject({ stop: "done", finalText: "All done", steps: 2, spentUsd: 0 });
    const second = provider.requests[1]!;
    expect(second.system).toBe("sys");
    expect(second.tools?.map((t) => t.name)).toEqual(["echo", "fail"]);
    expect(second.messages.at(-1)).toEqual({ role: "user", content: [{ type: "tool_result", toolCallId: "c1", content: "echo:a" }] });
    expect(log.list().map((e) => e.type)).toEqual(["model_call", "tool_call", "model_call", "task_finished"]);
    expect(log.list({ type: "tool_call" })[0]?.payload).toEqual({ tool: "echo", input: { v: "a" }, result: "echo:a", isError: false });
  });

  it("returns errors for unknown and failing tools instead of crashing", async () => {
    const both: ModelResponse = {
      ...toolCallResponse("nope", {}, "c1"),
      toolCalls: [{ id: "c1", name: "nope", input: {} }, { id: "c2", name: "fail", input: {} }],
    };
    const { provider, result } = run([both, textResponse("ok")]);
    await result;
    expect(provider.requests[1]!.messages.at(-1)?.content).toEqual([
      { type: "tool_result", toolCallId: "c1", content: 'Unknown tool "nope"', isError: true },
      { type: "tool_result", toolCallId: "c2", content: "tool broke", isError: true },
    ]);
  });

  it("keeps the provider's raw content on the assistant turn it sends back", async () => {
    const withRaw = { ...toolCallResponse("echo", { v: "x" }, "c1"), raw: [{ type: "thinking", signature: "s" }] };
    const { provider, result } = run([withRaw, textResponse("ok")]);
    await result;
    expect(provider.requests[1]!.messages[1]).toMatchObject({ role: "assistant", raw: { provider: "stub", content: [{ type: "thinking", signature: "s" }] } });
  });

  it("stops at the step limit", async () => {
    const { result } = run([toolCallResponse("echo", { v: "1" }), toolCallResponse("echo", { v: "2" })], { maxSteps: 2 });
    expect(await result).toMatchObject({ stop: "max_steps", steps: 2 });
  });

  it("stops on a refusal or a max_tokens cut-off", async () => {
    const refusal: ModelResponse = { ...textResponse("I can't help"), stopReason: "refusal" };
    expect(await run([refusal]).result).toMatchObject({ stop: "refusal", finalText: "I can't help", steps: 1 });
    const cut: ModelResponse = { ...textResponse("partial"), stopReason: "max_tokens" };
    expect(await run([cut]).result).toMatchObject({ stop: "max_tokens" });
  });

  it("charges Claude calls to the run budget and stops before a call once it is spent", async () => {
    const costly: ModelResponse = { ...toolCallResponse("echo", { v: "a" }), model: "claude-opus-5-5", usage: { inputTokens: 100_000, outputTokens: 40_000 } };
    const provider = new ScriptedProvider([costly, textResponse("never")]);
    const runBudget = new Budget(1);
    const log = new InMemoryEventLog();
    const result = await runAgentTask({ runId: "r", actor: "a", provider, system: "", task: "t", tools: [echo], runBudget, log });
    // 100k * $4/M + 40k * $20/M = $1.20, over the $1 budget.
    expect(result).toMatchObject({ stop: "budget", steps: 1 });
    expect(result.spentUsd).toBeCloseTo(1.2);
    expect(runBudget.status()).toBe("exceeded");
    expect(provider.remaining()).toBe(1);
    expect(log.list({ type: "model_call" })[0]?.payload.budget).toBe("exceeded");
  });

  it("also stops when the agent's own budget is spent", async () => {
    const costly: ModelResponse = { ...toolCallResponse("echo", { v: "a" }), model: "claude-opus-5-5", usage: { inputTokens: 0, outputTokens: 50_000 } };
    const provider = new ScriptedProvider([costly, textResponse("never")]);
    const agentBudget = new Budget(1);
    const runBudget = new Budget(5);
    const result = await runAgentTask({ runId: "r", actor: "a", provider, system: "", task: "t", tools: [echo], runBudget, agentBudget, log: new InMemoryEventLog() });
    expect(result).toMatchObject({ stop: "budget", steps: 1 });
    expect(agentBudget.spentUsd()).toBeCloseTo(1);
    expect(runBudget.spentUsd()).toBeCloseTo(1);
  });

  it("trims the final text and ignores blank text", async () => {
    const { result } = run([{ ...toolCallResponse("echo", { v: "a" }), text: "\n\nWorking on it. " }, textResponse("  ")]);
    expect((await result).finalText).toBe("Working on it.");
  });

  it("times the task and the model calls with the wall clock, outside the event log", async () => {
    let t = 0;
    const slow = new ScriptedProvider([toolCallResponse("echo", { v: "a" }), textResponse("done")]);
    const original = slow.complete.bind(slow);
    slow.complete = async (req) => { t += 100; return original(req); };
    const wallClock = () => (t += 5);
    const log = new InMemoryEventLog();
    const result = await runAgentTask({ runId: "r", actor: "a", provider: slow, system: "", task: "t", tools: [echo], runBudget: new Budget(5), log, wallClock });
    // Each model call takes 100ms plus one 5ms clock read; the task adds its own reads.
    expect(result.modelMs).toBe(210);
    expect(result.durationMs).toBeGreaterThan(result.modelMs);
    expect(JSON.stringify(log.list())).not.toContain("Ms");
  });

  it("passes maxTokens and stamps events with the sim time", async () => {
    const { provider, log, result } = run([textResponse("hi")], { maxTokens: 500, simTime: () => 7 });
    await result;
    expect(provider.requests[0]!.maxTokens).toBe(500);
    expect(log.list().every((e) => e.simTime === 7)).toBe(true);
  });
});
