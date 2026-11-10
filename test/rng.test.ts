import { describe, expect, it } from "vitest";
import { SeededRng, hashString, newSeed } from "../src/sim/rng.js";

describe("SeededRng", () => {
  it("produces the same sequence for the same seed", () => {
    const a = new SeededRng(42);
    const b = new SeededRng(42);
    expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()]);
  });

  it("produces different sequences for different seeds", () => {
    expect(new SeededRng(1).next()).not.toEqual(new SeededRng(2).next());
  });

  it("next() stays in [0, 1)", () => {
    const rng = new SeededRng(7);
    for (let i = 0; i < 1000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("rejects non-integer seeds", () => {
    expect(() => new SeededRng(1.5)).toThrow(/integer/);
  });

  it("int() stays within inclusive bounds and hits both ends", () => {
    const rng = new SeededRng(3);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) seen.add(rng.int(1, 3));
    expect([...seen].sort()).toEqual([1, 2, 3]);
  });

  it("int() rejects bad ranges", () => {
    const rng = new SeededRng(3);
    expect(() => rng.int(5, 1)).toThrow();
    expect(() => rng.int(0.5, 2)).toThrow();
  });

  it("pick() returns an element and rejects empty lists", () => {
    const rng = new SeededRng(9);
    expect(["a", "b", "c"]).toContain(rng.pick(["a", "b", "c"]));
    expect(() => rng.pick([])).toThrow(/empty/);
  });

  it("sample() returns distinct elements and validates count", () => {
    const rng = new SeededRng(11);
    const out = rng.sample([1, 2, 3, 4, 5], 3);
    expect(out).toHaveLength(3);
    expect(new Set(out).size).toBe(3);
    expect(() => rng.sample([1], 2)).toThrow();
    expect(() => rng.sample([1], -1)).toThrow();
  });

  it("fork() is deterministic and independent of the parent's draws", () => {
    const a = new SeededRng(5);
    const b = new SeededRng(5);
    b.next();
    b.next();
    expect(a.fork("x").next()).toEqual(b.fork("x").next());
    expect(a.fork("x").next()).not.toEqual(a.fork("y").next());
  });
});

describe("hashString", () => {
  it("is stable and unsigned", () => {
    expect(hashString("abc")).toBe(hashString("abc"));
    expect(hashString("abc")).not.toBe(hashString("abd"));
    expect(hashString("")).toBeGreaterThanOrEqual(0);
  });
});

describe("newSeed", () => {
  it("scales the random source to a 32-bit integer", () => {
    expect(newSeed(() => 0)).toBe(0);
    expect(Number.isInteger(newSeed(() => 0.5))).toBe(true);
    expect(newSeed()).toBeGreaterThanOrEqual(0);
  });
});
