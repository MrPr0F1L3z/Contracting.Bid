import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SAMGOV_PAGE_SIZE,
  SCOPE_CHARS,
  SamGovSource,
  buildSearchUrl,
  descriptionText,
  formatSamDate,
  normalizeListing,
  samGovSettings,
  type FetchResponse,
  type SamFetch,
  type SamGovSettings,
} from "../src/opportunities/samgov.js";

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/samgov-search.json", import.meta.url), "utf8")) as { opportunitiesData: unknown[] };
const NOW = new Date("2026-11-21T12:00:00Z");
const settings = (s: Partial<SamGovSettings> = {}): SamGovSettings => ({ apiKey: "KEY", lookbackDays: 30, naics: [], maxPages: 1, ...s });

const res = (status: number, body: unknown): FetchResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

/** A fake SAM.gov that answers from a function and records each URL. */
function fake(answer: (url: URL) => FetchResponse): SamFetch & { urls: URL[] } {
  const urls: URL[] = [];
  const f = async (u: string) => {
    const url = new URL(u);
    urls.push(url);
    return answer(url);
  };
  return Object.assign(f, { urls });
}

describe("samGovSettings", () => {
  it("needs an API key and has defaults", () => {
    expect(() => samGovSettings({})).toThrow(/^JOB_SOURCE=samgov needs SAM_GOV_API_KEY/);
    expect(samGovSettings({ SAM_GOV_API_KEY: " k " })).toEqual({ apiKey: "k", lookbackDays: 30, naics: [], maxPages: 1 });
  });

  it("reads the optional settings and names a bad one", () => {
    expect(samGovSettings({ SAM_GOV_API_KEY: "k", SAMGOV_LOOKBACK_DAYS: "7", SAMGOV_STATE: "va", SAMGOV_NAICS: "238160, 2382", SAMGOV_MAX_PAGES: "3" }))
      .toEqual({ apiKey: "k", lookbackDays: 7, state: "VA", naics: ["238160", "2382"], maxPages: 3 });
    expect(() => samGovSettings({ SAM_GOV_API_KEY: "k", SAMGOV_LOOKBACK_DAYS: "400" })).toThrow(/^SAMGOV_LOOKBACK_DAYS must be/);
    expect(() => samGovSettings({ SAM_GOV_API_KEY: "k", SAMGOV_STATE: "Virginia" })).toThrow(/^SAMGOV_STATE must be/);
    expect(() => samGovSettings({ SAM_GOV_API_KEY: "k", SAMGOV_NAICS: "23x" })).toThrow(/^SAMGOV_NAICS must be/);
    expect(() => samGovSettings({ SAM_GOV_API_KEY: "k", SAMGOV_MAX_PAGES: "0" })).toThrow(/^SAMGOV_MAX_PAGES must be/);
  });
});

describe("buildSearchUrl", () => {
  it("formats dates as MM/dd/yyyy and sets every parameter", () => {
    expect(formatSamDate(new Date("2026-01-05T23:00:00Z"))).toBe("01/05/2026");
    const url = new URL(buildSearchUrl({ postedFrom: new Date("2026-10-22T00:00:00Z"), postedTo: NOW, ptype: "o", ncode: "238160", state: "VA", offset: 2 }, "KEY"));
    expect(url.origin + url.pathname).toBe("https://api.sam.gov/opportunities/v2/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      api_key: "KEY", postedFrom: "10/22/2026", postedTo: "11/21/2026", ptype: "o", limit: String(SAMGOV_PAGE_SIZE), offset: "2", ncode: "238160", state: "VA",
    });
  });

  it("refuses a window SAM.gov would refuse", () => {
    expect(() => buildSearchUrl({ postedFrom: NOW, postedTo: new Date("2026-01-01"), ptype: "o" }, "K")).toThrow("postedFrom must be on or before postedTo");
    expect(() => buildSearchUrl({ postedFrom: new Date("2025-01-01"), postedTo: NOW, ptype: "o" }, "K")).toThrow(/at most one year/);
  });
});

