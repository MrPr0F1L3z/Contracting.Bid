import { lookup } from "node:dns/promises";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { loadDotEnv } from "../config/dotenv.js";
import { checksFor, fetchGet, runChecks, type HttpGet } from "../cpanel/check.js";
import {
  backupScript,
  listBackupsScript,
  parsePort,
  restoreScript,
  rsyncArgv,
  sshArgv,
  summarizeRsync,
  TOOLS_CHECK,
  checkBackupPath,
  type SshTarget,
} from "../cpanel/remote.js";
import {
  checkHost,
  checkUser,
  deployKeyCandidates,
  ghSetArgv,
  githubPlan,
  knownHostsLines,
  looksLikePrivateKey,
  repoFromRemote,
} from "../cpanel/setup.js";
import { buildStampText, checkDomain, htaccess, parseTarget, siteTarget, staticAssetsHtaccess, type Target } from "../cpanel/site.js";
import {
  addSubdomainCall,
  AUTOSSL_IN_PROGRESS,
  autosslRunning,
  certCoverage,
  certOk,
  checkRemotePath,
  DOMAINS_DATA,
  INSTALLED_HOSTS,
  nestedRoots,
  parseDomainRoots,
  parseUapi,
  rootFor,
  START_AUTOSSL,
  uapiArgv,
  type DomainRoot,
  type UapiCall,
} from "../cpanel/uapi.js";
import type { Exec } from "../deploy/pipeline.js";
import { currentWindow, checkTimeZone, formatIn, nextWindowStart, parseWindows } from "../deploy/window.js";
import { spawnExec } from "./stack.js";

export const CPANEL_USAGE = `Usage:
  pnpm cpanel setup                         once, on your machine: find the deploy key in ~/.ssh,
                                            check it reaches the host, and (after you say yes)
                                            store it and the host details as GitHub secrets
  pnpm cpanel provision [--apply]           show (or with --apply, make) the staging subdomain and
                                            AutoSSL certificates for staging.* and www.*
  pnpm cpanel stamp staging|production DIR --commit SHA
                                            add .htaccess and build.txt to a built site in DIR
  pnpm cpanel deploy staging|production DIR --commit SHA [--dry-run] [--replace-existing]
                                            back up the live folder, sync DIR to it, check it, and
                                            put the backup back if a check fails
  pnpm cpanel check staging|production [--commit SHA]
                                            redirects, HTTPS, robots, 404 and build checks
  pnpm cpanel rollback staging|production [--backup PATH]
                                            put the newest (or the named) backup back
  pnpm cpanel window                        exit 0 inside PROD_MAINTENANCE_WINDOW, 3 outside

Connection settings (GitHub Actions sets these from the repository secrets):
  CPANEL_HOST, CPANEL_USER, CPANEL_PORT (default 22), CPANEL_KEY_FILE, CPANEL_KNOWN_HOSTS_FILE,
  CPANEL_DOMAIN (default contracting.bid). See docs/CPANEL.md.`;

export interface CpanelArgs {
  command: "setup" | "provision" | "stamp" | "deploy" | "check" | "rollback" | "window";
  target?: Target;
  dir?: string;
  commit?: string;
  backup?: string;
  apply: boolean;
  dryRun: boolean;
  replaceExisting: boolean;
}

const COMMIT = /^[0-9a-f]{7,40}$/;

