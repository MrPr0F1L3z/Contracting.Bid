import { describe, expect, it } from "vitest";
import { PROBLEM_CATALOG, drawProblems } from "../src/sim/problems.js";
import { SeededRng } from "../src/sim/rng.js";

describe("drawProblems", () => {
  it("draws 3 to 5 distinct problems by default", () => {
    for (let seed = 0; seed < 50; seed++) {
      const drawn = drawProblems(new SeededRng(seed));
      expect(drawn.length).toBeGreaterThanOrEqual(3);
      expect(drawn.length).toBeLessThanOrEqual(5);
      expect(new Set(drawn.map((d) => d.problem.id)).size).toBe(drawn.length);
      for (const d of drawn) {
        expect(d.phaseProgress).toBeGreaterThanOrEqual(0);
        expect(d.phaseProgress).toBeLessThanOrEqual(1);
      }
    }
  });

  it("is the same for the same seed and varies across seeds", () => {
    expect(drawProblems(new SeededRng(1))).toEqual(drawProblems(new SeededRng(1)));
    const sets = new Set(
      Array.from({ length: 20 }, (_, s) => drawProblems(new SeededRng(s)).map((d) => d.problem.id).join(",")),
    );
    expect(sets.size).toBeGreaterThan(1);
  });

  it("rejects invalid ranges", () => {
    expect(() => drawProblems(new SeededRng(1), 4, 2)).toThrow();
    expect(() => drawProblems(new SeededRng(1), 1, PROBLEM_CATALOG.length + 1)).toThrow();
  });

  it("catalog ids are unique", () => {
    expect(new Set(PROBLEM_CATALOG.map((p) => p.id)).size).toBe(PROBLEM_CATALOG.length);
  });
});
