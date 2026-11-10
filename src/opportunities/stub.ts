import type { Opportunity, OpportunitySource } from "./types.js";

/**
 * Made-up solicitations for the sandboxed POC. These are not real listings
 * and don't name real projects. Two are deliberately not biddable (a sources
 * sought notice and a non-construction NAICS) so the filters are exercised.
 */
export const STUB_OPPORTUNITIES: readonly Opportunity[] = [
  {
    noticeId: "STUB-0001",
    title: "Renovate Building 12 administrative office suite",
    agency: "Example Federal Agency, Region 9",
    naicsCode: "236220",
    type: "solicitation",
    active: true,
    responseDeadline: "2026-12-15T17:00:00-08:00",
    setAside: "Total Small Business Set-Aside",
    placeOfPerformance: { city: "Sacramento", state: "CA" },
    scopeSummary:
      "Interior renovation of a 2,500 sq ft office suite: selective demolition, metal stud framing, drywall, electrical, paint, and carpet tile. Occupied building; work after hours.",
    estimatedValueUsd: { min: 250_000, max: 500_000 },
  },
  {
    noticeId: "STUB-0002",
    title: "Repave and restripe visitor parking lot",
    agency: "Example Federal Agency, Region 8",
    naicsCode: "237310",
    type: "combined_synopsis_solicitation",
    active: true,
    responseDeadline: "2026-12-01T14:00:00-07:00",
    setAside: null,
    placeOfPerformance: { city: "Denver", state: "CO" },
    scopeSummary:
      "Mill and overlay 40,000 sq ft of asphalt, replace damaged curb and gutter, restripe 120 stalls including ADA spaces.",
    estimatedValueUsd: { min: 100_000, max: 250_000 },
  },
  {
    noticeId: "STUB-0003",
    title: "Replace rooftop HVAC units at field office",
    agency: "Example Federal Agency, Region 4",
    naicsCode: "238220",
    type: "solicitation",
    active: true,
    responseDeadline: "2026-12-20T16:00:00-05:00",
    setAside: "Service-Disabled Veteran-Owned Small Business Set-Aside",
    placeOfPerformance: { city: "Atlanta", state: "GA" },
    scopeSummary:
      "Remove and replace three 10-ton rooftop units, new curbs and adapters, crane lift, controls tie-in, test and balance.",
    estimatedValueUsd: { min: 500_000, max: 1_000_000 },
  },
  {
    noticeId: "STUB-0004",
    title: "Roof replacement, warehouse B (market research)",
    agency: "Example Federal Agency, Region 5",
    naicsCode: "238160",
    type: "sources_sought",
    active: true,
    responseDeadline: "2026-11-30T12:00:00-06:00",
    setAside: null,
    placeOfPerformance: { city: "Chicago", state: "IL" },
    scopeSummary: "Sources sought only. No award will be made from this notice.",
    estimatedValueUsd: null,
  },
  {
    noticeId: "STUB-0005",
    title: "Janitorial supplies, annual",
    agency: "Example Federal Agency, Region 1",
    naicsCode: "424130",
    type: "solicitation",
    active: true,
    responseDeadline: "2026-12-05T17:00:00-05:00",
    setAside: null,
    placeOfPerformance: { city: "Boston", state: "MA" },
    scopeSummary: "Supply contract, not construction.",
    estimatedValueUsd: { min: 20_000, max: 50_000 },
  },
];

/** Serves the built-in made-up solicitations, or a custom list for tests. */
export class StubOpportunitySource implements OpportunitySource {
  readonly name = "stub";

  constructor(private readonly opportunities: readonly Opportunity[] = STUB_OPPORTUNITIES) {}

  async list(): Promise<Opportunity[]> {
    return structuredClone([...this.opportunities]);
  }
}
