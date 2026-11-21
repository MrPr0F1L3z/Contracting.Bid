import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  backupName,
  backupScript,
  checkBackupPath,
  KEEP_BACKUPS,
  listBackupsScript,
  parsePort,
  restoreScript,
  rsyncArgv,
  shellQuote,
  sshArgv,
  summarizeRsync,
  TOOLS_CHECK,
  type SshTarget,
} from "../src/cpanel/remote.js";

const ssh: SshTarget = { host: "cp.example.com", user: "cb", port: 2222, keyFile: "/k/deploy key", knownHostsFile: "/k/known" };

describe("shellQuote", () => {
  it("leaves plain words alone and quotes the rest", () => {
    expect(shellQuote("/home/cb/public_html")).toBe("/home/cb/public_html");
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(execFileSync("sh", ["-c", `printf %s ${shellQuote("it's $HOME")}`]).toString()).toBe("it's $HOME");
  });
});

describe("parsePort", () => {
  it("defaults to 22 and checks the range", () => {
    expect(parsePort(undefined)).toBe(22);
    expect(parsePort(" ")).toBe(22);
    expect(parsePort("2222")).toBe(2222);
    expect(() => parsePort("0")).toThrow();
    expect(() => parsePort("70000")).toThrow();
    expect(() => parsePort("ssh")).toThrow();
  });
});

describe("sshArgv", () => {
  it("uses only the key, never prompts, and always checks the host key", () => {
    const argv = sshArgv(ssh, "uptime");
    expect(argv).toEqual(expect.arrayContaining(["-i", "/k/deploy key", "-p", "2222", "BatchMode=yes", "StrictHostKeyChecking=yes", "UserKnownHostsFile=/k/known", "IdentitiesOnly=yes"]));
    expect(argv.slice(-2)).toEqual(["cb@cp.example.com", "uptime"]);
  });
});

describe("backupName / checkBackupPath", () => {
  it("names backups by target and UTC time", () => {
    expect(backupName("production", new Date("2026-11-21T23:04:05.678Z"))).toBe("production-20261121T230405Z.tar.gz");
  });
  it("accepts only that target's backups in the pipeline's folder", () => {
    const good = "/home/cb/.contracting-bid-deploy/backups/staging-20261121T230405Z.tar.gz";
    expect(checkBackupPath(` ${good}\n`, "staging")).toBe(good);
    expect(() => checkBackupPath(good, "production")).toThrow();
    expect(() => checkBackupPath("/etc/passwd", "staging")).toThrow();
    expect(() => checkBackupPath("/home/cb/../x/.contracting-bid-deploy/backups/staging-20261121T230405Z.tar.gz", "staging")).toThrow();
  });
});

describe("rsyncArgv", () => {
  const argv = rsyncArgv(ssh, { localDir: "web/out", root: "/home/cb/public_html", nested: ["old/"], dryRun: false });
  it("syncs the build's contents into the root and removes stale files last", () => {
    expect(argv.slice(-2)).toEqual(["web/out/", "cb@cp.example.com:/home/cb/public_html/"]);
    expect(argv).toEqual(expect.arrayContaining(["--delete-after", "--delay-updates", "--chmod=D755,F644"]));
    expect(argv).not.toContain("--dry-run");
  });
  it("never touches certificate checks, cgi-bin or other domains' folders", () => {
    expect(argv).toEqual(expect.arrayContaining(["--exclude=/.well-known/", "--exclude=/cgi-bin/", "--exclude=/old/"]));
  });
  it("connects the same way as ssh", () => {
    const e = argv[argv.indexOf("-e") + 1]!;
    expect(e).toContain("StrictHostKeyChecking=yes");
    expect(e).toContain("'/k/deploy key'");
  });
  it("can do a dry run", () => {
    expect(rsyncArgv(ssh, { localDir: "out/", root: "/home/cb/x", nested: [], dryRun: true })).toContain("--dry-run");
  });
  it("refuses a dangerous root", () => {
    expect(() => rsyncArgv(ssh, { localDir: "out", root: "/", nested: [], dryRun: true })).toThrow(/refusing/);
  });
});

