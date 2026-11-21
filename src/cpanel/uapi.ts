/**
 * cPanel's UAPI, as run over SSH by the account's own user (`uapi --output=json Module func k=v`).
 * Everything here only builds commands and reads their JSON replies; running them is up to the
 * caller (src/cli/cpanel.ts), so it can all be tested without a server.
 */

/** A UAPI call: module, function and arguments. */
export interface UapiCall {
  module: string;
  func: string;
  args?: Record<string, string>;
}

/** The argv for a call, run with no shell on the server's side beyond ssh's own. */
export function uapiArgv(call: UapiCall): string[] {
  const args = Object.entries(call.args ?? {}).map(([k, v]) => {
    if (!/^[a-z_]+$/i.test(k) || !/^[A-Za-z0-9._\-/]*$/.test(v)) throw new Error(`Unsafe UAPI argument ${k}=${v}`);
    return `${k}=${v}`;
  });
  return ["uapi", "--output=json", call.module, call.func, ...args];
}

/** Reads a UAPI JSON reply. Throws with cPanel's own error text when the call failed. */
export function parseUapi<T = unknown>(stdout: string, what: string): T {
  let reply: unknown;
  try {
    reply = JSON.parse(stdout);
  } catch {
    throw new Error(`${what}: cPanel did not answer with JSON. Output: ${stdout.slice(0, 300)}`);
  }
  const result = (reply as { result?: { status?: number; data?: unknown; errors?: unknown } }).result;
  if (!result) throw new Error(`${what}: unexpected reply from cPanel: ${stdout.slice(0, 300)}`);
  if (result.status !== 1) {
    const errors = Array.isArray(result.errors) ? result.errors.join("; ") : String(result.errors ?? "unknown error");
    throw new Error(`${what}: cPanel said: ${errors}`);
  }
  return result.data as T;
}

/** Every domain on the account with its document root, in one call. */
export const DOMAINS_DATA: UapiCall = { module: "DomainInfo", func: "domains_data", args: { format: "list" } };

export interface DomainRoot {
  domain: string;
  /** main, addon, sub or parked. */
  type: string;
  /** Absolute path with no trailing slash. */
  documentRoot: string;
}

const SAFE_PATH = /^\/[A-Za-z0-9._\-/]+$/;

/** Checks a server path before it goes into a command. Throws on anything unusual. */
export function checkRemotePath(path: string, what: string): string {
  const p = path.replace(/\/+$/, "");
  if (!SAFE_PATH.test(p) || p.split("/").includes("..") || p.split("/").length < 3) {
    throw new Error(`${what}: refusing to use the server path "${path}"`);
  }
  return p;
}

/** Reads a domains_data reply (list or hash format) into one list of domains and their roots. */
export function parseDomainRoots(data: unknown): DomainRoot[] {
  const entries: { domain?: unknown; documentroot?: unknown; type?: unknown }[] = [];
  const collect = (v: unknown, type: string) => {
    if (Array.isArray(v)) v.forEach((e) => entries.push({ ...(e as object), type: (e as { type?: unknown }).type ?? type }));
    else if (v && typeof v === "object") entries.push({ ...(v as object), type: (v as { type?: unknown }).type ?? type });
  };
  if (Array.isArray(data)) collect(data, "unknown");
  else if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    collect(d.main_domain, "main_domain");
    collect(d.addon_domains, "addon_domain");
    collect(d.sub_domains, "sub_domain");
    collect(d.parked_domains, "parked_domain");
  }
  return entries
    .filter((e) => typeof e.domain === "string" && typeof e.documentroot === "string")
    .map((e) => ({
      domain: (e.domain as string).toLowerCase(),
      type: String(e.type).replace(/_domains?$/, ""),
      documentRoot: (e.documentroot as string).replace(/\/+$/, ""),
    }));
}

