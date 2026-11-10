import type { Opportunity, OpportunitySource } from "./types.js";

/**
 * Made-up solicitations for the sandboxed POC. These are not real listings
 * and don't name real projects. There are two biddable jobs at each
 * complexity level, plus two that aren't biddable (a sources sought notice
 * and a non-construction NAICS) so the filters are exercised.
 */
export const STUB_OPPORTUNITIES: readonly Opportunity[] = [
  // Easy: one or two trades, short duration.
  {
    noticeId: "STUB-E01",
    title: "Repave and restripe visitor parking lot",
    agency: "Example Federal Agency, Region 8",
    naicsCode: "237310",
    type: "combined_synopsis_solicitation",
    active: true,
    responseDeadline: "2026-12-01T14:00:00-07:00",
    setAside: null,
    placeOfPerformance: { city: "Denver", state: "CO" },
    scopeSummary:
      "Mill and overlay 40,000 sq ft of asphalt, replace 200 linear ft of damaged curb, restripe 120 stalls including ADA spaces. About 2 weeks.",
    estimatedValueUsd: { min: 100_000, max: 250_000 },
    complexity: "easy",
  },
  {
    noticeId: "STUB-E02",
    title: "Interior paint and flooring refresh, visitor center",
    agency: "Example Federal Agency, Region 6",
    naicsCode: "238320",
    type: "solicitation",
    active: true,
    responseDeadline: "2026-12-08T17:00:00-06:00",
    setAside: "Total Small Business Set-Aside",
    placeOfPerformance: { city: "Austin", state: "TX" },
    scopeSummary:
      "Repaint 6,000 sq ft of walls and ceilings and replace 3,000 sq ft of carpet tile with LVT. Building stays open; work in two zones. About 3 weeks.",
    estimatedValueUsd: { min: 60_000, max: 150_000 },
    complexity: "easy",
  },
  // Moderate: several trades and some coordination.
  {
    noticeId: "STUB-M01",
    title: "Renovate Building 12 administrative office suite",
    agency: "Example Federal Agency, Region 9",
    naicsCode: "236220",
    type: "solicitation",
    active: true,
    responseDeadline: "2026-12-15T17:00:00-08:00",
    setAside: "Total Small Business Set-Aside",
    placeOfPerformance: { city: "Sacramento", state: "CA" },
    scopeSummary:
      "Interior renovation of a 2,500 sq ft office suite: selective demolition, metal stud framing, drywall, electrical, paint, and carpet tile. Occupied building; work after hours. About 6 weeks.",
    estimatedValueUsd: { min: 250_000, max: 500_000 },
    complexity: "moderate",
  },
  {
    noticeId: "STUB-M02",
    title: "Replace rooftop HVAC units at field office",
    agency: "Example Federal Agency, Region 4",
    naicsCode: "238220",
    type: "solicitation",
    active: true,
    responseDeadline: "2026-12-20T16:00:00-05:00",
    setAside: "Service-Disabled Veteran-Owned Small Business Set-Aside",
    placeOfPerformance: { city: "Atlanta", state: "GA" },
    scopeSummary:
      "Remove and replace three 10-ton rooftop units with new curbs and adapters, crane lift on a weekend, roofing repairs, controls tie-in, test and balance. Long-lead equipment. About 8 weeks.",
    estimatedValueUsd: { min: 500_000, max: 1_000_000 },
    complexity: "moderate",
  },
  // Complex: many trades, phasing, special requirements.
  {
    noticeId: "STUB-C01",
    title: "Construct 12,000 sq ft maintenance facility",
    agency: "Example Federal Agency, Region 10",
    naicsCode: "236220",
    type: "solicitation",
    active: true,
    responseDeadline: "2027-01-15T14:00:00-08:00",
    setAside: null,
    placeOfPerformance: { city: "Boise", state: "ID" },
    scopeSummary:
      "New pre-engineered metal building on a slab, with sitework, utilities, fire sprinklers, HVAC, electrical service, and a two-bay vehicle wash. Bid and performance bonds; Davis-Bacon wages. About 9 months.",
    estimatedValueUsd: { min: 4_000_000, max: 7_000_000 },
    complexity: "complex",
  },
  {
    noticeId: "STUB-C02",
    title: "Phased renovation of occupied clinic wing",
    agency: "Example Federal Agency, Region 2",
    naicsCode: "236220",
    type: "solicitation",
    active: true,
    responseDeadline: "2027-01-08T15:00:00-05:00",
    setAside: "8(a) Set-Aside",
    placeOfPerformance: { city: "Albany", state: "NY" },
    scopeSummary:
      "Renovate a 9,000 sq ft clinic wing in four phases while it stays open: asbestos abatement, infection-control barriers, new medical gas, plumbing, HVAC, electrical, and finishes. Strict noise windows. About 7 months.",
    estimatedValueUsd: { min: 2_500_000, max: 5_000_000 },
    complexity: "complex",
  },
  // Not biddable: exercises the filters.
  {
    noticeId: "STUB-X01",
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
    complexity: null,
  },
  {
    noticeId: "STUB-X02",
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
    complexity: null,
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
