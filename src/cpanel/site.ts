/**
 * The customer site (web/) on the cPanel host: which hostnames each target serves, and the
 * Apache rules that go with each build. See docs/CPANEL.md.
 */

export type Target = "staging" | "production";

export interface SiteTarget {
  target: Target;
  /** The hostname the site is served on. */
  host: string;
  /** Hostnames that redirect to `host` (production: the bare domain). */
  redirectHosts: string[];
  /** Every hostname that needs a valid certificate. */
  certHosts: string[];
  /** Whether search engines may index it. */
  indexable: boolean;
}

/** Checks a domain name such as contracting.bid. Throws on anything else. */
export function checkDomain(domain: string): string {
  const d = domain.trim().toLowerCase();
  if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d)) {
    throw new Error(`"${domain}" is not a domain name such as contracting.bid`);
  }
  return d;
}

/** The hostnames for a target on `domain`. */
export function siteTarget(target: Target, domain: string): SiteTarget {
  const d = checkDomain(domain);
  if (target === "staging") {
    const host = `staging.${d}`;
    return { target, host, redirectHosts: [], certHosts: [host], indexable: false };
  }
  return { target, host: `www.${d}`, redirectHosts: [d], certHosts: [`www.${d}`, d], indexable: true };
}

/** Parses "staging" or "production" (also "prod"). Returns null for anything else. */
export function parseTarget(word: string | undefined): Target | null {
  if (word === "staging") return "staging";
  if (word === "production" || word === "prod") return "production";
  return null;
}

function regexHost(host: string): string {
  return host.replace(/\./g, "\\.");
}

/**
 * The .htaccess for a target's document root. It sends every request that is not HTTPS on the
 * target's own hostname (production: the bare domain, and plain http) to
 * https://<host> with the same path and query, in one 301. Certificate checks under
 * /.well-known/ are left alone so AutoSSL can renew. Staging also tells crawlers not to index.
 */
export function htaccess(site: SiteTarget): string {
  const lines = [
    "# Written by the deploy pipeline (pnpm cpanel deploy). Do not edit on the server:",
    "# change src/cpanel/site.ts and deploy again.",
    "Options -Indexes",
    "DirectoryIndex index.html",
    "ErrorDocument 404 /404.html",
    "",
    "<IfModule mod_rewrite.c>",
    "RewriteEngine On",
    "# AutoSSL / Let's Encrypt domain checks must reach the files they place here.",
    "RewriteRule ^\\.well-known/ - [L]",
    `# Anything that is not https://${site.host} goes there, keeping the path and query.`,
    `RewriteCond %{HTTP_HOST} !^${regexHost(site.host)}$ [NC,OR]`,
    "RewriteCond %{HTTPS} !=on",
    `RewriteRule ^ https://${site.host}%{REQUEST_URI} [R=301,L,NE]`,
    "</IfModule>",
    "",
    "<IfModule mod_headers.c>",
    "# Plain http never gets this far (it is redirected above), so HSTS can be set on every reply.",
    'Header always set Strict-Transport-Security "max-age=31536000"',
    'Header always set X-Content-Type-Options "nosniff"',
    'Header always set Referrer-Policy "strict-origin-when-cross-origin"',
    'Header always set X-Frame-Options "SAMEORIGIN"',
    ...(site.indexable ? [] : ['Header always set X-Robots-Tag "noindex, nofollow"']),
    '<FilesMatch "\\.html$">',
    'Header set Cache-Control "no-cache"',
    "</FilesMatch>",
    "</IfModule>",
    "",
  ];
  return lines.join("\n");
}

/**
 * The .htaccess for _next/static/. Next.js puts a content hash in every file name there, so a
 * file never changes and browsers may keep it for a year. A file of its own (rather than an
 * <If> block in the root one) works on Apache and LiteSpeed alike.
 */
export function staticAssetsHtaccess(): string {
  return [
    "# Written by the deploy pipeline. Built assets have content hashes in their names.",
    "<IfModule mod_headers.c>",
    'Header set Cache-Control "public, max-age=31536000, immutable"',
    "</IfModule>",
    "",
  ].join("\n");
}

/** What /build.txt holds, so a check can tell which commit a host serves. */
export interface BuildStamp {
  commit: string;
  target: Target;
  builtAt: string;
}

export function buildStampText(stamp: BuildStamp): string {
  return `commit=${stamp.commit}\ntarget=${stamp.target}\nbuilt=${stamp.builtAt}\n`;
}

/** Reads /build.txt back. Returns null when it is not a stamp. */
export function parseBuildStamp(text: string): BuildStamp | null {
  const fields = Object.fromEntries(
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  const target = parseTarget(fields.target);
  if (!fields.commit || !target || !fields.built) return null;
  return { commit: fields.commit, target, builtAt: fields.built };
}
