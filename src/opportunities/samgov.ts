/**
 * Read-only source of real listings from the SAM.gov Get Opportunities Public
 * API (v2): https://open.gsa.gov/api/get-opportunities-public-api/
 *
 * Contracting.Bid only reads listings, to bid on them in the simulation. It
 * never submits anything to SAM.gov. The API allows only a few requests a day
 * per key, so listings are cached (see cache.ts) and a notice's description,
 * which is a separate request, is fetched only for the job a run picks.
 */
import { inferComplexity } from "../world/scope.js";
import { CONSTRUCTION_NAICS_PREFIXES, type Opportunity, type OpportunitySource } from "./types.js";

export const SAMGOV_SEARCH_URL = "https://api.sam.gov/opportunities/v2/search";
/** Procurement types worth bidding: o = solicitation, k = combined synopsis/solicitation. */
export const SAMGOV_PTYPES = ["o", "k"] as const;
/** The most records the API returns per request. */
export const SAMGOV_PAGE_SIZE = 1000;
/** Longest scope text kept from a description. */
export const SCOPE_CHARS = 2000;

export interface SamGovSettings {
  apiKey: string;
  /** Listings posted this many days back, up to today. */
  lookbackDays: number;
  /** Two-letter place-of-performance state, or none for every state. */
  state?: string;
  /** NAICS codes to ask for, each its own request; none asks for everything and keeps construction (236, 237, 238). */
  naics: string[];
  /** Pages of up to 1000 listings per request. */
  maxPages: number;
}

/** The response's fields we read, with a body we can show in errors. */
export interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}
export type SamFetch = (url: string) => Promise<FetchResponse>;

const int = (name: string, value: string | undefined, fallback: number, min: number, max: number): number => {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}, not "${value}"`);
  return n;
};

/** Reads the SAM.gov settings from the environment. Throws, naming the setting, on a bad or missing one. */
export function samGovSettings(env: Record<string, string | undefined>): SamGovSettings {
  const apiKey = env.SAM_GOV_API_KEY?.trim() ?? "";
  if (!apiKey) throw new Error("JOB_SOURCE=samgov needs SAM_GOV_API_KEY: your public API key from the Account Details page on SAM.gov (see .env.example)");
  const state = env.SAMGOV_STATE?.trim().toUpperCase() ?? "";
  if (state && !/^[A-Z]{2}$/.test(state)) throw new Error(`SAMGOV_STATE must be a two-letter state code, not "${env.SAMGOV_STATE}"`);
  const naics = (env.SAMGOV_NAICS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const bad = naics.find((n) => !/^\d{2,6}$/.test(n));
  if (bad !== undefined) throw new Error(`SAMGOV_NAICS must be NAICS codes separated by commas, not "${bad}"`);
  return {
    apiKey,
    lookbackDays: int("SAMGOV_LOOKBACK_DAYS", env.SAMGOV_LOOKBACK_DAYS, 30, 1, 365),
    ...(state ? { state } : {}),
    naics,
    maxPages: int("SAMGOV_MAX_PAGES", env.SAMGOV_MAX_PAGES, 1, 1, 10),
  };
}

/** Formats a date as MM/dd/yyyy in UTC, as the API expects. */
export function formatSamDate(date: Date): string {
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${mm}/${dd}/${date.getUTCFullYear()}`;
}

export interface SearchQuery {
  postedFrom: Date;
  postedTo: Date;
  ptype: string;
  ncode?: string;
  state?: string;
  offset?: number;
}

