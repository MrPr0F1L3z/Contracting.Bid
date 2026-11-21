import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main, parseCpanelArgs, sshTargetFromEnv, type CpanelDeps } from "../src/cli/cpanel.js";
import type { HttpGet, HttpReply } from "../src/cpanel/check.js";
import { buildStampText } from "../src/cpanel/site.js";

const COMMIT = "abc1234def";
const ENV = {
  CPANEL_HOST: "cp.example.com",
  CPANEL_USER: "cb",
  CPANEL_KEY_FILE: "/k/key",
  CPANEL_KNOWN_HOSTS_FILE: "/k/known",
  CPANEL_DOMAIN: "contracting.bid",
};

const ok = (data: unknown) => ({ code: 0, stdout: JSON.stringify({ result: { status: 1, data, errors: null } }), stderr: "" });

interface FakeHost {
  subdomains: { domain: string; documentroot: string }[];
  certs: { domains: string[]; not_after: number; is_self_signed: number }[];
  liveBuildTxt: string;
  rsyncDryRun: string;
  calls: string[];
  rsyncCalls: string[][];
}

function fakeHost(over: Partial<FakeHost> = {}): FakeHost {
  return { subdomains: [], certs: [], liveBuildTxt: "", rsyncDryRun: ">f+++++++++ index.html\n", calls: [], rsyncCalls: [], ...over };
}

const year = Math.floor(new Date("2027-06-01T00:00:00Z").getTime() / 1000);

function exec(h: FakeHost): CpanelDeps["exec"] {
  return async (cmd, args) => {
    if (cmd === "rsync") {
      h.rsyncCalls.push(args);
      return { code: 0, stdout: args.includes("--dry-run") ? h.rsyncDryRun : "", stderr: "" };
    }
    if (cmd !== "ssh") return { code: 1, stdout: "", stderr: `unexpected ${cmd}` };
    const script = args[args.length - 1]!;
    h.calls.push(script);
    if (script.startsWith("for t in")) return { code: 0, stdout: "", stderr: "" };
    if (script.includes("DomainInfo domains_data")) {
      return ok({ main_domain: { domain: "contracting.bid", documentroot: "/home/cb/public_html" }, addon_domains: [], sub_domains: h.subdomains, parked_domains: [] });
    }
    if (script.includes("SubDomain addsubdomain")) {
      h.subdomains.push({ domain: "staging.contracting.bid", documentroot: "/home/cb/staging.contracting.bid" });
      return ok(null);
    }
    if (script.includes("SSL installed_hosts")) return ok(h.certs.map((c) => ({ certificate: c })));
    if (script.includes("SSL start_autossl_check")) {
      h.certs.push({ domains: ["contracting.bid", "www.contracting.bid", "staging.contracting.bid"], not_after: year, is_self_signed: 0 });
      return ok(null);
    }
    if (script.includes("SSL is_autossl_check_in_progress")) return ok(0);
    if (script.startsWith("cat ")) return { code: 0, stdout: h.liveBuildTxt, stderr: "" };
    if (script.includes("tar -czf")) {
      const target = /backups\/(\w+)-/.exec(script)![1];
      return { code: 0, stdout: `/home/cb/.contracting-bid-deploy/backups/${target}-20261121T230000Z.tar.gz\n`, stderr: "" };
    }
    if (script.includes("tar -xzf")) return { code: 0, stdout: "restored it\n", stderr: "" };
    if (script.startsWith("ls -1t")) return { code: 0, stdout: "/home/cb/.contracting-bid-deploy/backups/staging-20261121T230000Z.tar.gz\n", stderr: "" };
    return { code: 1, stdout: "", stderr: `unexpected script ${script}` };
  };
}

function reply(status: number, headers: Record<string, string> = {}, body = ""): HttpReply {
  return { status, header: (n) => headers[n.toLowerCase()] ?? null, text: async () => body };
}

function site(commit: string, target: "staging" | "production", broken = false): HttpGet {
  const host = target === "staging" ? "staging.contracting.bid" : "www.contracting.bid";
  return async (url) => {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.host !== host) return reply(301, { location: `https://${host}${u.pathname}${u.search}` });
    const h: Record<string, string> = target === "staging" ? { "x-robots-tag": "noindex" } : {};
    if (broken && u.pathname === "/") return reply(500);
    if (u.pathname === "/") return reply(200, h, "Contracting.Bid");
    if (u.pathname === "/robots.txt") return reply(200, h, target === "staging" ? "Disallow: /\n" : "Disallow: /app\n");
    if (u.pathname === "/build.txt") return reply(200, h, buildStampText({ commit, target, builtAt: "x" }));
    return reply(404, h);
  };
}

