/**
 * Where the company finds jobs to bid on: a stub of made-up federal
 * construction solicitations (the default), or real listings read from
 * SAM.gov (read-only; see samgov.ts).
 */
export interface Opportunity {
  /** Unique notice id. Stub ids start with "STUB-"; SAM.gov ids are 32 hex characters. */
  noticeId: string;
  title: string;
  agency: string;
  /** Six-digit NAICS code. */
  naicsCode: string;
  type: "solicitation" | "combined_synopsis_solicitation" | "sources_sought" | "presolicitation";
  active: boolean;
  /** ISO 8601 date-time, or "" when the notice gives none. */
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
  /** Where the listing came from. Left out means the stub. */
  source?: "stub" | "samgov";
  /** The public page for the notice, for a real listing. */
  link?: string;
  /**
   * A real listing's description is a separate SAM.gov call, made only for the
   * job a run picks. Until then this holds its address and scopeSummary is the title.
   */
  descriptionUrl?: string;
}

/** Easy: one or two trades. Moderate: several trades, some coordination. Complex: many trades, phasing, special requirements. */
export const COMPLEXITIES = ["easy", "moderate", "complex"] as const;
export type Complexity = (typeof COMPLEXITIES)[number];

export interface OpportunitySource {
  readonly name: string;
  list(): Promise<Opportunity[]>;
  /** Fills in what list() leaves out for one listing, such as a real notice's description. */
  describe?(opportunity: Opportunity): Promise<Opportunity>;
}

/** Construction NAICS sectors: buildings, heavy/civil, specialty trades. */
export const CONSTRUCTION_NAICS_PREFIXES = ["236", "237", "238"] as const;
