import { describe, expect, it } from "vitest";
import { isBiddableConstruction, pickOpportunity, planComplexityCoverage } from "../src/opportunities/pick.js";
import { STUB_OPPORTUNITIES, StubOpportunitySource } from "../src/opportunities/stub.js";
import { COMPLEXITIES } from "../src/opportunities/types.js";
import { SeededRng } from "../src/sim/rng.js";

describe("StubOpportunitySource", () => {
  it("serves the built-in made-up solicitations", async () => {
    const list = await new StubOpportunitySource().list();
    expect(list).toHaveLength(STUB_OPPORTUNITIES.length);
    expect(list.every((o) => o.noticeId.startsWith("STUB-"))).toBe(true);
  });

  it("returns copies, so callers can't change the source", async () => {
    const source = new StubOpportunitySource();
    const first = await source.list();
    first[0]!.title = "changed";
    expect((await source.list())[0]!.title).not.toBe("changed");
  });

  it("accepts a custom list", async () => {
    const one = STUB_OPPORTUNITIES.slice(0, 1);
    expect(await new StubOpportunitySource(one).list()).toEqual(one);
  });

  it("has two biddable jobs at every complexity level", () => {
    for (const level of COMPLEXITIES) {
      const jobs = STUB_OPPORTUNITIES.filter((o) => isBiddableConstruction(o) && o.complexity === level);
      expect(jobs).toHaveLength(2);
    }
  });

  it("spans small to large estimated values", () => {
    const tops = STUB_OPPORTUNITIES.flatMap((o) => (o.estimatedValueUsd ? [o.estimatedValueUsd.max] : []));
    expect(Math.min(...tops)).toBeLessThan(250_000);
    expect(Math.max(...tops)).toBeGreaterThan(5_000_000);
  });
});

describe("isBiddableConstruction", () => {
  it("keeps active construction solicitations only", () => {
    expect(STUB_OPPORTUNITIES.filter(isBiddableConstruction).map((o) => o.noticeId)).toEqual([
      "STUB-E01", "STUB-E02", "STUB-M01", "STUB-M02", "STUB-C01", "STUB-C02",
    ]);
  });

  it("rejects inactive notices", () => {
    expect(isBiddableConstruction({ ...STUB_OPPORTUNITIES[0]!, active: false })).toBe(false);
  });
});

describe("pickOpportunity", () => {
  const opps = [...STUB_OPPORTUNITIES];

  it("picks the same job for the same seed, regardless of input order", () => {
    const a = pickOpportunity(opps, new SeededRng(7));
    const b = pickOpportunity([...opps].reverse(), new SeededRng(7));
    expect(a.noticeId).toBe(b.noticeId);
    expect(isBiddableConstruction(a)).toBe(true);
  });

  it("varies across seeds and never caps on value", () => {
    const ids = new Set(Array.from({ length: 60 }, (_, s) => pickOpportunity(opps, new SeededRng(s)).noticeId));
    expect(ids.size).toBe(6);
  });

  it("can pick at a given complexity", () => {
    for (let s = 0; s < 20; s++) {
      expect(pickOpportunity(opps, new SeededRng(s), { complexity: "complex" }).complexity).toBe("complex");
    }
  });

  it("throws when nothing qualifies", () => {
    expect(() => pickOpportunity(opps.slice(6), new SeededRng(1))).toThrow(/No active/);
    expect(() => pickOpportunity(opps.slice(0, 2), new SeededRng(1), { complexity: "complex" })).toThrow(/complex/);
  });
});

describe("planComplexityCoverage", () => {
  it("covers every level once per block of three runs", () => {
    const plan = planComplexityCoverage(9, new SeededRng(3));
    expect(plan).toHaveLength(9);
    for (let i = 0; i < 9; i += 3) {
      expect([...plan.slice(i, i + 3)].sort()).toEqual(["complex", "easy", "moderate"]);
    }
  });

  it("is deterministic by seed and handles partial blocks and zero", () => {
    expect(planComplexityCoverage(5, new SeededRng(1))).toEqual(planComplexityCoverage(5, new SeededRng(1)));
    expect(new Set(planComplexityCoverage(3, new SeededRng(1))).size).toBe(3);
    expect(planComplexityCoverage(0, new SeededRng(1))).toEqual([]);
  });

  it("rejects invalid counts", () => {
    expect(() => planComplexityCoverage(-1, new SeededRng(1))).toThrow();
    expect(() => planComplexityCoverage(1.5, new SeededRng(1))).toThrow();
  });
});
