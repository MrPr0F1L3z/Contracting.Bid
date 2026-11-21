import { describe, expect, it } from "vitest";
import { checkHost, checkUser, deployKeyCandidates, ghSetArgv, githubPlan, knownHostsLines, looksLikePrivateKey, repoFromRemote } from "../src/cpanel/setup.js";

describe("deployKeyCandidates", () => {
  it("keeps private keys with deploy in the name", () => {
    expect(deployKeyCandidates(["id_ed25519", "cpanel_deploy", "cpanel_deploy.pub", "Deploy-key", "known_hosts", "config", "deploy.bak"])).toEqual([
      "Deploy-key",
      "cpanel_deploy",
    ]);
  });
});

describe("looksLikePrivateKey", () => {
  it("recognises OpenSSH and PEM keys only", () => {
    expect(looksLikePrivateKey("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe(true);
    expect(looksLikePrivateKey("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
    expect(looksLikePrivateKey("-----BEGIN PRIVATE KEY-----")).toBe(true);
    expect(looksLikePrivateKey("ssh-ed25519 AAAA... me@host")).toBe(false);
  });
});

describe("checkHost / checkUser", () => {
  it("accepts host names, IPs and cPanel users", () => {
    expect(checkHost(" server1.example-host.com ")).toBe("server1.example-host.com");
    expect(checkHost("203.0.113.9")).toBe("203.0.113.9");
    expect(checkUser("contract1")).toBe("contract1");
  });
  it("refuses anything that could become an ssh option or a shell word", () => {
    expect(() => checkHost("-oProxyCommand=x")).toThrow();
    expect(() => checkHost("a b")).toThrow();
    expect(() => checkUser("root;id")).toThrow();
    expect(() => checkUser("")).toThrow();
  });
});

describe("githubPlan / ghSetArgv", () => {
  const plan = githubPlan({ host: "cp.example.com", user: "cb", port: 22, domain: "contracting.bid" }, "/home/me/.ssh/cpanel_deploy", "cp.example.com ssh-ed25519 AAAA\n");
  it("stores the key from its file and never shows it", () => {
    const key = plan.find((v) => v.name === "CPANEL_SSH_KEY")!;
    expect(key).toMatchObject({ kind: "secret", fromFile: "/home/me/.ssh/cpanel_deploy" });
    expect(key.value).toBeUndefined();
    expect(key.shown).not.toMatch(/BEGIN/);
  });
  it("stores the connection as secrets and the domain and switch as variables", () => {
    expect(plan.filter((v) => v.kind === "secret").map((v) => v.name)).toEqual(["CPANEL_SSH_KEY", "CPANEL_KNOWN_HOSTS", "CPANEL_HOST", "CPANEL_USER", "CPANEL_PORT"]);
    expect(plan.filter((v) => v.kind === "variable").map((v) => [v.name, v.value])).toEqual([["CPANEL_DOMAIN", "contracting.bid"], ["CPANEL_ENABLED", "true"]]);
  });
  it("passes values to gh on stdin, not as arguments", () => {
    expect(ghSetArgv(plan[2]!, "o/r")).toEqual(["secret", "set", "CPANEL_HOST", "--repo", "o/r"]);
    expect(ghSetArgv(plan[5]!, "o/r")).toEqual(["variable", "set", "CPANEL_DOMAIN", "--repo", "o/r"]);
  });
});

describe("repoFromRemote", () => {
  it("reads https and ssh remotes", () => {
    expect(repoFromRemote("https://github.com/MrPr0F1L3z/Contracting.Bid.git\n")).toBe("MrPr0F1L3z/Contracting.Bid");
    expect(repoFromRemote("git@github.com:MrPr0F1L3z/Contracting.Bid.git")).toBe("MrPr0F1L3z/Contracting.Bid");
    expect(repoFromRemote("https://github.com/o/r")).toBe("o/r");
    expect(repoFromRemote("https://gitlab.com/o/r")).toBeNull();
  });
});

describe("knownHostsLines", () => {
  it("keeps key lines and drops ssh-keyscan's comments", () => {
    const scan = "# cp.example.com:22 SSH-2.0-OpenSSH_8.0\ncp.example.com ssh-ed25519 AAAAC3Nza\n[cp.example.com]:2222 ecdsa-sha2-nistp256 AAAAE2\n\n";
    expect(knownHostsLines(scan)).toBe("cp.example.com ssh-ed25519 AAAAC3Nza\n[cp.example.com]:2222 ecdsa-sha2-nistp256 AAAAE2\n");
    expect(knownHostsLines("# nothing\n")).toBe("");
  });
});