/** The search URL for one page. The API allows at most a year between the dates. */
export function buildSearchUrl(q: SearchQuery, apiKey: string): string {
  const days = (q.postedTo.getTime() - q.postedFrom.getTime()) / 86_400_000;
  if (days < 0) throw new Error("postedFrom must be on or before postedTo");
  if (days > 365) throw new Error("SAM.gov allows at most one year between postedFrom and postedTo");
  const url = new URL(SAMGOV_SEARCH_URL);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("postedFrom", formatSamDate(q.postedFrom));
  url.searchParams.set("postedTo", formatSamDate(q.postedTo));
  url.searchParams.set("ptype", q.ptype);
  url.searchParams.set("limit", String(SAMGOV_PAGE_SIZE));
  url.searchParams.set("offset", String(q.offset ?? 0));
  if (q.ncode) url.searchParams.set("ncode", q.ncode);
  if (q.state) url.searchParams.set("state", q.state);
  return url.toString();
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

const TYPES: Record<string, Opportunity["type"]> = {
  "solicitation": "solicitation",
  "combined synopsis/solicitation": "combined_synopsis_solicitation",
  "presolicitation": "presolicitation",
  "sources sought": "sources_sought",
};

/** "2026-12-01T14:00:00-07:00" stays; "2026-12-01" and other dates become ISO when they parse. */
function isoDate(v: string | null): string {
  if (!v) return "";
  const d = new Date(v);
  return /^\d{4}-\d{2}-\d{2}T/.test(v) || Number.isNaN(d.getTime()) ? v : d.toISOString();
}

/**
 * One API record as an Opportunity, or null for a record we can't bid (no id,
 * or a notice type such as an award or special notice).
 */
export function normalizeListing(raw: unknown): Opportunity | null {
  const r = obj(raw);
  const noticeId = str(r.noticeId);
  const type = TYPES[(str(r.type) ?? str(r.baseType) ?? "").toLowerCase()];
  if (!noticeId || !type) return null;
  const place = obj(r.placeOfPerformance);
  const title = str(r.title) ?? "(untitled)";
  const naicsCode = str(r.naicsCode) ?? "";
  const description = str(r.description);
  const o: Opportunity = {
    noticeId,
    title,
    // "DEPT OF DEFENSE.DEPT OF THE ARMY.W2SD ENDIST" names the office from the top down.
    agency: (str(r.fullParentPathName) ?? str(r.department) ?? "Unknown agency").split(".").map((s) => s.trim()).filter(Boolean).join(", "),
    naicsCode,
    type,
    active: str(r.active)?.toLowerCase() !== "no",
    // The API's field table spells it "reponseDeadLine"; accept both.
    responseDeadline: isoDate(str(r.reponseDeadLine) ?? str(r.responseDeadLine)),
    setAside: str(r.typeOfSetAsideDescription) ?? str(r.typeOfSetAside),
    placeOfPerformance: {
      city: str(obj(place.city).name) ?? "",
      state: str(obj(place.state).code) ?? str(obj(place.state).name) ?? "",
    },
    scopeSummary: title,
    estimatedValueUsd: null,
    complexity: null,
    source: "samgov",
    link: str(r.uiLink) ?? `https://sam.gov/opp/${encodeURIComponent(noticeId)}/view`,
    ...(description && /^https:\/\//.test(description) ? { descriptionUrl: description } : {}),
  };
  o.complexity = inferComplexity(o);
  return o;
}

/** Plain text from a description's HTML, cut to SCOPE_CHARS at a word. */
export function descriptionText(html: string): string {
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  if (text.length <= SCOPE_CHARS) return text;
  const cut = text.slice(0, SCOPE_CHARS);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), SCOPE_CHARS - 200))} ...`;
}

/** The error to show for a failed request, without the API key. */
async function failure(what: string, res: FetchResponse): Promise<Error> {
  let detail = "";
  try {
    detail = (await res.text()).replace(/\s+/g, " ").trim().slice(0, 200);
  } catch {
    // The body is only a hint.
  }
  const hint =
    res.status === 429 ? " (too many requests today; the cached listings are used until the limit resets)"
    : res.status === 401 || res.status === 403 ? " (check SAM_GOV_API_KEY)"
    : "";
  return new Error(`SAM.gov ${what} failed with HTTP ${res.status}${hint}${detail ? `: ${detail}` : ""}`);
}

export interface FetchResult {
  opportunities: Opportunity[];
  /** Requests made, so the owner can see how much of the daily allowance a refresh used. */
  requests: number;
}

const defaultFetch: SamFetch = (url) => fetch(url);

export class SamGovSource implements OpportunitySource {
  readonly name = "samgov";
  requests = 0;

  constructor(
    private readonly settings: SamGovSettings,
    private readonly fetchImpl: SamFetch = defaultFetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Every active construction solicitation in the window, newest request first, without duplicates. */
  async fetchAll(): Promise<FetchResult> {
    const before = this.requests;
    const postedTo = this.now();
    const postedFrom = new Date(postedTo.getTime() - this.settings.lookbackDays * 86_400_000);
    const codes: Array<string | undefined> = this.settings.naics.length ? this.settings.naics : [undefined];
    const byId = new Map<string, Opportunity>();
    for (const ptype of SAMGOV_PTYPES) {
      for (const ncode of codes) {
        for (let page = 0; page < this.settings.maxPages; page++) {
          const url = buildSearchUrl({ postedFrom, postedTo, ptype, ...(ncode ? { ncode } : {}), ...(this.settings.state ? { state: this.settings.state } : {}), offset: page }, this.settings.apiKey);
          const res = await this.request(url, "search");
          // 404 means no listings matched.
          if (res.status === 404) break;
          if (!res.ok) throw await failure("search", res);
          const body = obj(await res.json());
          const data = Array.isArray(body.opportunitiesData) ? body.opportunitiesData : [];
          for (const raw of data) {
            const o = normalizeListing(raw);
            if (o && o.active && CONSTRUCTION_NAICS_PREFIXES.some((p) => o.naicsCode.startsWith(p)) && !byId.has(o.noticeId)) byId.set(o.noticeId, o);
          }
          const total = typeof body.totalRecords === "number" ? body.totalRecords : 0;
          if (data.length < SAMGOV_PAGE_SIZE || (page + 1) * SAMGOV_PAGE_SIZE >= total) break;
        }
      }
    }
    return { opportunities: [...byId.values()], requests: this.requests - before };
  }

  async list(): Promise<Opportunity[]> {
    return (await this.fetchAll()).opportunities;
  }

  /** One request, counted, with a network failure explained. */
  private async request(url: string, what: string): Promise<FetchResponse> {
    this.requests++;
    try {
      return await this.fetchImpl(url);
    } catch (err) {
      const cause = err instanceof Error ? ((err.cause as Error | undefined)?.message ?? err.message) : String(err);
      throw new Error(`Could not reach SAM.gov for the ${what}: ${cause}. Check this machine's internet connection.`);
    }
  }

  /**
   * The listing with its description as the scope, read from SAM.gov. A listing
   * without one, or a description SAM.gov can't find, keeps the title as its scope.
   */
  async describe(o: Opportunity): Promise<Opportunity> {
    if (!o.descriptionUrl) return o;
    const url = new URL(o.descriptionUrl);
    if (url.hostname !== "api.sam.gov") return o;
    url.searchParams.set("api_key", this.settings.apiKey);
    const res = await this.request(url.toString(), "description");
    const { descriptionUrl: _done, ...rest } = o;
    if (res.status === 404) return rest;
    if (!res.ok) throw await failure("description", res);
    const body = await res.json().catch(() => null);
    const html = typeof body === "string" ? body : str(obj(body).description) ?? "";
    const text = descriptionText(html);
    if (!text || /^description not found$/i.test(text)) return rest;
    return { ...rest, scopeSummary: text };
  }
}
