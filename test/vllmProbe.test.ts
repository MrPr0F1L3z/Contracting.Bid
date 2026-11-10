import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  decide,
  ensureVllm,
  parseLaneUsage,
  readLaneUsage,
  serverRoot,
  describeError,
  timeRequest,
  tokensPerSecond,
  waitForReady,
  type FetchLike,
  type ProbeResult,
} from "../src/gpu/vllmProbe.js";
import { startFakeVllm } from "./fakeVllm.js";

const good: ProbeResult = { ok: true, seconds: 2, completionTokens: 40, tokensPerSec: 20 };

describe("parseLaneUsage", () => {
  it("sums running and waiting gauges across models and skips comments", () => {
    const text = [
      "# HELP vllm:num_requests_running Number of requests running",
      'vllm:num_requests_running{model_name="a"} 2.0',
      'vllm:num_requests_running{model_name="b"} 1',
      'vllm:num_requests_waiting{model_name="a"} 3',
      "other_metric 9",
      "garbage line",
      'vllm:num_requests_running{model_name="c"} NaN',
    ].join("\n");
    expect(parseLaneUsage(text)).toEqual({ running: 3, waiting: 3 });
  });

  it("returns null without the running gauge, and defaults waiting to 0", () => {
    expect(parseLaneUsage("other 1")).toBeNull();
    expect(parseLaneUsage("vllm:num_requests_running 1")).toEqual({ running: 1, waiting: 0 });
  });
});

describe("tokensPerSecond", () => {
  it("divides and guards zero time", () => {
    expect(tokensPerSecond(100, 4)).toBe(25);
    expect(tokensPerSecond(100, 0)).toBe(0);
  });
});

describe("serverRoot", () => {
  it("drops a trailing /v1 and slashes", () => {
    expect(serverRoot("http://h:8000/v1")).toBe("http://h:8000");
    expect(serverRoot("http://h:8000/v1/")).toBe("http://h:8000");
    expect(serverRoot("http://h:8000")).toBe("http://h:8000");
  });
});

describe("decide", () => {
  const t = DEFAULT_THRESHOLDS;
  it("reuses a server with a free lane and a fast probe", () => {
    const v = decide({ running: 1, waiting: 0 }, good, t);
    expect(v.reuse).toBe(true);
    expect(v.reason).toContain("1/4 lanes busy");
  });

  it("reuses when lane usage is unknown but the probe is fast", () => {
    expect(decide(null, good, t)).toEqual({ reuse: true, reason: expect.stringContaining("lane usage unknown") });
  });

  it("restarts when every lane is busy", () => {
    expect(decide({ running: 4, waiting: 0 }, good, t)).toMatchObject({ reuse: false, reason: expect.stringContaining("all 4 lanes busy") });
  });

  it("restarts when requests are queued", () => {
    expect(decide({ running: 2, waiting: 1 }, good, t).reuse).toBe(false);
  });

  it("restarts when the probe is slow, low tokens/s, failed or missing", () => {
    expect(decide(null, { ...good, seconds: 61 }, t).reason).toMatch(/61\.0s/);
    expect(decide(null, { ...good, tokensPerSec: 2 }, t).reason).toMatch(/tokens\/s/);
    expect(decide(null, { ...good, ok: false, error: "HTTP 500" }, t).reason).toMatch(/HTTP 500/);
    expect(decide(null, { ...good, ok: false }, t).reason).toMatch(/unknown error/);
    expect(decide(null, null, t).reason).toMatch(/not responding/);
  });

  it("doesn't judge tokens/s when no tokens came back", () => {
    expect(decide(null, { ...good, completionTokens: 0, tokensPerSec: 0 }, t).reuse).toBe(true);
  });
});

