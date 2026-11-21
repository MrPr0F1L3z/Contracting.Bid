import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchJobs, main, parseSimArgs } from "../src/cli/sim.js";
import type { SamFetch } from "../src/opportunities/samgov.js";
import { STUB_OPPORTUNITIES } from "../src/opportunities/stub.js";
import type { BidReport } from "../src/sim/bidChain.js";
import { stubJobProviders } from "../src/sim/stubJob.js";

/** A made-up SAM.gov listing the scripted company can bid: painting and flooring, like STUB-E02. */
const LISTING = {
  noticeId: "f00dfeedf00dfeedf00dfeedf00dfeed",
  title: "Repaint walls and replace carpet, example visitor center",
  fullParentPathName: "EXAMPLE DEPARTMENT.EXAMPLE OFFICE",
  type: "Solicitation",
  reponseDeadLine: "2026-12-20T17:00:00-05:00",
  naicsCode: "236220",
  active: "Yes",
  placeOfPerformance: { city: { name: "Exampleville" }, state: { code: "VA" } },
  description: "https://api.sam.gov/prod/opportunities/v1/noticedesc?noticeid=f00dfeedf00dfeedf00dfeedf00dfeed",
};

function sam(fail = false): SamFetch & { calls: string[] } {
  const calls: string[] = [];
  const f: SamFetch = async (url) => {
    calls.push(url);
    const body = url.includes("noticedesc")
      ? { description: "<p>Paint 5,000 sq ft of walls and replace 2,000 sq ft of carpet with LVT.</p>" }
      : { totalRecords: 1, opportunitiesData: [LISTING] };
    return { ok: !fail, status: fail ? 503 : 200, json: async () => body, text: async () => "unavailable" };
  };
  return Object.assign(f, { calls });
}

describe("parseSimArgs: job source", () => {
  it("takes --source on bid-like commands and listings", () => {
    expect(parseSimArgs(["closeout", "--source", "samgov"])).toMatchObject({ source: "samgov" });
    expect(parseSimArgs(["listings", "--refresh", "--source", "stub"])).toMatchObject({ command: "listings", refresh: true, source: "stub" });
    expect(() => parseSimArgs(["hiring", "--source", "samgov"])).toThrow("--source is only for bid, job, closeout and listings");
    expect(() => parseSimArgs(["bid", "--source", "sam"])).toThrow('Unknown source "sam"; use stub or samgov');
    expect(() => parseSimArgs(["bid", "--stub", "--source", "samgov"])).toThrow(/from the stub source/);
    expect(() => parseSimArgs(["listings", "--seed", "1"])).toThrow(/listings takes only --source and --refresh/);
  });
});

describe("launchJobs", () => {
  it("offers the biddable listings it is given, the stub ones by default", () => {
    expect(launchJobs().map((j) => j.noticeId)).toEqual(["STUB-E01", "STUB-E02", "STUB-M01", "STUB-M02", "STUB-C01", "STUB-C02"]);
    expect(launchJobs(STUB_OPPORTUNITIES.slice(0, 1))).toEqual([{ noticeId: "STUB-E01", title: "Repave and restripe visitor parking lot", complexity: "easy" }]);
  });
});

