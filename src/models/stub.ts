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
