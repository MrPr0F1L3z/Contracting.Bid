import { describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  DEFAULT_CLAUDE_MODEL,
  fromAnthropicResponse,
  mapAnthropicStopReason,
  toAnthropicMessages,
  toAnthropicTools,
} from "../src/models/anthropic.js";
import {
  OpenAiCompatibleProvider,
  fromOpenAiCompletion,
  mapOpenAiFinishReason,
  toOpenAiMessages,
  toOpenAiTools,
} from "../src/models/openaiCompatible.js";
import { ScriptedProvider, textResponse, toolCallResponse } from "../src/models/stub.js";
import { RecordingProvider, ReplayProvider } from "../src/models/recorder.js";
import { ModelRouter } from "../src/models/router.js";
import { parseToolInput, type ChatMessage, type ModelRequest } from "../src/models/types.js";

const convo: ChatMessage[] = [
  { role: "user", content: [{ type: "text", text: "Hire an HR rep" }] },
  { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "request_hire", input: { role: "hr" } }] },
  { role: "user", content: [{ type: "tool_result", toolCallId: "t1", content: "pending approval", isError: false }] },
];
const tool = { name: "request_hire", description: "Ask to hire", inputSchema: { properties: { role: { type: "string" } } } };
const request: ModelRequest = { system: "You are the President.", messages: convo, tools: [tool] };

describe("parseToolInput", () => {
  it("parses objects and falls back to {} on bad input", () => {
    expect(parseToolInput('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolInput("[1]")).toEqual({});
    expect(parseToolInput("not json")).toEqual({});
    expect(parseToolInput(undefined)).toEqual({});
  });
});

describe("Anthropic conversion", () => {
  it("toAnthropicMessages maps each part type", () => {
    const out = toAnthropicMessages(convo);
    expect(out[0]).toEqual({ role: "user", content: [{ type: "text", text: "Hire an HR rep" }] });
    expect(out[1]?.content).toEqual([{ type: "tool_use", id: "t1", name: "request_hire", input: { role: "hr" } }]);
    expect(out[2]?.content).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: "pending approval", is_error: false },
    ]);
  });

  it("toAnthropicTools adds the object type", () => {
    expect(toAnthropicTools([tool])[0]?.input_schema).toEqual({ type: "object", properties: { role: { type: "string" } } });
    expect(toAnthropicTools()).toEqual([]);
  });

  it("mapAnthropicStopReason covers known and unknown reasons", () => {
    expect(mapAnthropicStopReason("end_turn")).toBe("end");
    expect(mapAnthropicStopReason("stop_sequence")).toBe("end");
    expect(mapAnthropicStopReason("tool_use")).toBe("tool_call");
    expect(mapAnthropicStopReason("max_tokens")).toBe("max_tokens");
    expect(mapAnthropicStopReason("refusal")).toBe("refusal");
    expect(mapAnthropicStopReason("pause_turn")).toBe("other");
    expect(mapAnthropicStopReason(null)).toBe("other");
  });

  it("fromAnthropicResponse extracts text, tool calls and usage", () => {
    const res = fromAnthropicResponse({
      model: "claude-opus-5-5",
      stop_reason: "tool_use",
      content: [
        { type: "thinking" },
        { type: "text", text: "Hiring now." },
        { type: "tool_use", id: "t2", name: "request_hire", input: { role: "hr" } },
      ],
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    expect(res.text).toBe("Hiring now.");
    expect(res.toolCalls).toEqual([{ id: "t2", name: "request_hire", input: { role: "hr" } }]);
    expect(res.stopReason).toBe("tool_call");
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
  });
});

describe("AnthropicProvider", () => {
  it("builds params with adaptive thinking, effort and refusal fallbacks", () => {
    const p = new AnthropicProvider(undefined, { create: async () => { throw new Error("unused"); } });
    const params = p.buildParams(request);
    expect(params.model).toBe(DEFAULT_CLAUDE_MODEL);
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params.output_config).toEqual({ effort: "high" });
    expect(params.fallbacks).toBe("default");
    expect(params.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(params.tools).toHaveLength(1);
  });

  it("omits tools when none are given and calls the injected create", async () => {
    let seen: Record<string, unknown> | undefined;
    const p = new AnthropicProvider("claude-opus-5-5", {
      effort: "medium",
      create: async (params) => {
        seen = params;
        return { model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } };
      },
    });
    const res = await p.complete({ system: "s", messages: convo.slice(0, 1) });
    expect(res.text).toBe("ok");
    expect(seen && "tools" in seen).toBe(false);
    expect(seen?.output_config).toEqual({ effort: "medium" });
  });
});

