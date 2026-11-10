import { describe, expect, it } from "vitest";
import { Budget, costOf } from "../src/budget/budget.js";

describe("costOf", () => {
  it("prices Claude Opus 5.5 at $4 in / $20 out per million tokens", () => {
    expect(costOf("claude-opus-5-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(24);
  });

  it("treats unknown local models as free", () => {
    expect(costOf("Qwen/Qwen2.5-32B-Instruct-AWQ", { inputTokens: 5000, outputTokens: 5000 })).toBe(0);
  });
});

describe("Budget", () => {
  it("validates its limits", () => {
    expect(() => new Budget(0)).toThrow();
    expect(() => new Budget(5, 1)).toThrow();
  });

  it("moves from ok to warning at 80% and exceeded at 100%", () => {
    const b = new Budget(5);
    expect(b.charge(3)).toBe("ok");
    expect(b.charge(1)).toBe("warning");
    expect(b.canSpend()).toBe(true);
    expect(b.charge(1)).toBe("exceeded");
    expect(b.canSpend()).toBe(false);
    expect(b.spentUsd()).toBe(5);
    expect(b.remainingUsd()).toBe(0);
  });

  it("rejects negative charges", () => {
    expect(() => new Budget(5).charge(-1)).toThrow();
  });
});
