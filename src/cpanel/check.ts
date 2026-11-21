/**
 * Checks run against the live hostnames after a deploy (and on their own with `pnpm cpanel check`):
 * the redirects, HTTPS with a trusted certificate, the right build, robots rules and the 404 page.
 * A plain fetch refuses an untrusted or expired certificate, so every https check also proves the
 * certificate is good.
 */
import { parseBuildStamp, type SiteTarget } from "./site.js";

export interface HttpReply {
  status: number;
  header(name: string): string | null;
  text(): Promise<string>;
}

/** Fetches a URL without following redirects. */
export type HttpGet = (url: string) => Promise<HttpReply>;

export interface Check {
  name: string;
  url: string;
  status: number;
  /** For a redirect: exactly where it must point. */
  location?: string;
  /** A header that must contain this text (case-insensitive). */
  header?: { name: string; includes: string };
  /** Text the body must contain. */
  bodyIncludes?: string;
  /** The commit /build.txt must name. */
  commit?: string;
}

/** Every check for a target. `commit` adds a check that the host serves that build. */
export function checksFor(site: SiteTarget, commit?: string): Check[] {
  const home = `https://${site.host}/`;
  const checks: Check[] = [];
  for (const from of [...site.redirectHosts.flatMap((h) => [`http://${h}`, `https://${h}`]), `http://${site.host}`]) {
    checks.push({ name: `${from}/ redirects to ${home}`, url: `${from}/pricing/?from=check`, status: 301, location: `${home}pricing/?from=check` });
  }
  checks.push({ name: `${home} answers over HTTPS`, url: home, status: 200, bodyIncludes: "Contracting.Bid" });
  if (site.indexable) {
    checks.push({ name: "robots.txt keeps private screens out", url: `${home}robots.txt`, status: 200, bodyIncludes: "Disallow: /app" });
  } else {
    checks.push({ name: "robots.txt blocks every crawler", url: `${home}robots.txt`, status: 200, bodyIncludes: "Disallow: /\n" });
    checks.push({ name: "pages say noindex", url: home, status: 200, header: { name: "x-robots-tag", includes: "noindex" } });
  }
  checks.push({ name: "unknown pages get the 404 page", url: `${home}no-such-page-check/`, status: 404 });
  if (commit) checks.push({ name: `serves build ${commit.slice(0, 12)}`, url: `${home}build.txt`, status: 200, commit });
  return checks;
}

export interface CheckResult {
  check: Check;
  ok: boolean;
  detail: string;
}

/** Runs one check. Never throws: a failed connection is a failed check. */
export async function runCheck(get: HttpGet, check: Check): Promise<CheckResult> {
  let reply: HttpReply;
  try {
    reply = await get(check.url);
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    return { check, ok: false, detail: `could not connect: ${cause?.code ?? cause?.message ?? (err as Error).message}` };
  }
  const fail = (detail: string) => ({ check, ok: false, detail });
  if (reply.status !== check.status) {
    const where = reply.header("location");
    return fail(`expected ${check.status}, got ${reply.status}${where ? ` to ${where}` : ""}`);
  }
  if (check.location !== undefined && reply.header("location") !== check.location) {
    return fail(`redirects to ${reply.header("location") ?? "nowhere"}, expected ${check.location}`);
  }
  if (check.header) {
    const value = reply.header(check.header.name) ?? "";
    if (!value.toLowerCase().includes(check.header.includes.toLowerCase())) return fail(`${check.header.name} is "${value}"`);
  }
  if (check.bodyIncludes !== undefined || check.commit !== undefined) {
    const body = await reply.text();
    if (check.bodyIncludes !== undefined && !body.replace(/\r\n/g, "\n").concat("\n").includes(check.bodyIncludes)) {
      return fail(`the page does not contain ${JSON.stringify(check.bodyIncludes)}`);
    }
    if (check.commit !== undefined) {
      const stamp = parseBuildStamp(body);
      if (!stamp) return fail("build.txt is missing or unreadable");
      if (stamp.commit !== check.commit) return fail(`serves ${stamp.commit}, expected ${check.commit}`);
    }
  }
  return { check, ok: true, detail: "ok" };
}

/** Runs every check, retrying failures (`attempts` in all, `waitMs` apart). */
export async function runChecks(
  get: HttpGet,
  checks: readonly Check[],
  opts: { attempts?: number; waitMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<CheckResult[]> {
  const attempts = opts.attempts ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const results: CheckResult[] = [];
  for (const check of checks) {
    let result = await runCheck(get, check);
    for (let i = 1; i < attempts && !result.ok; i++) {
      await sleep(opts.waitMs ?? 5000);
      result = await runCheck(get, check);
    }
    results.push(result);
  }
  return results;
}

/** The real HttpGet: Node's fetch, no redirects followed, 15 second limit. */
export const fetchGet: HttpGet = async (url) => {
  const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000), headers: { "user-agent": "contracting-bid-deploy-check" } });
  return { status: res.status, header: (n) => res.headers.get(n), text: () => res.text() };
};
