import { collectListings, type Aggregated } from './aggregate';
import { SAMPLE_PREFERENCES } from './preferences';
import { AWARD_PROVIDERS, LISTING_PROVIDERS } from './providers';
import type { Preferences } from './types';

/** The listings for Find work: every provider, each record naming its source, best fits first. */
export function loadListings(prefs: Preferences = SAMPLE_PREFERENCES): Promise<Aggregated> {
  return collectListings(prefs, LISTING_PROVIDERS, AWARD_PROVIDERS);
}

export * from './types';
export { collectListings } from './aggregate';
export { assessListing, rankListings } from './rank';
export { distanceMiles } from './geo';
export { SAMPLE_PREFERENCES, parseBondingLimit, parseRadius } from './preferences';
export { AWARD_PROVIDERS, LISTING_PROVIDERS, stubAwardProvider, stubListingProvider } from './providers';
