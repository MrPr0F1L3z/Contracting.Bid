/**
 * The dashboard's fonts, served from this machine so the page makes no
 * third-party requests. The files come from the @fontsource packages; if one
 * is missing the page falls back to system fonts.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/** URL name → file inside its @fontsource package. Only these names are ever served. */
export const DASHBOARD_FONTS: Readonly<Record<string, string>> = {
  "archivo-600.woff2": "@fontsource/archivo/files/archivo-latin-600-normal.woff2",
  "archivo-700.woff2": "@fontsource/archivo/files/archivo-latin-700-normal.woff2",
  "archivo-800.woff2": "@fontsource/archivo/files/archivo-latin-800-normal.woff2",
  "plex-sans-400.woff2": "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2",
  "plex-sans-500.woff2": "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-500-normal.woff2",
  "plex-sans-600.woff2": "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2",
  "plex-mono-500.woff2": "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2",
};

const require = createRequire(import.meta.url);
const cache = new Map<string, Buffer | null>();

/** The bytes of a dashboard font, or null when the name is not one of ours or the file cannot be read. */
export function fontFile(name: string, resolve: (id: string) => string = require.resolve): Buffer | null {
  if (!Object.hasOwn(DASHBOARD_FONTS, name)) return null;
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  let bytes: Buffer | null;
  try {
    bytes = readFileSync(resolve(DASHBOARD_FONTS[name]!));
  } catch {
    bytes = null;
  }
  cache.set(name, bytes);
  return bytes;
}

/** Forgets cached files. For tests. */
export function clearFontCache(): void {
  cache.clear();
}
