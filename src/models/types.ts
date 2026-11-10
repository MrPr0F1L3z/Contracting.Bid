/**
 * Provider-neutral model types. Agents talk to this interface; each provider
 * (Claude, vLLM, stub) translates to and from its own API.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's input object. */
  inputSchema: Record<string, unknown>;
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolCallId: string; content: string; isError?: boolean };

export interface ChatMessage {
  role: "user" | "assistant";
  content: ContentPart[];
  /**
   * The provider's own content for an assistant turn. A provider that
   * recognises it sends it back unchanged (Claude needs its thinking blocks
   * returned as-is); other providers use `content`.
   */
  raw?: { provider: string; content: unknown };
}

/** Builds the assistant message to append after a response, keeping its raw content. */
export function assistantMessage(response: ModelResponse, provider: string): ChatMessage {
  const content: ContentPart[] = [];
  if (response.text) content.push({ type: "text", text: response.text });
  for (const call of response.toolCalls) {
    content.push({ type: "tool_call", id: call.id, name: call.name, input: call.input });
  }
  return response.raw === undefined ? { role: "assistant", content } : { role: "assistant", content, raw: { provider, content: response.raw } };
}

export interface ModelRequest {
  system: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
}

export type StopReason = "end" | "tool_call" | "max_tokens" | "refusal" | "other";

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelResponse {
  model: string;
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  usage: Usage;
  /** The provider's raw content, kept so it can be sent back unchanged. */
  raw?: unknown;
}

export interface ModelProvider {
  readonly name: string;
  readonly model: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

/** Parses a JSON object string, returning an empty object on bad input. */
export function parseToolInput(json: string | undefined | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const value: unknown = JSON.parse(json);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
