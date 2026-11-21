import type { MetadataRoute } from 'next';

/** Private screens that search engines should never index, on any site. */
export const PRIVATE_PATHS = ['/app', '/onboarding', '/reset', '/trial-ended'];

/**
 * robots.txt rules for a build. Staging (`CB_SITE_ENV=staging`) blocks every crawler so the
 * test copy never shows up in search results; every other build blocks only the private screens.
 */
export function robotsRules(siteEnv: string | undefined): MetadataRoute.Robots {
  if ((siteEnv ?? '').trim().toLowerCase() === 'staging') {
    return { rules: [{ userAgent: '*', disallow: '/' }] };
  }
  return { rules: [{ userAgent: '*', allow: '/', disallow: PRIVATE_PATHS }] };
}
