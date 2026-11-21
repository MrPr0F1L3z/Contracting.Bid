import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CachedSource, DbListingStore, FileListingStore, type ListingSnapshot } from "../src/opportunities/cache.js";
import { SamGovSource, type SamFetch } from "../src/opportunities/samgov.js";
import { DEFAULT_CACHE_FILE, jobSource, jobSourceName } from "../src/opportunities/source.js";
import { StubOpportunitySource } from "../src/opportunities/stub.js";
import { migratedDb } from "./helpers/pgliteDb.js";

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/samgov-search.json", import.meta.url), "utf8")) as unknown;
const dir = () => mkdtempSync(join(tmpdir(), "listings-"));
const snap = (fetchedAt: string, ids: string[] = ["a"]): ListingSnapshot => ({
  source: "samgov",
  fetchedAt,
  requests: 2,
  opportunities: ids.map((noticeId) => ({
    noticeId, title: noticeId, agency: "A", naicsCode: "238160", type: "solicitation", active: true, responseDeadline: "", setAside: null,
    placeOfPerformance: { city: "", state: "" }, scopeSummary: noticeId, estimatedValueUsd: null, complexity: "easy", source: "samgov",
  })),
});

/** A SAM.gov that answers every search with the fixture and every description with `desc`, counting calls. */
function sam(opts: { fail?: boolean; desc?: unknown } = {}) {
  const calls: string[] = [];
  const f: SamFetch = async (url) => {
    calls.push(url);
    const status = opts.fail ? 429 : 200;
    const body = url.includes("noticedesc") ? (opts.desc ?? { description: "Full scope text." }) : FIXTURE;
    return { ok: status === 200, status, json: async () => body, text: async () => "limit" };
  };
  return { f, calls };
}

describe("FileListingStore", () => {
  it("keeps one snapshot per source, and reads nothing from a missing file", async () => {
    const path = join(dir(), "sub", "cache.json");
    const store = new FileListingStore(path);
    expect(await store.read("samgov")).toBeNull();
    await store.write(snap("2026-11-21T00:00:00.000Z"));
    expect(await store.read("samgov")).toEqual(snap("2026-11-21T00:00:00.000Z"));
    expect(await store.read("other")).toBeNull();
  });
  it("replaces a broken file", async () => {
    const path = join(dir(), "cache.json");
    writeFileSync(path, "{nope");
    const store = new FileListingStore(path);
    await store.write(snap("2026-11-21T00:00:00.000Z"));
    expect((await store.read("samgov"))?.opportunities).toHaveLength(1);
  });
});

describe("DbListingStore (embedded Postgres)", () => {
  it("keeps the latest snapshot per source", async () => {
    const db = await migratedDb();
    const store = new DbListingStore(db);
    expect(await store.read("samgov")).toBeNull();
    await store.write(snap("2026-11-20T00:00:00.000Z", ["a"]));
    await store.write(snap("2026-11-21T00:00:00.000Z", ["b", "c"]));
    expect(await store.read("samgov")).toEqual(snap("2026-11-21T00:00:00.000Z", ["b", "c"]));
    await db.close();
  });
});

describe("CachedSource", () => {
  const now = () => new Date("2026-11-21T12:00:00Z");

  it("reads SAM.gov once, then serves the cache until it is stale", async () => {
    const { f, calls } = sam();
    const store = new FileListingStore(join(dir(), "c.json"));
    const s = new CachedSource(new SamGovSource({ apiKey: "K", lookbackDays: 30, naics: [], maxPages: 1 }, f, now), store, 24, now);
    expect(s.name).toBe("samgov");
    expect(await s.list()).toHaveLength(2);
    expect(await s.list()).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect((await store.read("samgov"))?.requests).toBe(2);
    await s.snapshot(true);
    expect(calls).toHaveLength(4);
  });

  it("falls back to a stale cache when SAM.gov fails, and fails when there is none", async () => {
    const store = new FileListingStore(join(dir(), "c.json"));
    const warnings: string[] = [];
    const live = new SamGovSource({ apiKey: "K", lookbackDays: 30, naics: [], maxPages: 1 }, sam({ fail: true }).f, now);
    const s = new CachedSource(live, store, 24, now, (l) => warnings.push(l));
    await expect(s.list()).rejects.toThrow(/HTTP 429/);
    await store.write(snap("2026-11-01T00:00:00.000Z"));
    expect((await s.list()).map((o) => o.noticeId)).toEqual(["a"]);
    expect(warnings[0]).toMatch(/HTTP 429.*Using the listings read 2026-11-01T00:00:00.000Z\.$/);
  });

  it("describes a listing once and keeps the description in the cache", async () => {
    const { f, calls } = sam();
    const store = new FileListingStore(join(dir(), "c.json"));
    const s = new CachedSource(new SamGovSource({ apiKey: "K", lookbackDays: 30, naics: [], maxPages: 1 }, f, now), store, 24, now);
    const [roof] = await s.list();
    const d = await s.describe(roof!);
    expect(d.scopeSummary).toBe("Full scope text.");
    const again = (await s.list()).find((o) => o.noticeId === roof!.noticeId)!;
    expect(again.scopeSummary).toBe("Full scope text.");
    expect(await s.describe(again)).toBe(again);
    expect(calls.filter((c) => c.includes("noticedesc"))).toHaveLength(1);
  });

  it("bids from the title when the description can't be read now", async () => {
    const warnings: string[] = [];
    const store = new FileListingStore(join(dir(), "c.json"));
    const ok = new CachedSource(new SamGovSource({ apiKey: "K", lookbackDays: 30, naics: [], maxPages: 1 }, sam().f, now), store, 24, now);
    const [roof] = await ok.list();
    const failing = new CachedSource(new SamGovSource({ apiKey: "K", lookbackDays: 30, naics: [], maxPages: 1 }, sam({ fail: true }).f, now), store, 24, now, (l) => warnings.push(l));
    expect(await failing.describe(roof!)).toBe(roof);
    expect(warnings[0]).toMatch(/Bidding 0a1b2c3d4e5f60718293a4b5c6d7e8f9 from its title\.$/);
  });
});

describe("jobSource", () => {
  it("reads JOB_SOURCE, stub by default", () => {
    expect(jobSourceName(undefined)).toBe("stub");
    expect(jobSourceName(" SAMGOV ")).toBe("samgov");
    expect(() => jobSourceName("sam")).toThrow('JOB_SOURCE must be stub or samgov, not "sam"');
  });

  it("builds the stub, or SAM.gov through a cache", () => {
    expect(jobSource("stub", {})).toBeInstanceOf(StubOpportunitySource);
    expect(() => jobSource("samgov", {})).toThrow(/SAM_GOV_API_KEY/);
    expect(jobSource("samgov", { SAM_GOV_API_KEY: "k" })).toBeInstanceOf(CachedSource);
    expect(() => jobSource("samgov", { SAM_GOV_API_KEY: "k", SAMGOV_CACHE_HOURS: "-1" })).toThrow(/^SAMGOV_CACHE_HOURS must be/);
    expect(DEFAULT_CACHE_FILE).toBe("data/samgov-listings.json");
  });
});
