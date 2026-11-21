import { describe, expect, it } from "vitest";
import { buildStampText, checkDomain, htaccess, parseBuildStamp, parseTarget, siteTarget, staticAssetsHtaccess } from "../src/cpanel/site.js";

describe("checkDomain", () => {
  it("accepts and lower-cases a domain", () => {
    expect(checkDomain(" Contracting.Bid ")).toBe("contracting.bid");
  });
  it.each(["", "contracting", "-bad.bid", "a b.bid", "x.y/z"])("refuses %j", (d) => {
    expect(() => checkDomain(d)).toThrow(/not a domain/);
  });
});

describe("siteTarget", () => {
  it("serves production on www, redirecting the bare domain, with certificates for both", () => {
    expect(siteTarget("production", "contracting.bid")).toEqual({
      target: "production",
      host: "www.contracting.bid",
      redirectHosts: ["contracting.bid"],
      certHosts: ["www.contracting.bid", "contracting.bid"],
      indexable: true,
    });
  });
  it("serves staging on staging.*, not indexable", () => {
    expect(siteTarget("staging", "contracting.bid")).toEqual({
      target: "staging",
      host: "staging.contracting.bid",
      redirectHosts: [],
      certHosts: ["staging.contracting.bid"],
      indexable: false,
    });
  });
});

describe("parseTarget", () => {
  it("reads staging, production and prod", () => {
    expect(parseTarget("staging")).toBe("staging");
    expect(parseTarget("production")).toBe("production");
    expect(parseTarget("prod")).toBe("production");
    expect(parseTarget("dev")).toBeNull();
    expect(parseTarget(undefined)).toBeNull();
  });
});

describe("htaccess", () => {
  const prod = htaccess(siteTarget("production", "contracting.bid"));
  const staging = htaccess(siteTarget("staging", "contracting.bid"));

  it("sends anything that is not https://www.contracting.bid there in one 301, keeping the path", () => {
    expect(prod).toContain("RewriteCond %{HTTP_HOST} !^www\\.contracting\\.bid$ [NC,OR]");
    expect(prod).toContain("RewriteCond %{HTTPS} !=on");
    expect(prod).toContain("RewriteRule ^ https://www.contracting.bid%{REQUEST_URI} [R=301,L,NE]");
  });
  it("lets AutoSSL domain checks through before any redirect", () => {
    expect(prod.indexOf("RewriteRule ^\\.well-known/ - [L]")).toBeGreaterThan(-1);
    expect(prod.indexOf("RewriteRule ^\\.well-known/")).toBeLessThan(prod.indexOf("RewriteRule ^ https://"));
  });
  it("serves the 404 page and no folder listings", () => {
    expect(prod).toContain("ErrorDocument 404 /404.html");
    expect(prod).toContain("Options -Indexes");
  });
  it("forces HTTPS on staging and tells crawlers not to index it; production stays indexable", () => {
    expect(staging).toContain("RewriteRule ^ https://staging.contracting.bid%{REQUEST_URI} [R=301,L,NE]");
    expect(staging).toContain('X-Robots-Tag "noindex, nofollow"');
    expect(prod).not.toContain("X-Robots-Tag");
  });
  it("says not to edit it on the server", () => {
    expect(prod.split("\n")[0]).toMatch(/deploy pipeline/);
  });
  it("only uses directives that work in .htaccess on Apache and LiteSpeed (no <If>)", () => {
    expect(prod).not.toMatch(/<If\b/);
    expect(staticAssetsHtaccess()).toContain('Cache-Control "public, max-age=31536000, immutable"');
  });
});

describe("build stamp", () => {
  it("round-trips", () => {
    const stamp = { commit: "abc1234", target: "staging" as const, builtAt: "2026-11-21T13:00:00.000Z" };
    expect(parseBuildStamp(buildStampText(stamp))).toEqual(stamp);
  });
  it("returns null for a page that is not a stamp", () => {
    expect(parseBuildStamp("<html>not found</html>")).toBeNull();
    expect(parseBuildStamp("commit=abc\ntarget=dev\nbuilt=x")).toBeNull();
  });
});
