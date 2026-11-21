import { describe, expect, it } from "vitest";
import {
  addSubdomainCall,
  autosslRunning,
  certCoverage,
  certOk,
  checkRemotePath,
  nestedRoots,
  parseDomainRoots,
  parseUapi,
  rootFor,
  uapiArgv,
} from "../src/cpanel/uapi.js";

const reply = (data: unknown, status = 1, errors: unknown = null) => JSON.stringify({ apiversion: 3, result: { data, status, errors } });

describe("uapiArgv", () => {
  it("builds a JSON uapi call", () => {
    expect(uapiArgv(addSubdomainCall("staging", "contracting.bid"))).toEqual([
      "uapi", "--output=json", "SubDomain", "addsubdomain",
      "domain=staging", "rootdomain=contracting.bid", "dir=staging.contracting.bid", "disallowdot=1",
    ]);
  });
  it("refuses arguments that could reach the shell", () => {
    expect(() => uapiArgv({ module: "SSL", func: "x", args: { domain: "a;rm -rf ~" } })).toThrow(/Unsafe/);
    expect(() => uapiArgv({ module: "SSL", func: "x", args: { "a b": "c" } })).toThrow(/Unsafe/);
  });
});

describe("parseUapi", () => {
  it("returns the data of a good reply", () => {
    expect(parseUapi(reply({ a: 1 }), "x")).toEqual({ a: 1 });
  });
  it("throws with cPanel's errors", () => {
    expect(() => parseUapi(reply(null, 0, ["The subdomain already exists."]), "SubDomain::addsubdomain")).toThrow(
      "SubDomain::addsubdomain: cPanel said: The subdomain already exists.",
    );
  });
  it("throws on output that is not JSON or has no result", () => {
    expect(() => parseUapi("bash: uapi: command not found", "x")).toThrow(/did not answer with JSON/);
    expect(() => parseUapi("{}", "x")).toThrow(/unexpected reply/);
  });
});

const hashData = {
  main_domain: { domain: "contracting.bid", documentroot: "/home/cb/public_html" },
  addon_domains: [{ domain: "other.com", documentroot: "/home/cb/other.com" }],
  sub_domains: [
    { domain: "staging.contracting.bid", documentroot: "/home/cb/staging.contracting.bid/" },
    { domain: "old.contracting.bid", documentroot: "/home/cb/public_html/old" },
  ],
  parked_domains: [],
};

describe("parseDomainRoots / rootFor / nestedRoots", () => {
  const roots = parseDomainRoots(hashData);
  it("reads the hash format", () => {
    expect(roots).toContainEqual({ domain: "contracting.bid", type: "main", documentRoot: "/home/cb/public_html" });
    expect(roots).toContainEqual({ domain: "staging.contracting.bid", type: "sub", documentRoot: "/home/cb/staging.contracting.bid" });
  });
  it("reads the list format", () => {
    expect(parseDomainRoots([{ domain: "A.com", documentroot: "/home/a/public_html", type: "main_domain" }])).toEqual([
      { domain: "a.com", type: "main", documentRoot: "/home/a/public_html" },
    ]);
  });
  it("ignores junk", () => {
    expect(parseDomainRoots(null)).toEqual([]);
    expect(parseDomainRoots([{ domain: 1 }])).toEqual([]);
  });
  it("serves www from the bare domain's folder", () => {
    expect(rootFor(roots, "www.contracting.bid")).toBe("/home/cb/public_html");
    expect(rootFor(roots, "staging.contracting.bid")).toBe("/home/cb/staging.contracting.bid");
    expect(rootFor(roots, "nope.contracting.bid")).toBeNull();
  });
  it("finds other domains' folders inside the live folder", () => {
    expect(nestedRoots(roots, "/home/cb/public_html")).toEqual(["old/"]);
    expect(nestedRoots(roots, "/home/cb/staging.contracting.bid")).toEqual([]);
  });
});

describe("checkRemotePath", () => {
  it("accepts a home folder path", () => {
    expect(checkRemotePath("/home/cb/public_html/", "x")).toBe("/home/cb/public_html");
  });
  it.each(["/", "/home", "relative/path", "/home/cb/../etc", "/home/cb/$(id)", "/home/cb/a b"])("refuses %j", (p) => {
    expect(() => checkRemotePath(p, "x")).toThrow(/refusing/);
  });
});

describe("autosslRunning", () => {
  it("reads the shapes cPanel uses", () => {
    expect(autosslRunning(1)).toBe(true);
    expect(autosslRunning(0)).toBe(false);
    expect(autosslRunning("1")).toBe(true);
    expect(autosslRunning({ in_progress: 1 })).toBe(true);
    expect(autosslRunning(null)).toBe(false);
  });
});

describe("certCoverage / certOk", () => {
  const now = new Date("2026-11-21T00:00:00Z");
  const t = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
  const installed = [
    { certificate: { domains: ["contracting.bid", "www.contracting.bid"], not_after: t("2027-02-01T00:00:00Z"), is_self_signed: 0, "issuer.organizationName": "Let's Encrypt" } },
    { certificate: { domains: ["*.contracting.bid"], not_after: t("2026-11-25T00:00:00Z"), is_self_signed: 0 } },
    { certificate: { domains: ["mail.contracting.bid"], not_after: t("2030-01-01T00:00:00Z"), is_self_signed: 1 } },
  ];
  it("finds the longest-lasting trusted certificate for each host", () => {
    const [www, apex, staging, mail, other] = certCoverage(installed, [
      "www.contracting.bid", "contracting.bid", "staging.contracting.bid", "mail.contracting.bid", "a.b.contracting.bid",
    ]);
    expect(www!.notAfter?.toISOString()).toBe("2027-02-01T00:00:00.000Z");
    expect(www!.issuer).toBe("Let's Encrypt");
    expect(apex!.notAfter).not.toBeNull();
    expect(staging!.notAfter?.toISOString()).toBe("2026-11-25T00:00:00.000Z");
    // A trusted wildcard beats a self-signed certificate that names the host.
    expect(mail!.selfSigned).toBe(false);
    expect(mail!.notAfter?.toISOString()).toBe("2026-11-25T00:00:00.000Z");
    // A wildcard covers one label only.
    expect(other!.notAfter).toBeNull();
  });
  it("needs a trusted certificate with at least a week left", () => {
    const [www, , staging, mail] = certCoverage(installed, ["www.contracting.bid", "contracting.bid", "staging.contracting.bid", "mail.contracting.bid"]);
    expect(certOk(www!, now)).toBe(true);
    expect(certOk(staging!, now)).toBe(false);
    expect(certOk(mail!, now)).toBe(false);
    const [selfOnly] = certCoverage([installed[2]], ["mail.contracting.bid"]);
    expect(selfOnly!.selfSigned).toBe(true);
    expect(certOk(selfOnly!, now)).toBe(false);
    expect(certOk({ host: "x", notAfter: null, issuer: null, selfSigned: false }, now)).toBe(false);
  });
  it("treats a reply that is not a list as no certificates", () => {
    expect(certCoverage(null, ["a.com"])[0]!.notAfter).toBeNull();
  });
});
