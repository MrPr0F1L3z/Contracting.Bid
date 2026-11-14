import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_PARALLEL, FINISHED_KEPT, OUTPUT_LINES, RunLauncher, launchArgv, maxParallelRuns, parseLaunch, type LaunchState } from "../src/dashboard/launcher.js";

const JOBS = ["STUB-E01", "STUB-E02"];
const jobs = JOBS.map((noticeId) => ({ noticeId, title: noticeId, complexity: "easy" }));
const clock = () => new Date("2026-11-14T12:00:00Z");

describe("parseLaunch", () => {
  it("accepts each command with its options", () => {
    expect(parseLaunch({ command: "hiring" }, JOBS)).toEqual({ command: "hiring" });
    expect(parseLaunch({ command: "closeout", job: "STUB-E02", seed: "7", forceAward: true, stub: true }, JOBS))
      .toEqual({ command: "closeout", job: "STUB-E02", seed: 7, forceAward: true, stub: true });
    expect(parseLaunch({ command: "bid", job: "", seed: "", forceAward: false, stub: false }, JOBS)).toEqual({ command: "bid" });
    expect(parseLaunch({ command: "job", seed: 4294967295 }, JOBS)).toEqual({ command: "job", seed: 4294967295 });
  });
  it("names what is wrong", () => {
    expect(parseLaunch(null, JOBS)).toBe("Body must be a JSON object");
    expect(parseLaunch([], JOBS)).toBe("Body must be a JSON object");
    expect(parseLaunch({ command: "bench" }, JOBS)).toBe("command must be one of hiring, bid, job, closeout");
    expect(parseLaunch({ command: "hiring", job: "STUB-E01" }, JOBS)).toBe("A hiring run has no job");
    expect(parseLaunch({ command: "bid", job: "REAL-1" }, JOBS)).toBe("Unknown job");
    for (const seed of [-1, 1.5, "x", 2 ** 32, true]) expect(parseLaunch({ command: "bid", seed }, JOBS)).toMatch(/^seed must be/);
    expect(parseLaunch({ command: "bid", forceAward: true }, JOBS)).toBe("Force award is only for job and closeout runs");
    expect(parseLaunch({ command: "job", forceAward: "yes" }, JOBS)).toBe("forceAward must be true or false");
    expect(parseLaunch({ command: "job", stub: 1 }, JOBS)).toBe("stub must be true or false");
  });
});

describe("launchArgv", () => {
  it("builds the pnpm sim arguments", () => {
    expect(launchArgv({ command: "hiring" })).toEqual(["hiring"]);
    expect(launchArgv({ command: "closeout", job: "STUB-E02", seed: 0, forceAward: true, stub: true }))
      .toEqual(["closeout", "--job", "STUB-E02", "--seed", "0", "--force-award", "--stub"]);
  });
});

describe("maxParallelRuns", () => {
  it("reads MAX_PARALLEL_RUNS, with a default", () => {
    expect(maxParallelRuns(undefined)).toBe(DEFAULT_MAX_PARALLEL);
    expect(maxParallelRuns(" ")).toBe(DEFAULT_MAX_PARALLEL);
    expect(maxParallelRuns("5")).toBe(5);
    for (const v of ["0", "21", "two", "1.5"]) expect(() => maxParallelRuns(v)).toThrow(/^MAX_PARALLEL_RUNS must be a whole number from 1 to 20/);
  });
});

describe("RunLauncher", () => {
  it("runs requests side by side up to the limit, and lists finished runs newest first", async () => {
    const finish: Array<(code: number) => void> = [];
    const seen: Array<[string[], string]> = [];
    const changes: LaunchState[] = [];
    const l = new RunLauncher((argv, out, by) => {
      seen.push([argv, by]);
      out(`Starting ${argv[0]}`);
      return new Promise((r) => finish.push(r));
    }, jobs, clock, 2);
    l.onChange = (s) => void changes.push(s);
    expect(l.state()).toEqual({ running: [], finished: [], maxParallel: 2 });
    expect(l.start({ command: "bid", job: "STUB-E01" }, "owner")).toBeNull();
    expect(l.start({ command: "hiring" }, "pat")).toBeNull();
    expect(l.full()).toBe(true);
    expect(l.state().running).toEqual([
      { launchId: 1, command: "bid", argv: ["bid", "--job", "STUB-E01"], startedBy: "owner", startedAt: "2026-11-14T12:00:00.000Z" },
      { launchId: 2, command: "hiring", argv: ["hiring"], startedBy: "pat", startedAt: "2026-11-14T12:00:00.000Z" },
    ]);
    expect(l.start({ command: "job" }, "owner")).toBe("2 run(s) are already going, the most at once (MAX_PARALLEL_RUNS). Wait for one to finish.");
    expect(seen).toEqual([[["bid", "--job", "STUB-E01"], "owner"], [["hiring"], "pat"]]);
    finish[1]!(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(l.state().running.map((r) => r.launchId)).toEqual([1]);
    expect(l.start({ command: "job" }, "owner")).toBeNull();
    finish[0]!(1);
    finish[2]!(0);
    await l.idle();
    const s = l.state();
    expect(s.running).toEqual([]);
    expect(s.finished.map((f) => [f.launchId, f.exitCode])).toEqual([[3, 0], [1, 1], [2, 0]]);
    expect(s.finished[2]).toMatchObject({ command: "hiring", startedBy: "pat", output: ["Starting hiring"], finishedAt: "2026-11-14T12:00:00.000Z" });
    expect(changes.map((c) => c.running.length)).toEqual([1, 2, 1, 2, 1, 0]);
  });

  it("refuses a bad request without starting anything", () => {
    const l = new RunLauncher(async () => 0, jobs, clock);
    expect(l.start({ command: "bid", job: "nope" }, "owner")).toBe("Unknown job");
    expect(l.state().running).toEqual([]);
  });

  it("records a run that throws, keeps only the last lines of output and the last finished runs", async () => {
    const l = new RunLauncher(async (_argv, out) => {
      for (let i = 0; i < OUTPUT_LINES + 5; i++) out(`line ${i}`);
      throw new Error("ANTHROPIC_API_KEY is not set");
    }, jobs, clock);
    l.start({ command: "hiring" }, "owner");
    await l.idle();
    const last = l.state().finished[0]!;
    expect(last.exitCode).toBe(1);
    expect(last.output).toHaveLength(OUTPUT_LINES);
    expect(last.output.at(-1)).toBe("ANTHROPIC_API_KEY is not set");
    for (let i = 0; i < FINISHED_KEPT + 2; i++) {
      l.start({ command: "hiring" }, "owner");
      await l.idle();
    }
    expect(l.state().finished).toHaveLength(FINISHED_KEPT);
    expect(l.state().finished[0]!.launchId).toBe(FINISHED_KEPT + 3);
  });

  it("hands out copies of its state", async () => {
    const l = new RunLauncher(async (_a, out) => (out("x"), 0), jobs, clock);
    l.start({ command: "hiring" }, "owner");
    await l.idle();
    l.state().finished[0]!.output.push("changed");
    expect(l.state().finished[0]!.output).toEqual(["x"]);
  });
});