/** Parses a `pnpm cpanel` command line, or returns null when it is wrong. */
export function parseCpanelArgs(argv: readonly string[]): CpanelArgs | null {
  const [command, ...rest] = argv;
  const args: CpanelArgs = { command: "setup", apply: false, dryRun: false, replaceExisting: false };
  const words: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const value = () => {
      const v = rest[++i];
      return v && !v.startsWith("--") ? v : null;
    };
    if (a === "--apply") args.apply = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--replace-existing") args.replaceExisting = true;
    else if (a === "--commit") {
      const v = value();
      if (!v || !COMMIT.test(v)) return null;
      args.commit = v;
    } else if (a === "--backup") {
      const v = value();
      if (!v) return null;
      args.backup = v;
    } else if (a.startsWith("--")) return null;
    else words.push(a);
  }
  const flags = (allowed: (keyof CpanelArgs)[]) =>
    (["apply", "dryRun", "replaceExisting", "commit", "backup"] as const).every((f) => allowed.includes(f) || !args[f]);
  if ((command === "setup" || command === "window") && words.length === 0 && flags([])) return { ...args, command };
  if (command === "provision" && words.length === 0 && flags(["apply"])) return { ...args, command };
  const target = parseTarget(words[0]);
  if (!target) return null;
  if (command === "stamp" && words.length === 2 && args.commit && flags(["commit"])) return { ...args, command, target, dir: words[1]! };
  if (command === "deploy" && words.length === 2 && args.commit && flags(["commit", "dryRun", "replaceExisting"])) {
    return { ...args, command, target, dir: words[1]! };
  }
  if (command === "check" && words.length === 1 && flags(["commit"])) return { ...args, command, target };
  if (command === "rollback" && words.length === 1 && flags(["backup"])) return { ...args, command, target };
  return null;
}

/** The connection settings, from the environment. Throws naming the first one missing. */
export function sshTargetFromEnv(env: Record<string, string | undefined>): SshTarget {
  const need = (name: string) => {
    const v = env[name]?.trim();
    if (!v) throw new Error(`Set ${name} (see docs/CPANEL.md)`);
    return v;
  };
  return {
    host: checkHost(need("CPANEL_HOST")),
    user: checkUser(need("CPANEL_USER")),
    port: parsePort(env.CPANEL_PORT),
    keyFile: need("CPANEL_KEY_FILE"),
    knownHostsFile: need("CPANEL_KNOWN_HOSTS_FILE"),
  };
}

export interface CpanelDeps {
  exec: Exec;
  /** Runs a program with `input` on its stdin (gh secret set). */
  execInput: (cmd: string, args: string[], input: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  get: HttpGet;
  out: (line: string) => void;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  ask: (question: string) => Promise<string>;
  env: Record<string, string | undefined>;
  readdir: (dir: string) => Promise<string[]>;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, text: string) => Promise<void>;
  mkdir: (dir: string) => Promise<void>;
  resolveHost: (host: string) => Promise<string | null>;
  /** How long provision waits for AutoSSL, in all. */
  autosslWaitMs: number;
}

/** Talks to the host for one command. */
export class Host {
  constructor(
    private readonly deps: CpanelDeps,
    readonly ssh: SshTarget,
  ) {}

  async run(script: string, what: string): Promise<string> {
    const r = await this.deps.exec("ssh", sshArgv(this.ssh, script));
    if (r.code !== 0) throw new Error(`${what} failed on ${this.ssh.host} (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
    return r.stdout;
  }

  async uapi<T = unknown>(call: UapiCall): Promise<T> {
    const out = await this.run(uapiArgv(call).join(" "), `${call.module}::${call.func}`);
    return parseUapi<T>(out, `${call.module}::${call.func}`);
  }

  async domainRoots(): Promise<DomainRoot[]> {
    return parseDomainRoots(await this.uapi(DOMAINS_DATA));
  }
}

function domainOf(env: Record<string, string | undefined>): string {
  return checkDomain(env.CPANEL_DOMAIN?.trim() || "contracting.bid");
}

/** `pnpm cpanel provision`: the staging subdomain and certificates. */
export async function provision(deps: CpanelDeps, host: Host, apply: boolean): Promise<number> {
  const { out } = deps;
  const domain = domainOf(deps.env);
  const staging = siteTarget("staging", domain);
  const production = siteTarget("production", domain);
  const missingTools = (await host.run(TOOLS_CHECK, "tool check")).trim();
  if (missingTools) {
    out(`The host is missing tools the deploy needs: ${missingTools.replace(/\n/g, ", ")}. Ask the host to enable SSH shell tools.`);
    return 1;
  }
  let roots = await host.domainRoots();
  if (!rootFor(roots, domain)) {
    out(`${domain} is not on this cPanel account (it has: ${roots.map((r) => r.domain).join(", ") || "nothing"}).`);
    return 1;
  }
  out(`${domain} is on the account; the live site is served from ${rootFor(roots, domain)}.`);
  let problems = 0;
  if (rootFor(roots, staging.host)) {
    out(`${staging.host} exists, served from ${rootFor(roots, staging.host)}.`);
  } else if (!apply) {
    out(`${staging.host} does not exist yet. --apply creates it, with its own folder ~/${staging.host}.`);
  } else {
    await host.uapi(addSubdomainCall("staging", domain));
    roots = await host.domainRoots();
    const root = rootFor(roots, staging.host);
    if (!root) {
      out(`cPanel accepted the new subdomain but does not list ${staging.host}. Check it in cPanel > Domains.`);
      return 1;
    }
    out(`Created ${staging.host}, served from ${root}.`);
  }

  const liveIp = await deps.resolveHost(production.host);
  for (const name of [...production.certHosts, ...staging.certHosts]) {
    const ip = await deps.resolveHost(name);
    if (!ip) {
      out(`DNS: ${name} does not resolve yet. If this domain's DNS is not on cPanel, add an A record for it pointing at ${liveIp ?? "the host"}.`);
      if (apply) problems++;
    } else out(`DNS: ${name} -> ${ip}`);
  }