describe("against a fake vLLM server", () => {
  let fake: Awaited<ReturnType<typeof startFakeVllm>>;
  beforeEach(async () => { fake = await startFakeVllm(); });
  afterEach(async () => { await fake.close(); });

  it("readLaneUsage reads /metrics, and returns null when it's missing or down", async () => {
    fake.state.running = 2;
    expect(await readLaneUsage(fetch as unknown as FetchLike, fake.baseUrl)).toEqual({ running: 2, waiting: 0 });
    fake.state.metrics = false;
    expect(await readLaneUsage(fetch as unknown as FetchLike, fake.baseUrl)).toBeNull();
    expect(await readLaneUsage(fetch as unknown as FetchLike, "http://127.0.0.1:1/v1")).toBeNull();
  });

  it("timeRequest measures time and tokens/s", async () => {
    const r = await timeRequest(fetch as unknown as FetchLike, fake.baseUrl, "qwen", "hi");
    expect(r.ok).toBe(true);
    expect(r.completionTokens).toBe(20);
    expect(r.tokensPerSec).toBeGreaterThan(0);
  });

  it("timeRequest reports HTTP errors and timeouts", async () => {
    fake.state.up = false;
    expect((await timeRequest(fetch as unknown as FetchLike, fake.baseUrl, "qwen", "hi")).error).toBe("HTTP 503");
    fake.state.up = true;
    fake.state.delayMs = 2000;
    const r = await timeRequest(fetch as unknown as FetchLike, fake.baseUrl, "qwen", "hi", { timeoutSec: 0.05 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timed out/);
  });

  it("timeRequest reports connection errors", async () => {
    const r = await timeRequest(fetch as unknown as FetchLike, "http://127.0.0.1:1/v1", "qwen", "hi");
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it("waitForReady returns true once /v1/models answers", async () => {
    expect(await waitForReady(fetch as unknown as FetchLike, fake.baseUrl, { timeoutSec: 1 })).toBe(true);
  });

  it("ensureVllm keeps a healthy server and runs no commands", async () => {
    const ran: string[] = [];
    const r = await ensureVllm({
      baseUrl: fake.baseUrl, model: "qwen", stopCommand: "vllm stop", startCommand: "vllm start big",
      fetchImpl: fetch as unknown as FetchLike, run: async (c) => { ran.push(c); },
    });
    expect(r.restarted).toBe(false);
    expect(ran).toEqual([]);
  });

  it("ensureVllm restarts a server whose lanes are full", async () => {
    fake.state.running = 4;
    const ran: string[] = [];
    const logs: string[] = [];
    const r = await ensureVllm({
      baseUrl: fake.baseUrl, model: "qwen", stopCommand: "vllm stop", startCommand: "vllm start big",
      fetchImpl: fetch as unknown as FetchLike,
      run: async (c) => { ran.push(c); if (c === "vllm start big") fake.state.running = 0; },
      log: (m) => logs.push(m),
    });
    expect(r.restarted).toBe(true);
    expect(ran).toEqual(["vllm stop", "vllm start big"]);
    expect(logs[0]).toMatch(/Restarting vLLM: all 4 lanes busy/);
  });
});

describe("waitForReady with a fake clock", () => {
  it("gives up after the deadline", async () => {
    let t = 0;
    const down: FetchLike = async () => { throw new Error("refused"); };
    const ok = await waitForReady(down, "http://x/v1", {
      timeoutSec: 10, intervalSec: 5, now: () => t, sleep: async (ms) => { t += ms; },
    });
    expect(ok).toBe(false);
  });

  it("keeps polling through non-OK answers", async () => {
    let calls = 0;
    const flaky: FetchLike = async () => ({ ok: ++calls >= 3, status: 200, json: async () => ({}), text: async () => "" });
    expect(await waitForReady(flaky, "http://x/v1", { sleep: async () => {} })).toBe(true);
    expect(calls).toBe(3);
  });
});

describe("ensureVllm failures", () => {
  const down: FetchLike = async () => { throw new Error("refused"); };

  it("continues past a failing stop command and starts fresh", async () => {
    const ran: string[] = [];
    let up = false;
    const fetchImpl: FetchLike = async (url) => {
      if (!up) throw new Error("refused");
      return { ok: url.endsWith("/models"), status: 200, json: async () => ({}), text: async () => "" };
    };
    const r = await ensureVllm({
      baseUrl: "http://x/v1", model: "q", stopCommand: "stop", startCommand: "start", fetchImpl,
      run: async (c) => { ran.push(c); if (c === "stop") throw new Error("not running"); up = true; },
      waitOptions: { sleep: async () => {} },
    });
    expect(r.restarted).toBe(true);
    expect(ran).toEqual(["stop", "start"]);
  });

  it("throws when the server never comes up", async () => {
    let t = 0;
    await expect(
      ensureVllm({
        baseUrl: "http://x/v1", model: "q", stopCommand: "stop", startCommand: "start", fetchImpl: down,
        run: async () => {}, readyTimeoutSec: 1,
        waitOptions: { now: () => t, sleep: async (ms) => { t += ms; } },
      }),
    ).rejects.toThrow(/did not come up/);
  });
});

describe("describeError", () => {
  it("adds the network cause code that fetch hides", () => {
    const err = new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    expect(describeError(err)).toBe("TypeError: fetch failed (ECONNREFUSED)");
  });
  it("falls back to the cause message, then the plain error", () => {
    expect(describeError(new Error("x", { cause: new Error("socket hang up") }))).toBe("Error: x (socket hang up)");
    expect(describeError(new Error("plain"))).toBe("Error: plain");
    expect(describeError(null)).toBe("null");
  });
});
