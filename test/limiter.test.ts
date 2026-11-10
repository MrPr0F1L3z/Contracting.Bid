import { describe, expect, it } from "vitest";
import { LimitedProvider, Semaphore } from "../src/models/limiter.js";
import { textResponse } from "../src/models/stub.js";
import type { ModelProvider } from "../src/models/types.js";

const tick = () => new Promise((r) => setTimeout(r, 1));

describe("Semaphore", () => {
  it("rejects a size below 1 or not a whole number", () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(1.5)).toThrow();
  });

  it("never runs more than max tasks, and runs waiters in order", async () => {
    const sem = new Semaphore(2);
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const task = (i: number) => async () => {
      running++;
      peak = Math.max(peak, running);
      await tick();
      order.push(i);
      running--;
      return i;
    };
    const results = await Promise.all([1, 2, 3, 4, 5].map((i) => sem.run(task(i))));
    expect(results).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
    expect(order.slice(2)).toEqual([3, 4, 5]);
    expect(sem.inUse()).toBe(0);
    expect(sem.queued()).toBe(0);
  });

  it("frees the slot when a task throws", async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(sem.run(async () => "ok")).resolves.toBe("ok");
  });

  it("reports slots in use and queued callers", async () => {
    const sem = new Semaphore(1);
    let release!: () => void;
    const first = sem.run(() => new Promise<void>((r) => (release = r)));
    const second = sem.run(async () => undefined);
    await tick();
    expect(sem.inUse()).toBe(1);
    expect(sem.queued()).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(sem.inUse()).toBe(0);
  });
});

describe("LimitedProvider", () => {
  it("passes calls, name and model through, at most max at a time", async () => {
    let running = 0;
    let peak = 0;
    const inner: ModelProvider = {
      name: "vllm",
      model: "qwen",
      async complete() {
        running++;
        peak = Math.max(peak, running);
        await tick();
        running--;
        return textResponse("ok", "qwen");
      },
    };
    const p = new LimitedProvider(inner, new Semaphore(2));
    expect(p.name).toBe("vllm");
    expect(p.model).toBe("qwen");
    const out = await Promise.all(Array.from({ length: 5 }, () => p.complete({ system: "", messages: [] })));
    expect(out.every((r) => r.text === "ok")).toBe(true);
    expect(peak).toBe(2);
  });
});