  const hosts = [...production.certHosts, ...staging.certHosts];
  let coverage = certCoverage(await host.uapi(INSTALLED_HOSTS), hosts);
  const missing = () => coverage.filter((c) => !certOk(c, deps.now()));
  if (missing().length && apply) {
    out(`Asking AutoSSL for certificates (${missing().map((c) => c.host).join(", ")} need one).`);
    await host.uapi(START_AUTOSSL);
    const until = deps.now().getTime() + deps.autosslWaitMs;
    await deps.sleep(15_000);
    while (autosslRunning(await host.uapi(AUTOSSL_IN_PROGRESS)) && deps.now().getTime() < until) await deps.sleep(15_000);
    coverage = certCoverage(await host.uapi(INSTALLED_HOSTS), hosts);
  }
  for (const c of coverage) {
    if (certOk(c, deps.now())) out(`SSL: ${c.host} ok, ${c.issuer ?? "certificate"} valid until ${c.notAfter!.toISOString().slice(0, 10)}`);
    else {
      const why = !c.notAfter ? "no certificate" : c.selfSigned ? "only a self-signed certificate" : `certificate ends ${c.notAfter.toISOString().slice(0, 10)}`;
      out(`SSL: ${c.host} has ${why}.${apply ? " AutoSSL did not fix it; see cPanel > SSL/TLS Status for the reason (usually DNS)." : " --apply asks AutoSSL for one."}`);
      if (apply) problems++;
    }
  }
  if (!apply) {
    out("Nothing was changed (no --apply).");
    return 0;
  }
  out(problems ? `${problems} problem(s) left; see above.` : "Provisioning done.");
  return problems ? 1 : 0;
}

/** `pnpm cpanel stamp`: writes the Apache rules and the build stamp into a built site. */
export async function stamp(deps: CpanelDeps, target: Target, dir: string, commit: string): Promise<number> {
  const site = siteTarget(target, domainOf(deps.env));
  await deps.readFile(join(dir, "index.html"));
  await deps.writeFile(join(dir, ".htaccess"), htaccess(site));
  await deps.mkdir(join(dir, "_next", "static"));
  await deps.writeFile(join(dir, "_next", "static", ".htaccess"), staticAssetsHtaccess());
  await deps.writeFile(join(dir, "build.txt"), buildStampText({ commit, target, builtAt: deps.now().toISOString() }));
  deps.out(`Stamped ${dir} for ${site.host} (build ${commit.slice(0, 12)}).`);
  return 0;
}

