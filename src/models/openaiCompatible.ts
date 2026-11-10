import OpenAI from "openai";
import type {
  ChatMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  StopReason,
  ToolDefinition,
} from "./types.js";
import { parseToolInput } from "./types.js";

/** Chat message shape for OpenAI-compatible servers such as vLLM. */
export type OaiMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

/** Converts neutral messages to OpenAI-compatible chat messages. */
export function toOpenAiMessages(system: string, messages: ChatMessage[]): OaiMessage[] {
  const out: OaiMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
      const calls = m.content.flatMap((p) =>
        p.type === "tool_call"
          ? [{ id: p.id, type: "function" as const, function: { name: p.name, arguments: JSON.stringify(p.input) } }]
          : [],
      );
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // User turns: tool results become separate "tool" messages, text stays a user message.
    const text = m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
    for (const p of m.content) {
      if (p.type === "tool_result") {
        out.push({ role: "tool", tool_call_id: p.toolCallId, content: p.isError ? `ERROR: ${p.content}` : p.content });
      }
    }
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

/** Converts neutral tool definitions to OpenAI function tools. */
export function toOpenAiTools(tools: ToolDefinition[] = []) {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: { type: "object", ...t.inputSchema } },
  }));
}

export function mapOpenAiFinishReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "stop":
      return "end";
    case "tool_calls":
      return "tool_call";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "other";
  }
}

/** Shape of the chat completion fields this provider reads. */
export interface OaiLikeCompletion {
  model: string;
  choices: Array<{
    finish_reason: string | null;
    message: {
      content: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> | null;
    };
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number } | null;
}

export function fromOpenAiCompletion(completion: OaiLikeCompletion): ModelResponse {
  const choice = completion.choices[0];
  if (!choice) throw new Error("Model returned no choices");
  const toolCalls = (choice.message.tool_calls ?? []).map((c) => ({
    id: c.id,
    name: c.function.name,
    input: parseToolInput(c.function.arguments),
  }));
  return {
    model: completion.model,
    text: choice.message.content ?? "",
    toolCalls,
    // Some servers report "stop" even when they return tool calls.
    stopReason: toolCalls.length > 0 ? "tool_call" : mapOpenAiFinishReason(choice.finish_reason),
    usage: {
      inputTokens: completion.usage?.prompt_tokens ?? 0,
      outputTokens: completion.usage?.completion_tokens ?? 0,
    },
  };
}

export type OaiCreate = (params: Record<string, unknown>) => Promise<OaiLikeCompletion>;

/** Provider for the local models served by vLLM's OpenAI-compatible API. */
export class OpenAiCompatibleProvider implements ModelProvider {
  readonly name = "vllm";
  private readonly create: OaiCreate;

  constructor(
    readonly model: string,
    options: { baseURL?: string; apiKey?: string; create?: OaiCreate; temperature?: number } = {},
  ) {
    this.temperature = options.temperature ?? 0;
    if (options.create) {
      this.create = options.create;
    } else {
      const client = new OpenAI({ baseURL: options.baseURL, apiKey: options.apiKey ?? "not-needed" });
      this.create = (params) =>
        client.chat.completions.create(params as never) as unknown as Promise<OaiLikeCompletion>;
    }
  }

  private readonly temperature: number;

  buildParams(request: ModelRequest): Record<string, unknown> {
    const tools = toOpenAiTools(request.tools);
    return {
      model: this.model,
      max_tokens: request.maxTokens ?? 4096,
      temperature: this.temperature,
      messages: toOpenAiMessages(request.system, request.messages),
      ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
    };
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    return fromOpenAiCompletion(await this.create(this.buildParams(request)));
  }
}