describe("normalizeListing", () => {
  it("maps a SAM.gov record to an opportunity", () => {
    expect(normalizeListing(FIXTURE.opportunitiesData[0])).toEqual({
      noticeId: "0a1b2c3d4e5f60718293a4b5c6d7e8f9",
      title: "Roof replacement, Building 300",
      agency: "EXAMPLE DEPARTMENT, EXAMPLE SUBAGENCY, EXAMPLE OFFICE",
      naicsCode: "238160",
      type: "solicitation",
      active: true,
      responseDeadline: "2026-12-15T14:00:00-05:00",
      setAside: "Total Small Business Set-Aside (FAR 19.5)",
      placeOfPerformance: { city: "Exampleville", state: "VA" },
      scopeSummary: "Roof replacement, Building 300",
      estimatedValueUsd: null,
      complexity: "easy",
      source: "samgov",
      link: "https://sam.gov/opp/0a1b2c3d4e5f60718293a4b5c6d7e8f9/view",
      descriptionUrl: "https://api.sam.gov/prod/opportunities/v1/noticedesc?noticeid=0a1b2c3d4e5f60718293a4b5c6d7e8f9",
    });
  });

  it("accepts the other deadline spelling, a state name, and no description", () => {
    const o = normalizeListing(FIXTURE.opportunitiesData[1])!;
    expect(o.type).toBe("combined_synopsis_solicitation");
    expect(o.responseDeadline).toBe("2026-12-01T00:00:00.000Z");
    expect(o.placeOfPerformance).toEqual({ city: "", state: "Colorado" });
    expect(o.descriptionUrl).toBeUndefined();
    expect(o.link).toBe("https://sam.gov/opp/1b2c3d4e5f60718293a4b5c6d7e8f9a0/view");
    expect(o.complexity).toBe("moderate");
  });

  it("skips records it cannot bid, and keeps inactive ones marked inactive", () => {
    expect(normalizeListing(FIXTURE.opportunitiesData[3])).toBeNull();
    expect(normalizeListing({ title: "no id", type: "Solicitation" })).toBeNull();
    expect(normalizeListing(null)).toBeNull();
    expect(normalizeListing(FIXTURE.opportunitiesData[4])!.active).toBe(false);
    expect(normalizeListing({ noticeId: "x", type: "Solicitation" })).toMatchObject({ title: "(untitled)", agency: "Unknown agency", responseDeadline: "" });
  });
});

describe("descriptionText", () => {
  it("turns HTML into plain text", () => {
    expect(descriptionText("<p>Remove &amp; replace <b>roof</b>.</p><ul><li>Crane&nbsp;lift</li></ul><script>x()</script>")).toBe("Remove & replace roof .\nCrane lift");
  });
  it("cuts long text at a word", () => {
    const t = descriptionText("word ".repeat(1000));
    expect(t.length).toBeLessThanOrEqual(SCOPE_CHARS + 4);
    expect(t.endsWith("word ...")).toBe(true);
  });
});

