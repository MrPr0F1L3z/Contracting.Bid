import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatMessage,
  ContentPart,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  StopReason,
  ToolDefinition,
} from "./types.js";

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

/** Converts one neutral content part to an Anthropic block. */
function toAnthropicBlock(part: ContentPart): Anthropic.ContentBlockParam {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "tool_call":
      return { type: "tool_use", id: part.id, name: part.name, input: part.input };
    case "tool_result":
      return { type: "tool_result", tool_use_id: part.toolCallId, content: part.content, is_error: part.isError ?? false };
  }
}

/**
 * Converts neutral messages to Anthropic message params. An assistant turn
 * that Claude produced is sent back exactly as returned, thinking blocks
 * included, which the API requires in a tool-use loop.
 */
export function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  return messages.map((m) =>
    m.role === "assistant" && m.raw?.provider === "anthropic"
      ? { role: "assistant", content: m.raw.content as Anthropic.ContentBlockParam[] }
      : { role: m.role, content: m.content.map(toAnthropicBlock) },
  );
}

/** Converts neutral tool definitions to Anthropic tools. */
export function toAnthropicTools(tools: ToolDefinition[] = []): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: { type: "object", ...t.inputSchema } as Anthropic.Tool.InputSchema,
  }));
}

/** Maps an Anthropic stop reason to the neutral one. */
export function mapAnthropicStopReason(reason: string | null): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end";
    case "tool_use":
      return "tool_call";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

/** Shape of the response fields this provider reads. */
export interface AnthropicLikeResponse {
  model: string;
  stop_reason: string | null;
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  usage: { input_tokens: number; output_tokens: number };
}

/** Converts an Anthropic response into the neutral shape. */
export function fromAnthropicResponse(response: AnthropicLikeResponse): ModelResponse {
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  const toolCalls = response.content
    .filter((b) => b.type === "tool_use")
    .map((b) => ({
      id: b.id ?? "",
      name: b.name ?? "",
      input: (b.input ?? {}) as Record<string, unknown>,
    }));
  return {
    model: response.model,
    text,
    toolCalls,
    stopReason: mapAnthropicStopReason(response.stop_reason),
    usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
    raw: response.content,
  };
}

/** The one SDK call this provider makes, so tests can inject a fake. */
export type AnthropicCreate = (params: Record<string, unknown>) => Promise<AnthropicLikeResponse>;

/**
 * Claude provider for the President and PM roles.
 * Uses adaptive thinking (always on for Opus 5.5) and server-side refusal
 * fallbacks, so a declined request is retried on a fallback model.
 */
export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic";
  private readonly create: AnthropicCreate;

  constructor(
    readonly model: string = DEFAULT_CLAUDE_MODEL,
    options: { create?: AnthropicCreate; effort?: "low" | "medium" | "high" | "xhigh" | "max" } = {},
  ) {
    this.effort = options.effort ?? "high";
    if (options.create) {
      this.create = options.create;
    } else {
      const client = new Anthropic();
      this.create = (params) =>
        client.beta.messages.create(params as never) as unknown as Promise<AnthropicLikeResponse>;
    }
  }

  private readonly effort: string;

  /** Builds the request body. Exposed for tests. */
  buildParams(request: ModelRequest): Record<string, unknown> {
    const tools = toAnthropicTools(request.tools);
    return {
      model: this.model,
      max_tokens: request.maxTokens ?? 16000,
      system: request.system,
      messages: toAnthropicMessages(request.messages),
      ...(tools.length > 0 ? { tools } : {}),
      thinking: { type: "adaptive" },
      output_config: { effort: this.effort },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    };
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    return fromAnthropicResponse(await this.create(this.buildParams(request)));
  }
}
