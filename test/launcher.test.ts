import { describe, expect, it } from "vitest";
import { OUTPUT_LINES, RunLauncher, launchArgv, parseLaunch, type LaunchState } from "../src/dashboard/launcher.js";

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

describe("RunLauncher", () => {
  it("runs one request at a time and keeps the last result", async () => {
    let finish!: (code: number) => void;
    const seen: string[][] = [];
    const changes: LaunchState[] = [];
    const l = new RunLauncher((argv, out) => {
      seen.push(argv);
      out("Starting");
      return new Promise((r) => (finish = r));
    }, jobs, clock);
    l.onChange = (s) => void changes.push(s);
    expect(l.state()).toEqual({ running: null, last: null });
    expect(l.start({ command: "bid", job: "STUB-E01" }, "owner")).toBeNull();
    expect(l.state().running).toEqual({ command: "bid", argv: ["bid", "--job", "STUB-E01"], startedBy: "owner", startedAt: "2026-11-14T12:00:00.000Z" });
    expect(l.start({ command: "hiring" }, "owner")).toBe("A bid run is already going. Wait for it to finish.");
    expect(seen).toHaveLength(1);
    finish(0);
    await l.idle();
    expect(l.state()).toEqual({
      running: null,
      last: { command: "bid", argv: ["bid", "--job", "STUB-E01"], startedBy: "owner", startedAt: "2026-11-14T12:00:00.000Z", exitCode: 0, finishedAt: "2026-11-14T12:00:00.000Z", output: ["Starting"] },
    });
    expect(changes.map((s) => [s.running?.command ?? null, s.last?.exitCode ?? null])).toEqual([["bid", null], [null, 0]]);
  });

  it("refuses a bad request without starting anything", () => {
    const l = new RunLauncher(async () => 0, jobs, clock);
    expect(l.start({ command: "bid", job: "nope" }, "owner")).toBe("Unknown job");
    expect(l.state().running).toBeNull();
  });

  it("records a run that throws, and keeps only the last lines of output", async () => {
    const l = new RunLauncher(async (_argv, out) => {
      for (let i = 0; i < OUTPUT_LINES + 5; i++) out(`line ${i}`);
      throw new Error("ANTHROPIC_API_KEY is not set");
    }, jobs, clock);
    l.start({ command: "hiring" }, "owner");
    await l.idle();
    const last = l.state().last!;
    expect(last.exitCode).toBe(1);
    expect(last.output).toHaveLength(OUTPUT_LINES);
    expect(last.output.at(-1)).toBe("ANTHROPIC_API_KEY is not set");
    expect(l.start({ command: "hiring" }, "owner")).toBeNull();
  });

  it("hands out copies of its state", async () => {
    const l = new RunLauncher(async (_a, out) => (out("x"), 0), jobs, clock);
    l.start({ command: "hiring" }, "owner");
    await l.idle();
    l.state().last!.output.push("changed");
    expect(l.state().last!.output).toEqual(["x"]);
  });
});