let dirs: string[] = [];
afterEach(() => {
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
  dirs = [];
});

function builtSite(): string {
  const d = mkdtempSync(join(tmpdir(), "cb-out-"));
  dirs.push(d);
  writeFileSync(join(d, "index.html"), "<title>Contracting.Bid</title>");
  return d;
}

function deps(h: FakeHost, over: Partial<CpanelDeps> = {}): { deps: Partial<CpanelDeps>; lines: string[] } {
  const lines: string[] = [];
  let t = new Date("2026-11-21T23:00:00Z").getTime();
  return {
    lines,
    deps: {
      exec: exec(h),
      out: (l) => lines.push(l),
      env: ENV,
      sleep: async (ms) => void (t += ms),
      now: () => new Date(t),
      resolveHost: async () => "203.0.113.9",
      autosslWaitMs: 60_000,
      ...over,
    },
  };
}

describe("parseCpanelArgs", () => {
  it("reads each command", () => {
    expect(parseCpanelArgs(["provision", "--apply"])).toMatchObject({ command: "provision", apply: true });
    expect(parseCpanelArgs(["deploy", "prod", "web/out", "--commit", COMMIT, "--dry-run"])).toMatchObject({ command: "deploy", target: "production", dir: "web/out", dryRun: true });
    expect(parseCpanelArgs(["stamp", "staging", "out", "--commit", COMMIT])).toMatchObject({ command: "stamp", target: "staging" });
    expect(parseCpanelArgs(["check", "staging"])).toMatchObject({ command: "check", target: "staging" });
    expect(parseCpanelArgs(["rollback", "production", "--backup", "/x"])).toMatchObject({ command: "rollback", backup: "/x" });
    expect(parseCpanelArgs(["window"])).toMatchObject({ command: "window" });
  });
  it("refuses wrong lines", () => {
    expect(parseCpanelArgs(["deploy", "staging", "out"])).toBeNull(); // no commit
    expect(parseCpanelArgs(["deploy", "dev", "out", "--commit", COMMIT])).toBeNull();
    expect(parseCpanelArgs(["stamp", "staging", "out", "--commit", "not-a-sha"])).toBeNull();
    expect(parseCpanelArgs(["provision", "--dry-run"])).toBeNull();
    expect(parseCpanelArgs(["check", "staging", "--apply"])).toBeNull();
    expect(parseCpanelArgs(["nope"])).toBeNull();
  });
});

describe("sshTargetFromEnv", () => {
  it("reads the settings and names the first one missing", () => {
    expect(sshTargetFromEnv(ENV)).toEqual({ host: "cp.example.com", user: "cb", port: 22, keyFile: "/k/key", knownHostsFile: "/k/known" });
    expect(() => sshTargetFromEnv({ ...ENV, CPANEL_HOST: "" })).toThrow("Set CPANEL_HOST");
  });
});

describe("pnpm cpanel help", () => {
  it("prints usage, and fails on a wrong line", async () => {
    const { deps: d, lines } = deps(fakeHost());
    expect(await main([], d)).toBe(0);
    expect(lines.join("\n")).toContain("pnpm cpanel provision");
    expect(await main(["bogus"], d)).toBe(2);
  });
});

