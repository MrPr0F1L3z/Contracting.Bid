import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { USAGE, main } from "../src/cli/vllm.js";
import { startFakeVllm } from "./fakeVllm.js";

// Functional tests: the CLI against a fake vLLM over real HTTP.
describe("pnpm vllm", () => {
  let fake: Awaited<ReturnType<typeof startFakeVllm>>;
  let lines: string[];
  let env: Record<string, string>;
  beforeEach(async () => {
    fake = await startFakeVllm();
    lines = [];
    env = { VLLM_BASE_URL: fake.baseUrl, VLLM_MODEL: "qwen", VLLM_STOP_CMD: "stop-it", VLLM_START_CMD: "start-it" };
  });
  afterEach(async () => { await fake.close(); });
  const out = (l: string) => lines.push(l);

  it("check reports lanes, probe and verdict without changing anything", async () => {
    fake.state.running = 1;
    expect(await main(["check"], { env, out })).toBe(0);
    expect(lines[0]).toBe("Lanes: 1 running, 0 waiting, of 4");
    expect(lines[2]).toMatch(/^Verdict: reuse/);
  });

  it("check says when metrics are missing and the probe fails", async () => {
    fake.state.metrics = false;
    fake.state.up = false;
    expect(await main(["check"], { env, out })).toBe(0);
    expect(lines[0]).toMatch(/unknown/);
    expect(lines[1]).toMatch(/failed/);
    expect(lines[2]).toMatch(/restart/);
  });

  it("ensure restarts with the configured commands when lanes are full", async () => {
    fake.state.running = 4;
    const ran: string[] = [];
    expect(await main(["ensure"], { env, out, run: async (c) => { ran.push(c); fake.state.running = 0; } })).toBe(0);
    expect(ran).toEqual(["stop-it", "start-it"]);
    expect(lines.at(-1)).toBe("Restarted vLLM fresh.");
  });

  it("ensure keeps a healthy server", async () => {
    expect(await main(["ensure"], { env, out, run: async () => { throw new Error("should not run"); } })).toBe(0);
    expect(lines.at(-1)).toBe("Kept the running vLLM.");
  });

  it("loadtest passes against a fast server", async () => {
    expect(await main(["loadtest", "2", "2"], { env, out })).toBe(0);
    expect(lines.at(-1)).toMatch(/^PASS/);
  });

  it("loadtest fails when tokens/s is too low", async () => {
    fake.state.completionTokens = 1;
    fake.state.delayMs = 300;
    expect(await main(["loadtest", "1", "1"], { env, out })).toBe(1);
    expect(lines.at(-1)).toMatch(/^FAIL/);
  });

  it("loadtest uses default counts", async () => {
    expect(await main(["loadtest"], { env, out })).toBe(0);
    expect(lines[0]).toMatch(/3 background, 3 foreground/);
  });

  it("prints usage for help or unknown commands", async () => {
    expect(await main([], { env, out })).toBe(0);
    expect(await main(["help"], { env, out })).toBe(0);
    expect(await main(["bogus"], { env, out })).toBe(2);
    expect(lines[0]).toBe(USAGE);
  });
});
