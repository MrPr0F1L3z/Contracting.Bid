/**
 * Read-only client for the SAM.gov Get Opportunities Public API (v2).
 * Docs: https://open.gsa.gov/api/get-opportunities-public-api/
 * Contracting.Bid only reads listings to seed simulations. It never submits
 * anything to SAM.gov.
 */
export const SAMGOV_SEARCH_URL = "https://api.sam.gov/opportunities/v2/search";

/** Construction NAICS sectors: buildings, heavy/civil, specialty trades. */
export const CONSTRUCTION_NAICS_PREFIXES = ["236", "237", "238"] as const;

export interface SearchParams {
  postedFrom: Date;
  postedTo: Date;
  /** NAICS code, up to 6 digits. */
  ncode?: string;
  /** Procurement types: o = solicitation, k = combined synopsis/solicitation. */
  ptype?: string;
  limit?: number;
  offset?: number;
}

export interface Opportunity {
  noticeId: string;
  title: string;
  solicitationNumber: string | null;
  naicsCode: string | null;
  type: string | null;
  postedDate: string | null;
  responseDeadline: string | null;
  active: boolean;
  setAside: string | null;
  placeOfPerformance: unknown;
  descriptionUrl: string | null;
  uiLink: string | null;
}

/** Formats a date as MM/dd/yyyy in UTC, as the API expects. */
export function formatSamDate(date: Date): string {
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${mm}/${dd}/${date.getUTCFullYear()}`;
}

/** Builds the search URL. The API allows at most one year between the dates. */
export function buildSearchUrl(params: SearchParams, apiKey: string): string {
  if (!apiKey) throw new Error("A SAM.gov API key is required");
  const days = (params.postedTo.getTime() - params.postedFrom.getTime()) / 86_400_000;
  if (days < 0) throw new Error("postedFrom must be on or before postedTo");
  if (days > 366) throw new Error("SAM.gov allows at most one year between postedFrom and postedTo");
  const limit = params.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("limit must be 1 to 1000");
  const url = new URL(SAMGOV_SEARCH_URL);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("postedFrom", formatSamDate(params.postedFrom));
  url.searchParams.set("postedTo", formatSamDate(params.postedTo));
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(params.offset ?? 0));
  if (params.ncode) url.searchParams.set("ncode", params.ncode);
  if (params.ptype) url.searchParams.set("ptype", params.ptype);
  return url.toString();
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Normalizes one raw opportunity record from the API. */
export function normalizeOpportunity(raw: Record<string, unknown>): Opportunity {
  const noticeId = str(raw.noticeId);
  if (!noticeId) throw new Error("Opportunity is missing noticeId");
  return {
    noticeId,
    title: str(raw.title) ?? "(untitled)",
    solicitationNumber: str(raw.solicitationNumber),
    naicsCode: str(raw.naicsCode),
    type: str(raw.type),
    postedDate: str(raw.postedDate),
    // The docs' field table misspells this; accept both spellings.
    responseDeadline: str(raw.responseDeadLine) ?? str(raw.reponseDeadLine),
    active: raw.active === "Yes",
    setAside: str(raw.typeOfSetAsideDescription) ?? str(raw.typeOfSetAside),
    placeOfPerformance: raw.placeOfPerformance ?? null,
    descriptionUrl: str(raw.description),
    uiLink: str(raw.uiLink),
  };
}

/** Parses a search response body. */
export function parseSearchResponse(body: unknown): { totalRecords: number; opportunities: Opportunity[] } {
  if (body === null || typeof body !== "object") throw new Error("SAM.gov returned an unexpected response");
  const b = body as { totalRecords?: unknown; opportunitiesData?: unknown };
  const data = Array.isArray(b.opportunitiesData) ? b.opportunitiesData : [];
  return {
    totalRecords: typeof b.totalRecords === "number" ? b.totalRecords : data.length,
    opportunities: data.map((r) => normalizeOpportunity(r as Record<string, unknown>)),
  };
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class SamGovClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = (url) => fetch(url),
  ) {}

  async search(params: SearchParams): Promise<{ totalRecords: number; opportunities: Opportunity[] }> {
    const res = await this.fetchImpl(buildSearchUrl(params, this.apiKey));
    if (!res.ok) throw new Error(`SAM.gov search failed with HTTP ${res.status}`);
    return parseSearchResponse(await res.json());
  }
}
