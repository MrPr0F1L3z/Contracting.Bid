import type { ModelProvider, ModelRequest, ModelResponse } from "./types.js";

/** Builds a plain text response, for tests and scripted scenarios. */
export function textResponse(text: string, model = "stub"): ModelResponse {
  return { model, text, toolCalls: [], stopReason: "end", usage: { inputTokens: 0, outputTokens: 0 } };
}

/** Builds a single tool-call response. */
export function toolCallResponse(
  name: string,
  input: Record<string, unknown>,
  id = `call_${name}`,
  model = "stub",
): ModelResponse {
  return {
    model,
    text: "",
    toolCalls: [{ id, name, input }],
    stopReason: "tool_call",
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

/**
 * Returns scripted responses in order and records every request.
 * Used by all unit and functional tests, so CI never calls a real model.
 */
export class ScriptedProvider implements ModelProvider {
  readonly name = "stub";
  readonly requests: ModelRequest[] = [];
  private index = 0;

  constructor(
    private readonly script: ModelResponse[],
    readonly model = "stub",
  ) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const next = this.script[this.index];
    if (!next) {
      throw new Error(`ScriptedProvider ran out of responses after ${this.index} calls`);
    }
    this.index++;
    return next;
  }

  remaining(): number {
    return this.script.length - this.index;
  }
}

/** Builds a response that calls several tools at once. */
export function toolCallsResponse(calls: Array<{ name: string; input: Record<string, unknown>; id: string }>, model = "stub"): ModelResponse {
  return { model, text: "", toolCalls: calls.map((c) => ({ ...c })), stopReason: "tool_call", usage: { inputTokens: 0, outputTokens: 0 } };
}

/**
 * Answers each request with a function of the request, and records every
 * request. For scripted runs whose path depends on the seed, where a fixed
 * list of responses cannot know what comes next.
 */
export class ReactiveProvider implements ModelProvider {
  readonly name = "stub";
  readonly requests: ModelRequest[] = [];

  constructor(
    private readonly respond: (request: ModelRequest) => ModelResponse,
    readonly model = "stub",
  ) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push({ ...request, messages: [...request.messages] });
    return this.respond(request);
  }
}