async function checkTarget(deps: CpanelDeps, target: Target, commit?: string): Promise<boolean> {
  const site = siteTarget(target, domainOf(deps.env));
  const results = await runChecks(deps.get, checksFor(site, commit), { sleep: deps.sleep });
  for (const r of results) deps.out(`${r.ok ? "PASS" : "FAIL"}  ${r.check.name}${r.ok ? "" : `: ${r.detail}`}`);
  return results.every((r) => r.ok);
}

/** `pnpm cpanel deploy`. */
export async function deploy(
  deps: CpanelDeps,
  host: Host,
  a: { target: Target; dir: string; commit: string; dryRun: boolean; replaceExisting: boolean },
): Promise<number> {
  const { out } = deps;
  const site = siteTarget(a.target, domainOf(deps.env));
  const stampText = await deps.readFile(join(a.dir, "build.txt")).catch(() => "");
  if (!stampText.includes(`commit=${a.commit}`) || !stampText.includes(`target=${a.target}`)) {
    out(`${a.dir} is not stamped for ${a.target} at ${a.commit}. Run pnpm cpanel stamp first.`);
    return 2;
  }
  const roots = await host.domainRoots();
  const found = rootFor(roots, site.host);
  if (!found) {
    out(`${site.host} is not on the cPanel account yet. Run the provision workflow (pnpm cpanel provision --apply) first.`);
    return 1;
  }
  const root = checkRemotePath(found, "deploy");
  const nested = nestedRoots(roots, root);
  out(`Deploying build ${a.commit.slice(0, 12)} to ${site.host} (${root})${nested.length ? `, leaving ${nested.join(", ")} alone` : ""}.`);

  const plan = await deps.exec("rsync", rsyncArgv(host.ssh, { localDir: a.dir, root, nested, dryRun: true }));
  if (plan.code !== 0) throw new Error(`rsync dry run failed (exit ${plan.code}): ${plan.stderr.trim().slice(0, 500)}`);
  const summary = summarizeRsync(plan.stdout);
  out(`Plan: ${summary.sent} file(s) to send, ${summary.deleted} to remove.`);
  const ours = (await host.run(`cat ${root}/build.txt 2>/dev/null || true`, "read build.txt")).includes("commit=");
  if (summary.deleted && !ours) {
    out(`${root} holds files the pipeline did not put there. These would be removed:`);
    for (const p of summary.deletedPaths.slice(0, 50)) out(`  ${p}`);
    if (summary.deletedPaths.length > 50) out(`  ...and ${summary.deletedPaths.length - 50} more`);
    if (!a.replaceExisting && !a.dryRun) {
      out("Stopped: nothing changed. A backup is taken first either way; to replace them, run again with --replace-existing.");
      return 3;
    }
  }
  if (a.dryRun) {
    for (const l of plan.stdout.split("\n").filter(Boolean).slice(0, 200)) out(`  ${l}`);
    out("Dry run: nothing was changed.");
    return 0;
  }

  const backup = checkBackupPath((await host.run(backupScript(a.target, root, deps.now(), nested), "backup")).trim().split("\n").pop() ?? "", a.target);
  out(`Saved the current files to ${backup}.`);
  const sync = await deps.exec("rsync", rsyncArgv(host.ssh, { localDir: a.dir, root, nested, dryRun: false }));
  if (sync.code !== 0) {
    out(`rsync failed (exit ${sync.code}): ${sync.stderr.trim().slice(0, 500)}. Putting the backup back.`);
    await host.run(restoreScript(root, backup, a.target, nested), "restore");
    return 1;
  }
  out("Files are in place. Checking the site:");
  if (await checkTarget(deps, a.target, a.commit)) {
    out(`PASS: ${site.host} serves build ${a.commit.slice(0, 12)}.`);
    return 0;
  }
  out("FAIL: a check failed. Putting the previous files back.");
  out((await host.run(restoreScript(root, backup, a.target, nested), "restore")).trim());
  return 1;
}