describe("pnpm sim with SAM.gov listings (functional)", () => {
  let dir: string;
  let lines: string[];
  const out = (l: string) => lines.push(l);
  const now = () => new Date("2026-11-21T15:00:00.000Z");
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "simsam-"));
    lines = [];
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
  const env = () => ({ JOB_SOURCE: "samgov", SAM_GOV_API_KEY: "test-key", SAMGOV_CACHE_FILE: join(dir, "cache.json") });

  it("lists the stub jobs by default", async () => {
    expect(await main(["listings"], { out, env: {}, db: null })).toBe(0);
    expect(lines[0]).toBe("8 made-up stub listing(s).");
    expect(lines[1]).toBe("6 can be bid (active construction solicitations), soonest due first:");
    expect(lines[2]).toMatch(/^ {2}STUB-E01 {2}easy {6}due 2026-12-01 {2}Repave/);
  });

  it("lists SAM.gov jobs, reading SAM.gov once and then the cache", async () => {
    const f = sam();
    expect(await main(["listings"], { out, env: env(), db: null, samFetch: f, now })).toBe(0);
    expect(lines[0]).toBe("1 SAM.gov listing(s), read 2026-11-21T15:00:00.000Z with 2 request(s).");
    expect(lines[2]).toContain("f00dfeedf00dfeedf00dfeedf00dfeed  easy      due 2026-12-20  Repaint walls and replace carpet, example visitor center (Exampleville, VA)");
    expect(lines.at(-1)).toBe("Bid one with: pnpm sim closeout --job ID --source samgov");
    lines = [];
    expect(await main(["listings"], { out, env: env(), db: null, samFetch: f, now })).toBe(0);
    expect(f.calls).toHaveLength(2);
    expect(await main(["listings", "--refresh"], { out, env: env(), db: null, samFetch: f, now })).toBe(0);
    expect(f.calls).toHaveLength(4);
  });

  it("says what is missing when SAM.gov is not set up or cannot be reached", async () => {
    expect(await main(["listings", "--source", "samgov"], { out, env: {}, db: null })).toBe(2);
    expect(lines[0]).toMatch(/^JOB_SOURCE=samgov needs SAM_GOV_API_KEY/);
    lines = [];
    expect(await main(["closeout", "--auto-approve"], { out, env: env(), db: null, samFetch: sam(true), now, providers: stubJobProviders("cloud"), writeReport: async () => undefined })).toBe(2);
    expect(lines[0]).toMatch(/^SAM.gov search failed with HTTP 503: unavailable/);
    lines = [];
    expect(await main(["listings"], { out, env: { JOB_SOURCE: "sam" }, db: null })).toBe(2);
    expect(lines[0]).toBe('JOB_SOURCE must be stub or samgov, not "sam"');
  });

  it("bids a real listing with its description, and keeps the listing in the report", async () => {
    const f = sam();
    const code = await main(["bid", "--auto-approve", "--seed", "3", "--out", dir], { out, env: env(), db: null, samFetch: f, now, providers: stubJobProviders("cloud") });
    expect(code).toBe(0);
    expect(lines[0]).toBe("Bidding from 1 samgov listing(s).");
    const report = JSON.parse(await readFile(join(dir, "bid-cloud-2026-11-21T15-00-00-000Z-3.json"), "utf8")) as BidReport;
    expect(report.opportunity).toEqual({ noticeId: LISTING.noticeId, title: LISTING.title, complexity: "easy" });
    expect(report.bid).not.toBeNull();
    const found = report.events.find((e) => e.type === "opportunity_found")!;
    expect(found.payload).toMatchObject({ source: "samgov", agency: "EXAMPLE DEPARTMENT, EXAMPLE OFFICE", listing: { scopeSummary: "Paint 5,000 sq ft of walls and replace 2,000 sq ft of carpet with LVT." } });
    expect(f.calls.filter((c) => c.includes("noticedesc"))).toHaveLength(1);
    // The description is cached, so the next run reads nothing from SAM.gov.
    expect(await main(["bid", "--auto-approve", "--seed", "3", "--job", LISTING.noticeId, "--out", dir], { out, env: env(), db: null, samFetch: f, now, providers: stubJobProviders("cloud") })).toBe(0);
    expect(f.calls).toHaveLength(3);
  });

  it("runs a whole closeout on a real listing", async () => {
    const code = await main(["closeout", "--auto-approve", "--force-award", "--seed", "5", "--out", dir], { out, env: env(), db: null, samFetch: sam(), now, providers: stubJobProviders("cloud") });
    expect(lines.find((l) => l.startsWith("Run "))).toMatch(/CLOSED/);
    expect(code).toBe(0);
  });
});