describe("summarizeRsync", () => {
  it("counts files sent and removed", () => {
    const out = ">f+++++++++ index.html\n>fc.t...... app/index.html\ncd+++++++++ app/\n*deleting   old.php\n*deleting   wp-admin/\n";
    expect(summarizeRsync(out)).toEqual({ sent: 2, deleted: 2, deletedPaths: ["old.php", "wp-admin/"] });
    expect(summarizeRsync("")).toEqual({ sent: 0, deleted: 0, deletedPaths: [] });
  });
});

describe("TOOLS_CHECK", () => {
  it("prints nothing for tools that exist and names the missing ones", () => {
    const out = execFileSync("sh", ["-c", TOOLS_CHECK.replace("uapi rsync tar", "sh no-such-tool-xyz")]).toString();
    expect(out.trim()).toBe("missing no-such-tool-xyz");
  });
});

// Functional: run the real backup, rsync and restore steps against folders on this machine,
// the way they run on the host (HOME stands in for the cPanel user's home folder).
const hasRsync = (() => {
  try {
    execFileSync("rsync", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasRsync)("backup, sync and restore on real folders", () => {
  let home = "";
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const sh = (script: string) => execFileSync("sh", ["-c", script], { env: { ...process.env, HOME: home } }).toString();
  const write = (path: string, text: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  };

  it("replaces the site, keeps protected and nested folders, and puts the old site back", () => {
    home = mkdtempSync(join(tmpdir(), "cpanel-home-"));
    const root = join(home, "public_html");
    write(join(root, "index.html"), "old site");
    write(join(root, "old.php"), "<?php");
    write(join(root, ".well-known/acme-challenge/token"), "acme");
    write(join(root, "old/index.html"), "nested subdomain");
    const build = join(home, "build");
    write(join(build, "index.html"), "new site");
    write(join(build, "pricing/index.html"), "pricing");

    const backup = sh(backupScript("production", root, new Date("2026-11-21T23:00:00Z"), ["old/"])).trim().split("\n").pop()!;
    expect(checkBackupPath(backup, "production")).toBe(backup);
    expect(execFileSync("tar", ["-tzf", backup]).toString()).not.toContain("./old/");

    // The deploy's rsync, run locally: same filters, local destination instead of user@host.
    const argv = rsyncArgv({ ...ssh }, { localDir: build, root, nested: ["old/"], dryRun: false });
    const e = argv.indexOf("-e");
    const local = [...argv.slice(0, e), ...argv.slice(e + 2, -1), `${root}/`];
    execFileSync("rsync", local);
    expect(readFileSync(join(root, "index.html"), "utf8")).toBe("new site");
    expect(readFileSync(join(root, "pricing/index.html"), "utf8")).toBe("pricing");
    expect(existsSync(join(root, "old.php"))).toBe(false);
    expect(readFileSync(join(root, ".well-known/acme-challenge/token"), "utf8")).toBe("acme");
    expect(readFileSync(join(root, "old/index.html"), "utf8")).toBe("nested subdomain");

    sh(restoreScript(root, backup, "production", ["old/"]));
    expect(readFileSync(join(root, "index.html"), "utf8")).toBe("old site");
    expect(readFileSync(join(root, "old.php"), "utf8")).toBe("<?php");
    expect(existsSync(join(root, "pricing"))).toBe(false);
    expect(readFileSync(join(root, "old/index.html"), "utf8")).toBe("nested subdomain");
    expect(readFileSync(join(root, ".well-known/acme-challenge/token"), "utf8")).toBe("acme");
  });

  it(`keeps only the newest ${KEEP_BACKUPS} backups of a target`, () => {
    home = mkdtempSync(join(tmpdir(), "cpanel-home-"));
    const root = join(home, "staging.contracting.bid");
    for (let i = 0; i < KEEP_BACKUPS + 2; i++) {
      sh(backupScript("staging", root, new Date(Date.UTC(2026, 10, 21, 0, i))));
      sh(`touch -d "2026-11-21 00:0${i}:00" "$HOME/.contracting-bid-deploy/backups/staging-20261121T000${i}00Z.tar.gz"`);
    }
    sh(backupScript("production", join(home, "public_html"), new Date("2026-11-21T00:00:00Z")));
    const list = sh(listBackupsScript("staging")).trim().split("\n");
    expect(list).toHaveLength(KEEP_BACKUPS);
    expect(list[0]).toContain("staging-20261121T000600Z");
    expect(sh(listBackupsScript("production")).trim().split("\n")).toHaveLength(1);
  });
});
