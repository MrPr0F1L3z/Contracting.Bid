import { describe, expect, it, vi } from "vitest";
import { withGpuPaused } from "../src/gpu/hooks.js";

const hooks = [
  { pause: "pause-a", resume: "resume-a" },
  { pause: "pause-b", resume: "resume-b" },
];

describe("withGpuPaused", () => {
  it("pauses in order, runs the task, resumes in reverse", async () => {
    const ran: string[] = [];
    const result = await withGpuPaused(hooks, async () => {
      ran.push("task");
      return 42;
    }, async (c) => { ran.push(c); });
    expect(result).toBe(42);
    expect(ran).toEqual(["pause-a", "pause-b", "task", "resume-b", "resume-a"]);
  });

  it("resumes even when the task fails", async () => {
    const ran: string[] = [];
    await expect(
      withGpuPaused(hooks, async () => { throw new Error("sim crashed"); }, async (c) => { ran.push(c); }),
    ).rejects.toThrow("sim crashed");
    expect(ran).toEqual(["pause-a", "pause-b", "resume-b", "resume-a"]);
  });

  it("resumes only what was paused when a pause fails", async () => {
    const ran: string[] = [];
    const task = vi.fn();
    await expect(
      withGpuPaused(hooks, task, async (c) => {
        if (c === "pause-b") throw new Error("no such container");
        ran.push(c);
      }),
    ).rejects.toThrow("no such container");
    expect(task).not.toHaveBeenCalled();
    expect(ran).toEqual(["pause-a", "resume-a"]);
  });

  it("keeps resuming when one resume fails, and reports it", async () => {
    const ran: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logs: string[] = [];
    await withGpuPaused(hooks, async () => "ok", async (c) => {
      if (c === "resume-b") throw new Error("fail");
      ran.push(c);
    }, (m) => logs.push(m));
    expect(ran).toEqual(["pause-a", "pause-b", "resume-a"]);
    expect(logs).toContain("Resume failed: resume-b");
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("just runs the task when no hooks are configured", async () => {
    expect(await withGpuPaused([], async () => "done")).toBe("done");
  });
});

describe("shellRunner", () => {
  it("runs a shell command and rejects on failure", async () => {
    const { shellRunner } = await import("../src/gpu/hooks.js");
    await expect(shellRunner("true")).resolves.toBeUndefined();
    await expect(shellRunner("exit 3")).rejects.toThrow();
  });
});