/** `pnpm cpanel rollback`. */
export async function rollback(deps: CpanelDeps, host: Host, target: Target, named?: string): Promise<number> {
  const site = siteTarget(target, domainOf(deps.env));
  const roots = await host.domainRoots();
  const found = rootFor(roots, site.host);
  if (!found) throw new Error(`${site.host} is not on the cPanel account`);
  const root = checkRemotePath(found, "rollback");
  const list = (await host.run(listBackupsScript(target), "list backups")).split("\n").map((l) => l.trim()).filter(Boolean);
  const backup = named ?? list[0];
  if (!backup) {
    deps.out(`There are no ${target} backups on the host.`);
    return 1;
  }
  deps.out((await host.run(restoreScript(root, checkBackupPath(backup, target), target, nestedRoots(roots, root)), "restore")).trim());
  return 0;
}

/** `pnpm cpanel window`. */
export function windowCheck(deps: CpanelDeps): number {
  const windows = parseWindows(deps.env.PROD_MAINTENANCE_WINDOW);
  const tz = checkTimeZone(deps.env.PROD_MAINTENANCE_TZ);
  const now = deps.now();
  const w = currentWindow(windows, now, tz);
  if (w) {
    deps.out(`Inside the maintenance window (${w.text}) at ${formatIn(now, tz)}.`);
    return 0;
  }
  const next = nextWindowStart(windows, now, tz);
  deps.out(`Outside the maintenance window at ${formatIn(now, tz)}. Next one opens ${next ? formatIn(next, tz) : "never"}.`);
  return 3;
}

/** `pnpm cpanel setup`, on the owner's machine. */
export async function setup(deps: CpanelDeps): Promise<number> {
  const { out, ask } = deps;
  const sshDir = join(deps.env.HOME || homedir(), ".ssh");
  const candidates = deployKeyCandidates(await deps.readdir(sshDir).catch(() => []));
  const keys: string[] = [];
  for (const name of candidates) {
    const first = (await deps.readFile(join(sshDir, name)).catch(() => "")).split("\n")[0] ?? "";
    if (looksLikePrivateKey(first)) keys.push(name);
  }
  if (keys.length === 0) {
    out(`No private key with "deploy" in its name in ${sshDir}.`);
    return 1;
  }
  let key = keys[0]!;
  if (keys.length > 1) {
    out(`Keys with "deploy" in the name: ${keys.map((k, i) => `${i + 1}) ${k}`).join("  ")}`);
    const pick = Number((await ask("Which one? ")).trim());
    if (!Number.isInteger(pick) || pick < 1 || pick > keys.length) return 2;
    key = keys[pick - 1]!;
  }
  const keyFile = join(sshDir, key);
  out(`Using ${keyFile}.`);
  const noPass = await deps.exec("ssh-keygen", ["-y", "-P", "", "-f", keyFile]);
  if (noPass.code !== 0) {
    out("That key has a passphrase. GitHub Actions cannot type one; use a deploy key without a passphrase (only for this host).");
    return 1;
  }
  const hostName = checkHost(await ask("cPanel SSH host (for example server123.example-host.com): "));
  const user = checkUser(await ask("cPanel user name: "));
  const port = parsePort(await ask("SSH port [22]: "));
  const domain = checkDomain((await ask("Domain [contracting.bid]: ")).trim() || "contracting.bid");

  const scan = await deps.exec("ssh-keyscan", ["-p", String(port), "-t", "ed25519,ecdsa,rsa", hostName]);
  const knownHosts = knownHostsLines(scan.stdout);
  if (!knownHosts) {
    out(`Could not read ${hostName}'s host key: ${scan.stderr.trim()}`);
    return 1;
  }
  const knownFile = join(sshDir, "contracting-bid-cpanel-known_hosts");
  await deps.writeFile(knownFile, knownHosts);
  const prints = await deps.exec("ssh-keygen", ["-l", "-f", knownFile]);
  out(`${hostName}'s host key fingerprints:\n${prints.stdout.trim()}`);
  out("Compare them with the ones your host shows (cPanel > SSH Access, or ask support) before going on.");
  if (!/^y(es)?$/i.test((await ask("Do they match? [y/N] ")).trim())) return 2;

  const ssh: SshTarget = { host: hostName, user, port, keyFile, knownHostsFile: knownFile };
  const host = new Host(deps, ssh);
  const roots = await host.domainRoots();
  out(`Connected. Domains on the account: ${roots.map((r) => r.domain).join(", ")}`);
  if (!rootFor(roots, domain)) {
    out(`${domain} is not on this account. Check the user name.`);
    return 1;
  }

  const remote = await deps.exec("git", ["remote", "get-url", "origin"]);
  const repo = repoFromRemote(remote.stdout) ?? (await ask("GitHub repository (owner/name): ")).trim();
  const plan = githubPlan({ host: hostName, user, port, domain }, keyFile, knownHosts);
  out(`\nThis stores, in ${repo} on GitHub:`);
  for (const v of plan) out(`  ${v.kind === "secret" ? "secret  " : "variable"} ${v.name.padEnd(20)} ${v.shown}`);
  if (!/^y(es)?$/i.test((await ask("Store them? [y/N] ")).trim())) {
    out("Nothing was stored.");
    return 2;
  }
  for (const v of plan) {
    const input = v.fromFile ? await deps.readFile(v.fromFile) : v.value!;
    const r = await deps.execInput("gh", ghSetArgv(v, repo), input);
    if (r.code !== 0) {
      out(`gh could not store ${v.name}: ${r.stderr.trim()}`);
      return 1;
    }
    out(`Stored ${v.name}.`);
  }
  out("\nDone. Next: on GitHub, Actions > cPanel provision > Run workflow (apply: true). See docs/CPANEL.md.");
  return 0;
}