describe("pnpm cpanel provision", () => {
  it("without --apply only reports, and changes nothing", async () => {
    const h = fakeHost();
    const { deps: d, lines } = deps(h);
    expect(await main(["provision"], d)).toBe(0);
    expect(lines.join("\n")).toContain("staging.contracting.bid does not exist yet");
    expect(lines.join("\n")).toContain("Nothing was changed");
    expect(h.calls.some((c) => c.includes("addsubdomain") || c.includes("start_autossl"))).toBe(false);
  });
  it("with --apply creates the subdomain in its own folder and gets certificates", async () => {
    const h = fakeHost();
    const { deps: d, lines } = deps(h);
    expect(await main(["provision", "--apply"], d)).toBe(0);
    expect(h.calls.find((c) => c.includes("addsubdomain"))).toContain("dir=staging.contracting.bid");
    expect(lines.join("\n")).toContain("Created staging.contracting.bid, served from /home/cb/staging.contracting.bid");
    for (const host of ["www.contracting.bid", "contracting.bid", "staging.contracting.bid"]) {
      expect(lines.some((l) => l.startsWith(`SSL: ${host} ok`))).toBe(true);
    }
    expect(lines.at(-1)).toBe("Provisioning done.");
  });
  it("is safe to run again: an existing subdomain is left as it is", async () => {
    const h = fakeHost({ subdomains: [{ domain: "staging.contracting.bid", documentroot: "/home/cb/staging.contracting.bid" }] });
    const { deps: d } = deps(h);
    expect(await main(["provision", "--apply"], d)).toBe(0);
    expect(h.calls.some((c) => c.includes("addsubdomain"))).toBe(false);
  });
  it("fails when AutoSSL cannot cover a host, and says where to look", async () => {
    const h = fakeHost({ subdomains: [{ domain: "staging.contracting.bid", documentroot: "/home/cb/staging.contracting.bid" }] });
    const run = exec(h);
    const { deps: d, lines } = deps(h, {
      exec: async (cmd, args) => (args.at(-1)!.includes("start_autossl") ? ok(null) : run(cmd, args)),
      resolveHost: async (n) => (n === "staging.contracting.bid" ? null : "203.0.113.9"),
    });
    expect(await main(["provision", "--apply"], d)).toBe(1);
    expect(lines.join("\n")).toContain("DNS: staging.contracting.bid does not resolve yet");
    expect(lines.join("\n")).toContain("SSL/TLS Status");
  });
  it("stops when the domain is not on the account", async () => {
    const { deps: d, lines } = deps(fakeHost(), { env: { ...ENV, CPANEL_DOMAIN: "elsewhere.com" } });
    expect(await main(["provision"], d)).toBe(1);
    expect(lines.join("\n")).toContain("elsewhere.com is not on this cPanel account");
  });
});

describe("pnpm cpanel stamp", () => {
  it("writes the rules for the target and the build stamp", async () => {
    const out = builtSite();
    const { deps: d } = deps(fakeHost());
    expect(await main(["stamp", "production", out, "--commit", COMMIT], d)).toBe(0);
    expect(readFileSync(join(out, ".htaccess"), "utf8")).toContain("https://www.contracting.bid%{REQUEST_URI}");
    expect(readFileSync(join(out, "_next/static/.htaccess"), "utf8")).toContain("immutable");
    expect(readFileSync(join(out, "build.txt"), "utf8")).toContain(`commit=${COMMIT}\ntarget=production`);
  });
  it("refuses a folder with no built site", async () => {
    const empty = mkdtempSync(join(tmpdir(), "cb-empty-"));
    dirs.push(empty);
    const { deps: d } = deps(fakeHost());
    expect(await main(["stamp", "staging", empty, "--commit", COMMIT], d)).toBe(1);
  });
});

async function stamped(target: "staging" | "production"): Promise<string> {
  const out = builtSite();
  await main(["stamp", target, out, "--commit", COMMIT], deps(fakeHost()).deps);
  return out;
}

