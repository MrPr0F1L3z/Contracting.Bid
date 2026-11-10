import { describe, expect, it } from "vitest";
import { fitsSizeCap, isBiddableConstruction, pickOpportunity } from "../src/opportunities/pick.js";
import { STUB_OPPORTUNITIES, StubOpportunitySource } from "../src/opportunities/stub.js";
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
});

describe("isBiddableConstruction", () => {
  it("keeps active construction solicitations only", () => {
    expect(STUB_OPPORTUNITIES.filter(isBiddableConstruction).map((o) => o.noticeId)).toEqual([
      "STUB-0001",
      "STUB-0002",
      "STUB-0003",
    ]);
  });

  it("rejects inactive notices", () => {
    expect(isBiddableConstruction({ ...STUB_OPPORTUNITIES[0]!, active: false })).toBe(false);
  });
});

describe("fitsSizeCap", () => {
  const opp = STUB_OPPORTUNITIES[0]!; // up to $500k
  it("passes with no cap or no estimate", () => {
    expect(fitsSizeCap(opp)).toBe(true);
    expect(fitsSizeCap({ ...opp, estimatedValueUsd: null }, 1)).toBe(true);
  });

  it("compares the top of the estimate to the cap", () => {
    expect(fitsSizeCap(opp, 500_000)).toBe(true);
    expect(fitsSizeCap(opp, 499_999)).toBe(false);
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

  it("varies across seeds", () => {
    const ids = new Set(Array.from({ length: 30 }, (_, s) => pickOpportunity(opps, new SeededRng(s)).noticeId));
    expect(ids.size).toBeGreaterThan(1);
  });

  it("honors the size cap", () => {
    for (let s = 0; s < 20; s++) {
      expect(pickOpportunity(opps, new SeededRng(s), { maxValueUsd: 250_000 }).noticeId).toBe("STUB-0002");
    }
  });

  it("throws when nothing qualifies", () => {
    expect(() => pickOpportunity(opps.slice(3), new SeededRng(1))).toThrow(/No active/);
    expect(() => pickOpportunity(opps, new SeededRng(1), { maxValueUsd: 1 })).toThrow(/No active/);
  });
});