/** `pnpm cpanel ...`. Returns the exit code. */
export async function main(argv: string[], partial: Partial<CpanelDeps> = {}): Promise<number> {
  const out = partial.out ?? ((l: string) => console.log(l));
  const args = parseCpanelArgs(argv);
  if (!args) {
    out(CPANEL_USAGE);
    return argv.length === 0 || argv[0] === "help" ? 0 : 2;
  }
  let rl: ReturnType<typeof createInterface> | undefined;
  const deps: CpanelDeps = {
    exec: spawnExec,
    execInput: (cmd, a, input) => spawnInput(cmd, a, input),
    get: fetchGet,
    out,
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    ask: async (q) => {
      rl ??= createInterface({ input: process.stdin, output: process.stdout });
      return rl.question(q);
    },
    env: process.env,
    readdir: (d) => readdir(d),
    readFile: (p) => readFile(p, "utf8"),
    writeFile: (p, t) => writeFile(p, t, { mode: 0o600 }),
    mkdir: async (d) => void (await mkdir(d, { recursive: true })),
    resolveHost: (h) => lookup(h).then((r) => r.address, () => null),
    autosslWaitMs: 10 * 60_000,
    ...partial,
  };
  try {
    switch (args.command) {
      case "setup":
        return await setup(deps);
      case "window":
        return windowCheck(deps);
      case "stamp":
        return await stamp(deps, args.target!, args.dir!, args.commit!);
      case "check":
        return (await checkTarget(deps, args.target!, args.commit)) ? 0 : 1;
      default: {
        const host = new Host(deps, sshTargetFromEnv(deps.env));
        if (args.command === "provision") return await provision(deps, host, args.apply);
        if (args.command === "rollback") return await rollback(deps, host, args.target!, args.backup);
        return await deploy(deps, host, { target: args.target!, dir: args.dir!, commit: args.commit!, dryRun: args.dryRun, replaceExisting: args.replaceExisting });
      }
    }
  } catch (err) {
    out(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    rl?.close();
  }
}

async function spawnInput(cmd: string, args: string[], input: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const { spawn } = await import("node:child_process");
  return new Promise((done) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", (err) => done({ code: 127, stdout, stderr: err.message }));
    child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}

// Run when invoked directly: node dist/src/cli/cpanel.js check staging
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  loadDotEnv();
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
