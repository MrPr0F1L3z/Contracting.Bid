/**
 * `pnpm cpanel setup`, run once on the owner's machine: picks the deploy key in ~/.ssh, checks it
 * reaches the cPanel host, and (only after the owner says yes) stores what GitHub Actions needs as
 * repository secrets with `gh secret set`. The key goes to gh on stdin; it is never printed,
 * written anywhere else, or put on a command line.
 */

/** Private keys in a folder listing whose names contain "deploy" (not .pub, known_hosts or config). */
export function deployKeyCandidates(fileNames: readonly string[]): string[] {
  return fileNames
    .filter((n) => /deploy/i.test(n))
    .filter((n) => !/\.(pub|old|bak|ppk)$/i.test(n) && !/^(known_hosts|config|authorized_keys)/i.test(n))
    .sort();
}

/** Whether a file's first line looks like an OpenSSH or PEM private key. */
export function looksLikePrivateKey(firstLine: string): boolean {
  return /^-----BEGIN (OPENSSH|RSA|EC|DSA)? ?PRIVATE KEY-----/.test(firstLine.trim());
}

export interface CpanelSettings {
  host: string;
  user: string;
  port: number;
  domain: string;
}

/** Checks a hostname or IP address for the cPanel host. */
export function checkHost(host: string): string {
  const h = host.trim();
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(h) || h.startsWith("-")) throw new Error(`"${host}" is not a host name or IP address`);
  return h;
}

/** Checks a cPanel user name. */
export function checkUser(user: string): string {
  const u = user.trim();
  if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(u)) throw new Error(`"${user}" is not a cPanel user name`);
  return u;
}

/** A secret or variable the setup stores in GitHub. `fromFile` values are sent from a file on stdin. */
export interface GithubValue {
  kind: "secret" | "variable";
  name: string;
  /** Shown to the owner before anything is stored. Never the value of a secret. */
  shown: string;
  value?: string;
  fromFile?: string;
}

/** Everything the setup will store, for the owner to look over first. */
export function githubPlan(s: CpanelSettings, keyFile: string, knownHosts: string): GithubValue[] {
  return [
    { kind: "secret", name: "CPANEL_SSH_KEY", shown: `the private key in ${keyFile}`, fromFile: keyFile },
    { kind: "secret", name: "CPANEL_KNOWN_HOSTS", shown: `the host key(s) of ${s.host}, as checked above`, value: knownHosts },
    { kind: "secret", name: "CPANEL_HOST", shown: s.host, value: s.host },
    { kind: "secret", name: "CPANEL_USER", shown: s.user, value: s.user },
    { kind: "secret", name: "CPANEL_PORT", shown: String(s.port), value: String(s.port) },
    { kind: "variable", name: "CPANEL_DOMAIN", shown: s.domain, value: s.domain },
    { kind: "variable", name: "CPANEL_ENABLED", shown: "true (turns the deploy workflows on)", value: "true" },
  ];
}

/** argv for gh to store one value. The value itself goes on stdin. */
export function ghSetArgv(v: GithubValue, repo: string): string[] {
  return [v.kind, "set", v.name, "--repo", repo];
}

/** Reads owner/name from a git remote URL (https or ssh). Returns null for anything else. */
export function repoFromRemote(url: string): string | null {
  const m = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Keeps only the host key lines from ssh-keyscan output (drops its # comments). */
export function knownHostsLines(keyscan: string): string {
  const lines = keyscan
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .filter((l) => /^\S+\s+(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+|sk-\S+)\s+\S+/.test(l));
  return lines.length ? `${lines.join("\n")}\n` : "";
}
