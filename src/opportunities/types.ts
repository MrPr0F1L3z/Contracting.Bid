/**
 * Where the company finds jobs to bid on. For the POC the source is a stub
 * of made-up federal construction solicitations. A real SAM.gov source
 * (read-only) will implement the same interface in a later sprint.
 */
export interface Opportunity {
  /** Unique notice id. Stub ids start with "STUB-". */
  noticeId: string;
  title: string;
  agency: string;
  /** Six-digit NAICS code. */
  naicsCode: string;
  type: "solicitation" | "combined_synopsis_solicitation" | "sources_sought" | "presolicitation";
  active: boolean;
  /** ISO 8601 date-time. */
  responseDeadline: string;
  setAside: string | null;
  placeOfPerformance: { city: string; state: string };
  /** Plain-language scope the Estimator works from. */
  scopeSummary: string;
  /** The government's estimated value range, when the notice gives one. */
  estimatedValueUsd: { min: number; max: number } | null;
  /**
   * How hard the job is to run. Stub-only for now; a real source would
   * have to infer it from trades, phasing and site constraints.
   */
  complexity: Complexity | null;
}

/** Easy: one or two trades. Moderate: several trades, some coordination. Complex: many trades, phasing, special requirements. */
export const COMPLEXITIES = ["easy", "moderate", "complex"] as const;
export type Complexity = (typeof COMPLEXITIES)[number];

export interface OpportunitySource {
  readonly name: string;
  list(): Promise<Opportunity[]>;
}

/** Construction NAICS sectors: buildings, heavy/civil, specialty trades. */
export const CONSTRUCTION_NAICS_PREFIXES = ["236", "237", "238"] as const;