describe("pnpm cpanel deploy", () => {
  const staged = { subdomains: [{ domain: "staging.contracting.bid", documentroot: "/home/cb/staging.contracting.bid" }] };

  it("backs up, syncs and checks staging", async () => {
    const h = fakeHost(staged);
    const out = await stamped("staging");
    const { deps: d, lines } = deps(h, { get: site(COMMIT, "staging") });
    expect(await main(["deploy", "staging", out, "--commit", COMMIT], d)).toBe(0);
    expect(h.calls.some((c) => c.includes("tar -czf"))).toBe(true);
    expect(h.rsyncCalls).toHaveLength(2);
    expect(h.rsyncCalls[1]!.at(-1)).toBe("cb@cp.example.com:/home/cb/staging.contracting.bid/");
    expect(lines.at(-1)).toBe(`PASS: staging.contracting.bid serves build ${COMMIT.slice(0, 12)}.`);
  });
  it("puts the backup back when a check fails", async () => {
    const h = fakeHost(staged);
    const out = await stamped("staging");
    const { deps: d, lines } = deps(h, { get: site(COMMIT, "staging", true) });
    expect(await main(["deploy", "staging", out, "--commit", COMMIT], d)).toBe(1);
    expect(h.calls.some((c) => c.includes("tar -xzf"))).toBe(true);
    expect(lines).toContain("restored it");
  });
  it("will not remove files the pipeline did not put there unless told to", async () => {
    const h = fakeHost({ rsyncDryRun: ">f+++++++++ index.html\n*deleting   wp-config.php\n" });
    const out = await stamped("production");
    const { deps: d, lines } = deps(h, { get: site(COMMIT, "production") });
    expect(await main(["deploy", "production", out, "--commit", COMMIT], d)).toBe(3);
    expect(lines).toContain("  wp-config.php");
    expect(h.rsyncCalls).toHaveLength(1); // only the dry run
    expect(h.calls.some((c) => c.includes("tar -czf"))).toBe(false);

    expect(await main(["deploy", "production", out, "--commit", COMMIT, "--replace-existing"], d)).toBe(0);
    expect(h.calls.some((c) => c.includes("tar -czf"))).toBe(true);
  });
  it("replaces its own earlier build without asking", async () => {
    const h = fakeHost({ rsyncDryRun: "*deleting   _next/static/old.js\n", liveBuildTxt: "commit=0000000\ntarget=production\nbuilt=x\n" });
    const out = await stamped("production");
    const { deps: d } = deps(h, { get: site(COMMIT, "production") });
    expect(await main(["deploy", "production", out, "--commit", COMMIT], d)).toBe(0);
  });
  it("a dry run lists the changes and makes none", async () => {
    const h = fakeHost(staged);
    const out = await stamped("staging");
    const { deps: d, lines } = deps(h);
    expect(await main(["deploy", "staging", out, "--commit", COMMIT, "--dry-run"], d)).toBe(0);
    expect(lines.at(-1)).toBe("Dry run: nothing was changed.");
    expect(h.rsyncCalls).toHaveLength(1);
    expect(h.calls.some((c) => c.includes("tar"))).toBe(false);
  });
  it("refuses a build stamped for another target or commit", async () => {
    const out = await stamped("staging");
    const { deps: d } = deps(fakeHost(staged));
    expect(await main(["deploy", "production", out, "--commit", COMMIT], d)).toBe(2);
    expect(await main(["deploy", "staging", out, "--commit", "1111111"], d)).toBe(2);
  });
  it("asks for provisioning when staging does not exist yet", async () => {
    const out = await stamped("staging");
    const { deps: d, lines } = deps(fakeHost());
    expect(await main(["deploy", "staging", out, "--commit", COMMIT], d)).toBe(1);
    expect(lines.at(-1)).toContain("Run the provision workflow");
  });
});

describe("pnpm cpanel rollback", () => {
  it("puts the newest backup back", async () => {
    const h = fakeHost({ subdomains: [{ domain: "staging.contracting.bid", documentroot: "/home/cb/staging.contracting.bid" }] });
    const { deps: d, lines } = deps(h);
    expect(await main(["rollback", "staging"], d)).toBe(0);
    expect(h.calls.find((c) => c.includes("tar -xzf"))).toContain("staging-20261121T230000Z.tar.gz");
    expect(lines).toContain("restored it");
  });
});

describe("pnpm cpanel check", () => {
  it("passes a good host and fails a bad one", async () => {
    expect(await main(["check", "production", "--commit", COMMIT], deps(fakeHost(), { get: site(COMMIT, "production") }).deps)).toBe(0);
    expect(await main(["check", "production"], deps(fakeHost(), { get: site(COMMIT, "production", true) }).deps)).toBe(1);
  });
});

describe("pnpm cpanel window", () => {
  const env = { PROD_MAINTENANCE_WINDOW: "daily 22:00-06:00", PROD_MAINTENANCE_TZ: "America/Los_Angeles" };
  it("is open at 11 pm Pacific and closed at noon", async () => {
    // 2026-11-22 07:00 UTC is 23:00 Pacific (PST).
    expect(await main(["window"], deps(fakeHost(), { env, now: () => new Date("2026-11-22T07:00:00Z") }).deps)).toBe(0);
    const closed = deps(fakeHost(), { env, now: () => new Date("2026-11-21T20:00:00Z") });
    expect(await main(["window"], closed.deps)).toBe(3);
    expect(closed.lines[0]).toContain("Next one opens");
  });
  it("fails without a window", async () => {
    expect(await main(["window"], deps(fakeHost(), { env: {} }).deps)).toBe(1);
  });
});