describe("OpenAI-compatible conversion", () => {
  it("toOpenAiMessages puts the system first and splits tool results", () => {
    const out = toOpenAiMessages("sys", [
      ...convo,
      { role: "user", content: [{ type: "tool_result", toolCallId: "t9", content: "boom", isError: true }, { type: "text", text: "Try again" }] },
    ]);
    expect(out[0]).toEqual({ role: "system", content: "sys" });
    expect(out[1]).toEqual({ role: "user", content: "Hire an HR rep" });
    expect(out[2]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "t1", type: "function", function: { name: "request_hire", arguments: '{"role":"hr"}' } }],
    });
    expect(out[3]).toEqual({ role: "tool", tool_call_id: "t1", content: "pending approval" });
    expect(out[4]).toEqual({ role: "tool", tool_call_id: "t9", content: "ERROR: boom" });
    expect(out[5]).toEqual({ role: "user", content: "Try again" });
  });

  it("toOpenAiMessages keeps assistant text without tool calls", () => {
    const out = toOpenAiMessages("s", [{ role: "assistant", content: [{ type: "text", text: "hi" }] }]);
    expect(out[1]).toEqual({ role: "assistant", content: "hi" });
  });

  it("toOpenAiTools wraps tools as functions", () => {
    expect(toOpenAiTools([tool])[0]).toEqual({
      type: "function",
      function: { name: "request_hire", description: "Ask to hire", parameters: { type: "object", properties: { role: { type: "string" } } } },
    });
    expect(toOpenAiTools()).toEqual([]);
  });

  it("mapOpenAiFinishReason covers known and unknown reasons", () => {
    expect(mapOpenAiFinishReason("stop")).toBe("end");
    expect(mapOpenAiFinishReason("tool_calls")).toBe("tool_call");
    expect(mapOpenAiFinishReason("length")).toBe("max_tokens");
    expect(mapOpenAiFinishReason("content_filter")).toBe("refusal");
    expect(mapOpenAiFinishReason(undefined)).toBe("other");
  });

  it("fromOpenAiCompletion treats returned tool calls as a tool_call stop", () => {
    const res = fromOpenAiCompletion({
      model: "qwen",
      choices: [{ finish_reason: "stop", message: { content: null, tool_calls: [{ id: "c1", function: { name: "f", arguments: '{"x":2}' } }] } }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    });
    expect(res.stopReason).toBe("tool_call");
    expect(res.toolCalls).toEqual([{ id: "c1", name: "f", input: { x: 2 } }]);
    expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
    expect(res.text).toBe("");
  });

  it("fromOpenAiCompletion handles missing usage and rejects empty choices", () => {
    const res = fromOpenAiCompletion({ model: "q", choices: [{ finish_reason: "stop", message: { content: "hi" } }] });
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(() => fromOpenAiCompletion({ model: "q", choices: [] })).toThrow();
  });
});

describe("OpenAiCompatibleProvider", () => {
  it("builds params with temperature 0 and auto tool choice", async () => {
    let seen: Record<string, unknown> | undefined;
    const p = new OpenAiCompatibleProvider("qwen", {
      create: async (params) => {
        seen = params;
        return { model: "qwen", choices: [{ finish_reason: "stop", message: { content: "done" } }] };
      },
    });
    const res = await p.complete(request);
    expect(res.text).toBe("done");
    expect(seen?.temperature).toBe(0);
    expect(seen?.tool_choice).toBe("auto");
    expect(p.buildParams({ system: "s", messages: [] }).tools).toBeUndefined();
  });
});

describe("ScriptedProvider", () => {
  it("returns responses in order, records requests, and fails when empty", async () => {
    const p = new ScriptedProvider([textResponse("a"), toolCallResponse("f", { x: 1 })]);
    expect((await p.complete(request)).text).toBe("a");
    expect((await p.complete(request)).toolCalls[0]?.name).toBe("f");
    expect(p.requests).toHaveLength(2);
    expect(p.remaining()).toBe(0);
    await expect(p.complete(request)).rejects.toThrow(/ran out/);
  });

  it("toolCallResponse uses a default id", () => {
    expect(toolCallResponse("f", {}).toolCalls[0]?.id).toBe("call_f");
  });
});

describe("RecordingProvider and ReplayProvider", () => {
  it("replays recorded responses in order and detects divergence", async () => {
    const recorder = new RecordingProvider(new ScriptedProvider([textResponse("one"), textResponse("two")]), "hr");
    await recorder.complete(request);
    await recorder.complete(request);
    expect(recorder.calls.map((c) => c.key)).toEqual(["hr#0", "hr#1"]);
    expect(recorder.name).toBe("recording:stub");

    const replay = new ReplayProvider(recorder.calls, "hr");
    expect((await replay.complete(request)).text).toBe("one");
    expect((await replay.complete(request)).text).toBe("two");
    await expect(replay.complete(request)).rejects.toThrow(/diverged/);
  });
});

describe("ModelRouter", () => {
  it("routes Claude roles and local roles to the right provider", () => {
    const claude = new ScriptedProvider([], "claude");
    const local = new ScriptedProvider([], "local");
    const router = new ModelRouter({ claude, local });
    expect(router.providerFor("president")).toBe(claude);
    expect(router.providerFor("project_manager")).toBe(claude);
    expect(router.providerFor("hr")).toBe(local);
    expect(router.providerFor("vendor")).toBe(local);
  });

  it("throws for a role with no mapping", () => {
    const router = new ModelRouter({ claude: new ScriptedProvider([]), local: new ScriptedProvider([]) }, {} as never);
    expect(() => router.providerFor("hr")).toThrow(/No model/);
  });
});
