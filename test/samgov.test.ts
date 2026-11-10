import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SamGovClient,
  buildSearchUrl,
  formatSamDate,
  normalizeOpportunity,
  parseSearchResponse,
} from "../src/samgov/client.js";
import { isBiddableConstruction, loadListingCache, pickOpportunity, saveListingCache } from "../src/samgov/pick.js";
import { SeededRng } from "../src/sim/rng.js";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/samgov-search.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

describe("formatSamDate", () => {
  it("formats as MM/dd/yyyy in UTC", () => {
    expect(formatSamDate(new Date("2026-01-05T23:00:00Z"))).toBe("01/05/2026");
  });
});

describe("buildSearchUrl", () => {
  const range = { postedFrom: new Date("2026-10-01T00:00:00Z"), postedTo: new Date("2026-11-01T00:00:00Z") };

  it("includes the key, dates, paging and filters", () => {
    const url = new URL(buildSearchUrl({ ...range, ncode: "236220", ptype: "o", limit: 50, offset: 2 }, "KEY"));
    expect(url.origin + url.pathname).toBe("https://api.sam.gov/opportunities/v2/search");
    expect(url.searchParams.get("api_key")).toBe("KEY");
    expect(url.searchParams.get("postedFrom")).toBe("10/01/2026");
    expect(url.searchParams.get("postedTo")).toBe("11/01/2026");
    expect(url.searchParams.get("ncode")).toBe("236220");
    expect(url.searchParams.get("ptype")).toBe("o");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("offset")).toBe("2");
  });

  it("defaults limit and offset and leaves out unset filters", () => {
    const url = new URL(buildSearchUrl(range, "KEY"));
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.get("offset")).toBe("0");
    expect(url.searchParams.has("ncode")).toBe(false);
  });

  it("rejects a missing key, reversed dates, over a year, and bad limits", () => {
    expect(() => buildSearchUrl(range, "")).toThrow(/API key/);
    expect(() => buildSearchUrl({ postedFrom: range.postedTo, postedTo: range.postedFrom }, "K")).toThrow();
    expect(() => buildSearchUrl({ postedFrom: new Date("2024-01-01"), postedTo: new Date("2026-01-01") }, "K")).toThrow(/one year/);
    expect(() => buildSearchUrl({ ...range, limit: 1001 }, "K")).toThrow(/limit/);
  });
});

describe("normalizeOpportunity", () => {
  it("maps fields and accepts both deadline spellings", () => {
    const [a, b] = (fixture.opportunitiesData as Record<string, unknown>[]).map(normalizeOpportunity);
    expect(a?.responseDeadline).toBe("2026-11-30T17:00:00-05:00");
    expect(a?.setAside).toBe("Total Small Business Set-Aside (FAR 19.5)");
    expect(a?.active).toBe(true);
    expect(b?.responseDeadline).toBe("2026-12-01T12:00:00-05:00");
    expect(b?.setAside).toBeNull();
  });

  it("requires a noticeId and defaults a missing title", () => {
    expect(() => normalizeOpportunity({})).toThrow(/noticeId/);
    expect(normalizeOpportunity({ noticeId: "x" }).title).toBe("(untitled)");
  });
});

describe("parseSearchResponse", () => {
  it("parses the fixture", () => {
    const r = parseSearchResponse(fixture);
    expect(r.totalRecords).toBe(4);
    expect(r.opportunities).toHaveLength(4);
  });

  it("handles empty and invalid bodies", () => {
    expect(parseSearchResponse({})).toEqual({ totalRecords: 0, opportunities: [] });
    expect(() => parseSearchResponse(null)).toThrow();
  });
});

describe("SamGovClient", () => {
  it("fetches and parses results", async () => {
    let calledUrl = "";
    const client = new SamGovClient("KEY", async (url) => {
      calledUrl = url;
      return { ok: true, status: 200, json: async () => fixture };
    });
    const r = await client.search({ postedFrom: new Date("2026-10-01"), postedTo: new Date("2026-10-31") });
    expect(calledUrl).toContain("api_key=KEY");
    expect(r.opportunities).toHaveLength(4);
  });

  it("throws on HTTP errors", async () => {
    const client = new SamGovClient("KEY", async () => ({ ok: false, status: 429, json: async () => ({}) }));
    await expect(client.search({ postedFrom: new Date("2026-10-01"), postedTo: new Date("2026-10-31") })).rejects.toThrow(/429/);
  });
});

describe("picking an opportunity", () => {
  const opps = parseSearchResponse(fixture).opportunities;

  it("keeps only active construction solicitations", () => {
    expect(opps.filter(isBiddableConstruction).map((o) => o.noticeId)).toEqual(["test-0001", "test-0002"]);
    expect(isBiddableConstruction({ ...opps[0]!, active: false })).toBe(false);
  });

  it("picks the same listing for the same seed, regardless of input order", () => {
    const a = pickOpportunity(opps, new SeededRng(7));
    const b = pickOpportunity([...opps].reverse(), new SeededRng(7));
    expect(a.noticeId).toBe(b.noticeId);
    expect(["test-0001", "test-0002"]).toContain(a.noticeId);
  });

  it("throws when nothing is biddable", () => {
    expect(() => pickOpportunity(opps.slice(2), new SeededRng(1))).toThrow(/No active/);
  });
});

describe("listing cache", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "cb-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("round-trips listings", async () => {
    const opps = parseSearchResponse(fixture).opportunities;
    const path = join(dir, "nested", "listings.json");
    await saveListingCache(path, opps);
    expect(await loadListingCache(path)).toEqual(opps);
  });

  it("rejects files that aren't a cache", async () => {
    const path = join(dir, "bad.json");
    await writeFile(path, "{}");
    await expect(loadListingCache(path)).rejects.toThrow(/not a listing cache/);
  });
});
