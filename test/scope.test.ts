import { describe, expect, it } from "vitest";
import { STUB_OPPORTUNITIES } from "../src/opportunities/stub.js";
import type { Opportunity } from "../src/opportunities/types.js";
import { SeededRng } from "../src/sim/rng.js";
import { JOB_SCOPES } from "../src/world/market.js";
import { inferComplexity, inferTrades, simulatedScope } from "../src/world/scope.js";
import { JOB_DURATION_DAYS } from "../src/world/site.js";

const real = (o: Partial<Opportunity>): Opportunity => ({
  noticeId: "abc123",
  title: "Untitled",
  agency: "Agency",
  naicsCode: "236220",
  type: "solicitation",
  active: true,
  responseDeadline: "",
  setAside: null,
  placeOfPerformance: { city: "", state: "" },
  scopeSummary: "",
  estimatedValueUsd: null,
  complexity: null,
  source: "samgov",
  ...o,
});

const sum = (t: ReadonlyArray<readonly [string, number]>) => t.reduce((a, [, s]) => a + s, 0);

describe("inferTrades", () => {
  it("starts from the NAICS code, longest prefix first", () => {
    expect(inferTrades(real({ naicsCode: "238160" })).map(([t]) => t)).toEqual(["roofing", "demolition"]);
    expect(inferTrades(real({ naicsCode: "237310" })).map(([t]) => t)).toEqual(["asphalt_paving", "concrete", "sitework", "striping"]);
    expect(inferTrades(real({ naicsCode: "237990" })).map(([t]) => t)).toEqual(["sitework", "concrete"]);
  });

  it("adds trades the text names, with shares that add up to 1", () => {
    const t = inferTrades(real({ naicsCode: "238160", title: "Roof replacement and fire alarm upgrade" }));
    expect(t.map(([x]) => x)).toEqual(["roofing", "demolition", "fire_protection"]);
    expect(sum(t)).toBeCloseTo(1, 2);
  });

  it("uses only the named trades for a building job that names some", () => {
    const t = inferTrades(real({ naicsCode: "236220", title: "Repaint and recarpet office", scopeSummary: "Paint walls; new carpet." }));
    expect(t).toEqual([["painting", 0.5], ["flooring", 0.5]]);
    expect(inferTrades(real({ naicsCode: "236220", title: "Renovate Building 7" })).length).toBe(9);
  });

  it("does not read 'stripping' as striping", () => {
    expect(inferTrades(real({ naicsCode: "238330", title: "Floor stripping and waxing" })).map(([t]) => t)).toEqual(["flooring", "demolition"]);
  });
});

describe("inferComplexity", () => {
  it("counts trades, and treats new construction as complex", () => {
    expect(inferComplexity(real({ naicsCode: "238320", title: "Paint stairwells" }))).toBe("easy");
    expect(inferComplexity(real({ naicsCode: "238220", title: "Replace boiler" }))).toBe("moderate");
    expect(inferComplexity(real({ naicsCode: "236220", title: "Renovate Building 7" }))).toBe("complex");
    expect(inferComplexity(real({ naicsCode: "238320", title: "New construction of a paint shop" }))).toBe("complex");
  });
});

describe("simulatedScope", () => {
  it("uses the written-out scope for every stub job", () => {
    for (const o of STUB_OPPORTUNITIES.filter((x) => JOB_SCOPES[x.noticeId])) {
      const s = simulatedScope(o, new SeededRng(1));
      expect(s.trades).toEqual(JOB_SCOPES[o.noticeId]);
      expect(s.contractDays).toBe(JOB_DURATION_DAYS[o.noticeId]);
      expect(s.valueUsd).toEqual(o.estimatedValueUsd);
    }
  });

  it("draws a real listing's value and time from the seed, within its band", () => {
    const o = real({ naicsCode: "238320", title: "Paint stairwells", complexity: "easy" });
    const a = simulatedScope(o, new SeededRng(7));
    expect(simulatedScope(o, new SeededRng(7))).toEqual(a);
    expect(a.valueUsd.min).toBeGreaterThanOrEqual(40_000);
    expect(a.valueUsd.max).toBeLessThanOrEqual(375_000);
    expect(a.valueUsd.min).toBeLessThan(a.valueUsd.max);
    expect(a.contractDays).toBeGreaterThanOrEqual(10);
    expect(a.contractDays).toBeLessThanOrEqual(25);
    const seen = new Set(Array.from({ length: 20 }, (_, i) => simulatedScope(o, new SeededRng(i)).valueUsd.min));
    expect(seen.size).toBeGreaterThan(10);
  });

  it("keeps a stated estimate", () => {
    const o = real({ naicsCode: "238320", estimatedValueUsd: { min: 10_000, max: 20_000 } });
    expect(simulatedScope(o, new SeededRng(1)).valueUsd).toEqual({ min: 10_000, max: 20_000 });
  });
});
