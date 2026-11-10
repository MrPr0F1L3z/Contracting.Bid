import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeVllmState {
  running: number;
  waiting: number;
  /** Milliseconds each chat completion takes. */
  delayMs: number;
  completionTokens: number;
  up: boolean;
  metrics: boolean;
  chatCalls: number;
}

/** A tiny HTTP server that answers like vLLM, for functional tests. */
export async function startFakeVllm(initial: Partial<FakeVllmState> = {}): Promise<{
  baseUrl: string;
  state: FakeVllmState;
  close(): Promise<void>;
}> {
  const state: FakeVllmState = {
    running: 0, waiting: 0, delayMs: 5, completionTokens: 20, up: true, metrics: true, chatCalls: 0, ...initial,
  };
  const server: Server = createServer((req, res) => {
    if (!state.up) {
      res.writeHead(503).end();
      return;
    }
    if (req.url === "/metrics" && state.metrics) {
      res.writeHead(200, { "content-type": "text/plain" }).end(
        `# HELP vllm:num_requests_running Running\nvllm:num_requests_running{model_name="qwen"} ${state.running}\nvllm:num_requests_waiting{model_name="qwen"} ${state.waiting}\n`,
      );
      return;
    }
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"data":[{"id":"qwen"}]}');
      return;
    }
    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      state.chatCalls++;
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const model = (JSON.parse(raw || "{}") as { model?: string }).model;
        if (model && model !== "qwen") {
          res.writeHead(404, { "content-type": "application/json" }).end(
            JSON.stringify({ error: { message: `The model \`${model}\` does not exist.`, code: 404 } }),
          );
          return;
        }
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ model: "qwen", choices: [{ finish_reason: "stop", message: { content: "ready" } }], usage: { prompt_tokens: 5, completion_tokens: state.completionTokens } }),
        );
      }, state.delayMs);
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    state,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
