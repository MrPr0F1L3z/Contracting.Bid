import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BACKGROUND_PROMPTS, runLoadTest, summarize } from "../src/gpu/loadTest.js";
import type { FetchLike } from "../src/gpu/vllmProbe.js";
import { SeededRng } from "../src/sim/rng.js";
import { startFakeVllm } from "./fakeVllm.js";

describe("summarize", () => {
  it("counts results and finds the worst time and slowest rate", () => {
    expect(
      summarize([
        { ok: true, seconds: 3, completionTokens: 30, tokensPerSec: 10 },
        { ok: true, seconds: 5, completionTokens: 30, tokensPerSec: 6 },
        { ok: false, seconds: 60, completionTokens: 0, tokensPerSec: 0, error: "timed out" },
      ]),
    ).toEqual({ ok: 2, failed: 1, maxSeconds: 60, minTokensPerSec: 6 });
  });

  it("handles all-failed and empty input", () => {
    expect(summarize([])).toEqual({ ok: 0, failed: 0, maxSeconds: 0, minTokensPerSec: 0 });
  });
});

describe("runLoadTest", () => {
  let fake: Awaited<ReturnType<typeof startFakeVllm>>;
  beforeEach(async () => { fake = await startFakeVllm({ delayMs: 20 }); });
  afterEach(async () => { await fake.close(); });

  it("runs background and foreground requests and reports them", async () => {
    const report = await runLoadTest({
      baseUrl: fake.baseUrl, model: "qwen", background: 3, foreground: 2, rng: new SeededRng(1),
      fetchImpl: fetch as unknown as FetchLike,
    });
    expect(report.background).toHaveLength(3);
    expect(report.foreground).toHaveLength(2);
    expect(report.summary.ok).toBe(2);
    expect(fake.state.chatCalls).toBe(5);
  });

  it("rejects invalid counts", async () => {
    await expect(runLoadTest({ baseUrl: "x", model: "q", background: -1, foreground: 1, rng: new SeededRng(1) })).rejects.toThrow();
    await expect(runLoadTest({ baseUrl: "x", model: "q", background: 0, foreground: 0, rng: new SeededRng(1) })).rejects.toThrow();
  });

  it("has background prompts to draw from", () => {
    expect(BACKGROUND_PROMPTS.length).toBeGreaterThan(3);
  });
});