describe("pnpm cpanel setup", () => {
  function sshHome(): string {
    const home = mkdtempSync(join(tmpdir(), "cb-home-"));
    dirs.push(home);
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh", "cpanel_deploy"), "-----BEGIN OPENSSH PRIVATE KEY-----\nSECRETKEYDATA\n-----END OPENSSH PRIVATE KEY-----\n");
    writeFileSync(join(home, ".ssh", "cpanel_deploy.pub"), "ssh-ed25519 AAAA");
    writeFileSync(join(home, ".ssh", "id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\nOTHER\n");
    return home;
  }

  function setupDeps(home: string, answers: string[]) {
    const h = fakeHost();
    const run = exec(h);
    const stored: { args: string[]; input: string }[] = [];
    const { deps: d, lines } = deps(h, {
      env: { HOME: home },
      ask: async () => answers.shift() ?? "",
      exec: async (cmd, args) => {
        if (cmd === "ssh-keygen" && args[0] === "-y") return { code: 0, stdout: "ssh-ed25519 AAAA", stderr: "" };
        if (cmd === "ssh-keygen") return { code: 0, stdout: "256 SHA256:abc cp.example.com (ED25519)", stderr: "" };
        if (cmd === "ssh-keyscan") return { code: 0, stdout: "# banner\ncp.example.com ssh-ed25519 AAAAC3\n", stderr: "" };
        if (cmd === "git") return { code: 0, stdout: "https://github.com/MrPr0F1L3z/Contracting.Bid.git\n", stderr: "" };
        return run(cmd, args);
      },
      execInput: async (_cmd, args, input) => {
        stored.push({ args, input });
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    return { d, lines, stored, h };
  }

  it("finds the deploy key, checks the host, and stores secrets only after a yes", async () => {
    const home = sshHome();
    const { d, lines, stored, h } = setupDeps(home, ["cp.example.com", "cb", "", "", "y", "y"]);
    expect(await main(["setup"], d)).toBe(0);
    expect(lines).toContain(`Using ${join(home, ".ssh", "cpanel_deploy")}.`);
    expect(h.calls.some((c) => c.includes("domains_data"))).toBe(true);
    expect(stored.map((s) => s.args[2])).toEqual(["CPANEL_SSH_KEY", "CPANEL_KNOWN_HOSTS", "CPANEL_HOST", "CPANEL_USER", "CPANEL_PORT", "CPANEL_DOMAIN", "CPANEL_ENABLED"]);
    expect(stored[0]!.input).toContain("SECRETKEYDATA");
    expect(stored.every((s) => s.args.includes("MrPr0F1L3z/Contracting.Bid"))).toBe(true);
    // The key never shows up in what is printed.
    expect(lines.join("\n")).not.toContain("SECRETKEYDATA");
    expect(readFileSync(join(home, ".ssh", "contracting-bid-cpanel-known_hosts"), "utf8")).toBe("cp.example.com ssh-ed25519 AAAAC3\n");
  });
  it("stores nothing when the owner says no", async () => {
    const { d, lines, stored } = setupDeps(sshHome(), ["cp.example.com", "cb", "", "", "y", "n"]);
    expect(await main(["setup"], d)).toBe(2);
    expect(stored).toEqual([]);
    expect(lines.at(-1)).toBe("Nothing was stored.");
  });
  it("stops when the host key fingerprints do not match", async () => {
    const { d, stored, h } = setupDeps(sshHome(), ["cp.example.com", "cb", "", "", "n"]);
    expect(await main(["setup"], d)).toBe(2);
    expect(stored).toEqual([]);
    expect(h.calls).toEqual([]);
  });
  it("says so when there is no deploy key", async () => {
    const home = mkdtempSync(join(tmpdir(), "cb-home-"));
    dirs.push(home);
    const { d, lines } = setupDeps(home, []);
    expect(await main(["setup"], d)).toBe(1);
    expect(lines[0]).toContain('No private key with "deploy" in its name');
  });
});