/** The document root that serves `host`. A www. name is served from its bare domain's root. */
export function rootFor(roots: readonly DomainRoot[], host: string): string | null {
  const h = host.toLowerCase();
  const found = roots.find((r) => r.domain === h) ?? (h.startsWith("www.") ? roots.find((r) => r.domain === h.slice(4)) : undefined);
  return found ? found.documentRoot : null;
}

/**
 * Folders inside `root` that belong to other domains, as paths relative to `root` ("staging/").
 * A deploy must leave them alone, or a live deploy would delete a subdomain that lives inside it.
 */
export function nestedRoots(roots: readonly DomainRoot[], root: string): string[] {
  const prefix = `${root}/`;
  const nested = roots.filter((r) => r.documentRoot.startsWith(prefix)).map((r) => `${r.documentRoot.slice(prefix.length)}/`);
  return [...new Set(nested)].sort();
}

/**
 * The call that creates staging.<root> with its own folder in the home folder
 * (~/staging.<root>), outside the live site's folder so a live deploy can never touch it.
 */
export function addSubdomainCall(label: string, rootDomain: string): UapiCall {
  return { module: "SubDomain", func: "addsubdomain", args: { domain: label, rootdomain: rootDomain, dir: `${label}.${rootDomain}`, disallowdot: "1" } };
}

export const START_AUTOSSL: UapiCall = { module: "SSL", func: "start_autossl_check" };
export const AUTOSSL_IN_PROGRESS: UapiCall = { module: "SSL", func: "is_autossl_check_in_progress" };
export const INSTALLED_HOSTS: UapiCall = { module: "SSL", func: "installed_hosts" };

/** Whether an is_autossl_check_in_progress reply says a check is still running. */
export function autosslRunning(data: unknown): boolean {
  if (typeof data === "number" || typeof data === "boolean") return Boolean(data);
  if (typeof data === "string") return data === "1";
  return Boolean((data as { in_progress?: unknown } | null)?.in_progress);
}

export interface CertCoverage {
  host: string;
  /** The certificate's end, or null when no installed certificate covers the host. */
  notAfter: Date | null;
  issuer: string | null;
  /** Whether it is self-signed (browsers will refuse it). */
  selfSigned: boolean;
}

function certCovers(names: readonly string[], host: string): boolean {
  const h = host.toLowerCase();
  return names.some((n) => {
    const name = n.toLowerCase();
    if (name === h) return true;
    // *.contracting.bid covers one label: staging.contracting.bid, not contracting.bid itself.
    return name.startsWith("*.") && h.endsWith(name.slice(1)) && !h.slice(0, -name.length + 1).includes(".");
  });
}

interface InstalledHost {
  certificate?: { domains?: string[]; not_after?: number | string; is_self_signed?: number | boolean; "issuer.organizationName"?: string; issuer_text?: string };
}

/** For each host, the installed certificate that covers it for longest (from an installed_hosts reply). */
export function certCoverage(data: unknown, hosts: readonly string[]): CertCoverage[] {
  const installed = Array.isArray(data) ? (data as InstalledHost[]) : [];
  return hosts.map((host) => {
    let best: CertCoverage = { host, notAfter: null, issuer: null, selfSigned: false };
    for (const entry of installed) {
      const cert = entry.certificate;
      if (!cert || !certCovers(cert.domains ?? [], host)) continue;
      const notAfter = new Date(Number(cert.not_after) * 1000);
      if (Number.isNaN(notAfter.getTime())) continue;
      const selfSigned = Boolean(Number(cert.is_self_signed ?? 0));
      const better = !best.notAfter || (best.selfSigned && !selfSigned) || (best.selfSigned === selfSigned && notAfter > best.notAfter);
      if (better) best = { host, notAfter, issuer: cert["issuer.organizationName"] ?? cert.issuer_text ?? null, selfSigned };
    }
    return best;
  });
}

/** Whether a host's coverage is a trusted certificate valid for at least `minDays` more days. */
export function certOk(c: CertCoverage, now: Date, minDays = 7): boolean {
  return c.notAfter !== null && !c.selfSigned && c.notAfter.getTime() - now.getTime() >= minDays * 86_400_000;
}
