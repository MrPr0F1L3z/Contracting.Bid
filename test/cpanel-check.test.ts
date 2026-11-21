import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checksFor, fetchGet, runCheck, runChecks, type HttpGet, type HttpReply } from "../src/cpanel/check.js";
import { buildStampText, siteTarget } from "../src/cpanel/site.js";

const prod = siteTarget("production", "contracting.bid");
const staging = siteTarget("staging", "contracting.bid");

function reply(status: number, headers: Record<string, string> = {}, body = ""): HttpReply {
  return { status, header: (n) => headers[n.toLowerCase()] ?? null, text: async () => body };
}

/** A host that behaves the way the .htaccess rules should make the real one behave. */
function goodHost(commit: string, target: "staging" | "production"): HttpGet {
  const site = target === "production" ? prod : staging;
  return async (url) => {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.host !== site.host) return reply(301, { location: `https://${site.host}${u.pathname}${u.search}` });
    const headers: Record<string, string> = site.indexable ? {} : { "x-robots-tag": "noindex, nofollow" };
    if (u.pathname === "/") return reply(200, headers, "<title>Contracting.Bid</title>");
    if (u.pathname === "/robots.txt") return reply(200, headers, site.indexable ? "User-Agent: *\nAllow: /\nDisallow: /app\n" : "User-Agent: *\nDisallow: /\n");
    if (u.pathname === "/build.txt") return reply(200, headers, buildStampText({ commit, target, builtAt: "x" }));
    return reply(404, headers, "not found");
  };
}

describe("checksFor", () => {
  it("checks every redirect into https://www, the site, robots, 404 and the build on production", () => {
    const checks = checksFor(prod, "abc1234");
    expect(checks.filter((c) => c.status === 301).map((c) => c.url)).toEqual([
      "http://contracting.bid/pricing/?from=check",
      "https://contracting.bid/pricing/?from=check",
      "http://www.contracting.bid/pricing/?from=check",
    ]);
    expect(checks.every((c) => c.status !== 301 || c.location === "https://www.contracting.bid/pricing/?from=check")).toBe(true);
    expect(checks.map((c) => c.name)).toEqual(expect.arrayContaining(["robots.txt keeps private screens out", "unknown pages get the 404 page", "serves build abc1234"]));
  });
  it("checks staging forces HTTPS and is hidden from search engines", () => {
    const checks = checksFor(staging);
    expect(checks.filter((c) => c.status === 301).map((c) => c.url)).toEqual(["http://staging.contracting.bid/pricing/?from=check"]);
    expect(checks.map((c) => c.name)).toEqual(expect.arrayContaining(["robots.txt blocks every crawler", "pages say noindex"]));
    expect(checks.some((c) => c.commit)).toBe(false);
  });
});

describe("runCheck / runChecks", () => {
  it("passes a host that is set up right", async () => {
    for (const [site, target] of [[prod, "production"], [staging, "staging"]] as const) {
      const results = await runChecks(goodHost("abc1234", target), checksFor(site, "abc1234"), { sleep: async () => {} });
      expect(results.filter((r) => !r.ok)).toEqual([]);
    }
  });
  it("fails a redirect to the wrong place, a wrong build, and a missing noindex", async () => {
    const bad: HttpGet = async (url) => {
      const u = new URL(url);
      if (u.host === "contracting.bid") return reply(301, { location: `http://www.contracting.bid${u.pathname}` });
      if (u.pathname === "/build.txt") return reply(200, {}, buildStampText({ commit: "0000000", target: "production", builtAt: "x" }));
      return goodHost("abc1234", "production")(url);
    };
    const results = await runChecks(bad, checksFor(prod, "abc1234"), { attempts: 1 });
    const failed = results.filter((r) => !r.ok).map((r) => r.detail);
    expect(failed).toContain("redirects to http://www.contracting.bid/pricing/, expected https://www.contracting.bid/pricing/?from=check");
    expect(failed).toContain("serves 0000000, expected abc1234");
    const noindex = checksFor(staging).find((c) => c.name === "pages say noindex")!;
    expect((await runCheck(async () => reply(200, {}, ""), noindex)).detail).toBe('x-robots-tag is ""');
  });
  it("reports a connection or certificate failure as a failed check", async () => {
    const tlsError: HttpGet = async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "CERT_HAS_EXPIRED" } });
    };
    const r = await runCheck(tlsError, checksFor(staging)[1]!);
    expect(r).toMatchObject({ ok: false, detail: "could not connect: CERT_HAS_EXPIRED" });
  });
  it("retries a failing check before giving up", async () => {
    let calls = 0;
    const flaky: HttpGet = async (url) => (++calls < 3 ? reply(503) : goodHost("a", "staging")(url));
    const check = checksFor(staging)[1]!;
    const [r] = await runChecks(flaky, [check], { attempts: 3, sleep: async () => {} });
    expect(r!.ok).toBe(true);
    expect(calls).toBe(3);
  });
  it("names a wrong status and where it redirected", async () => {
    const r = await runCheck(async () => reply(302, { location: "/login" }), checksFor(staging)[1]!);
    expect(r.detail).toBe("expected 200, got 302 to /login");
  });
});

// Functional: the real fetch must hand back redirects instead of following them.
describe("fetchGet", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/old") res.writeHead(301, { location: "https://www.contracting.bid/old" }).end();
      else res.writeHead(200, { "x-robots-tag": "noindex" }).end("hello");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("returns a redirect as it is", async () => {
    const r = await fetchGet(`${base}/old`);
    expect(r.status).toBe(301);
    expect(r.header("location")).toBe("https://www.contracting.bid/old");
  });
  it("returns headers and the body", async () => {
    const r = await fetchGet(`${base}/`);
    expect(r.header("X-Robots-Tag")).toBe("noindex");
    expect(await r.text()).toBe("hello");
  });
});