describe("SamGovSource", () => {
  it("asks for solicitations and combined synopses, keeps active construction, and drops duplicates", async () => {
    const f = fake(() => res(200, FIXTURE));
    const s = new SamGovSource(settings({ state: "VA" }), f, () => NOW);
    const r = await s.fetchAll();
    expect(f.urls.map((u) => u.searchParams.get("ptype"))).toEqual(["o", "k"]);
    expect(f.urls[0]!.searchParams.get("state")).toBe("VA");
    expect(f.urls[0]!.searchParams.get("postedFrom")).toBe("10/22/2026");
    expect(r.requests).toBe(2);
    expect(r.opportunities.map((o) => o.noticeId)).toEqual(["0a1b2c3d4e5f60718293a4b5c6d7e8f9", "1b2c3d4e5f60718293a4b5c6d7e8f9a0"]);
    expect(await s.list()).toHaveLength(2);
    expect(s.requests).toBe(4);
  });

  it("makes one request per NAICS code, and pages until the last page", async () => {
    const full = { totalRecords: SAMGOV_PAGE_SIZE + 1, opportunitiesData: Array.from({ length: SAMGOV_PAGE_SIZE }, (_, i) => ({ noticeId: `n${i}`, type: "Solicitation", naicsCode: "238160", active: "Yes" })) };
    const f = fake((u) => (u.searchParams.get("offset") === "0" ? res(200, full) : res(200, { totalRecords: 1001, opportunitiesData: [{ noticeId: "last", type: "Solicitation", naicsCode: "238160" }] })));
    const r = await new SamGovSource(settings({ naics: ["238160", "238220"], maxPages: 5 }), f, () => NOW).fetchAll();
    expect(f.urls.map((u) => `${u.searchParams.get("ptype")}:${u.searchParams.get("ncode")}:${u.searchParams.get("offset")}`)).toEqual([
      "o:238160:0", "o:238160:1", "o:238220:0", "o:238220:1", "k:238160:0", "k:238160:1", "k:238220:0", "k:238220:1",
    ]);
    expect(r.opportunities).toHaveLength(SAMGOV_PAGE_SIZE + 1);
  });

  it("treats 404 as no listings, and explains other failures without the key", async () => {
    expect((await new SamGovSource(settings(), fake(() => res(404, "No data found")), () => NOW).fetchAll()).opportunities).toEqual([]);
    await expect(new SamGovSource(settings(), fake(() => res(429, "Too many")), () => NOW).fetchAll()).rejects.toThrow("SAM.gov search failed with HTTP 429 (too many requests today; the cached listings are used until the limit resets): Too many");
    const err = (await new SamGovSource(settings(), fake(() => res(403, { error: "An invalid api_key was supplied" })), () => NOW).fetchAll().catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/HTTP 403 \(check SAM_GOV_API_KEY\)/);
    expect(err.message).not.toContain("KEY&");
  });

  it("reads a description with the key, and keeps the title when there is none", async () => {
    const o = normalizeListing(FIXTURE.opportunitiesData[0])!;
    const f = fake(() => res(200, { description: "<p>Tear off and replace 20,000 sq ft of roofing.</p>" }));
    const s = new SamGovSource(settings(), f, () => NOW);
    const d = await s.describe(o);
    expect(f.urls[0]!.searchParams.get("api_key")).toBe("KEY");
    expect(f.urls[0]!.searchParams.get("noticeid")).toBe(o.noticeId);
    expect(d.scopeSummary).toBe("Tear off and replace 20,000 sq ft of roofing.");
    expect(d.descriptionUrl).toBeUndefined();
    expect(await s.describe(d)).toBe(d);
    expect((await new SamGovSource(settings(), fake(() => res(200, { description: "Description Not Found" }))).describe(o)).scopeSummary).toBe(o.title);
    expect((await new SamGovSource(settings(), fake(() => res(404, ""))).describe(o)).scopeSummary).toBe(o.title);
    await expect(new SamGovSource(settings(), fake(() => res(500, "down"))).describe(o)).rejects.toThrow("SAM.gov description failed with HTTP 500: down");
  });

  it("explains a network failure", async () => {
    const down: SamFetch = async () => { throw Object.assign(new Error("fetch failed"), { cause: new Error("getaddrinfo ENOTFOUND api.sam.gov") }); };
    await expect(new SamGovSource(settings(), down, () => NOW).fetchAll()).rejects.toThrow("Could not reach SAM.gov for the search: getaddrinfo ENOTFOUND api.sam.gov. Check this machine's internet connection.");
  });

  it("never sends the key to another host", async () => {
    const o = { ...normalizeListing(FIXTURE.opportunitiesData[0])!, descriptionUrl: "https://example.com/desc" };
    const f = fake(() => res(200, {}));
    expect(await new SamGovSource(settings(), f).describe(o)).toBe(o);
    expect(f.urls).toEqual([]);
  });
});
