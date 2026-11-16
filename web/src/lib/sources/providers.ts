// The providers the app uses today. Every one is a STUB that serves the design system's sample
// records, so the screens can be built and tested before any contract or API key exists.
//
// To connect a real service, write an object with the same shape (see ListingProvider and
// AwardProvider in ./types) that calls the service, and swap it into the lists at the bottom.
// Nothing else changes: the aggregator names the source on each record and the ranking is the same.
// The sample records as JSON: the components are a client-side module, so their values can't be imported on the server.
import sampleListings from '@/design/sample-listings.json';
import type { AwardProvider, Level, ListingProvider, RawAward, RawListing } from './types';

type SampleListing = RawListing & { awards?: Array<RawAward & { source?: string }> };
const SAMPLE = sampleListings as readonly SampleListing[];

function strip(l: SampleListing): RawListing {
  // Drop what the aggregator and ranking are responsible for, so the stubs prove those steps work.
  const { awards: _awards, ...rest } = l as SampleListing & { fit?: unknown; miles?: unknown; source?: unknown };
  const { fit: _fit, miles: _miles, source: _source, ...raw } = rest as typeof rest & { fit?: unknown; miles?: unknown; source?: unknown };
  return raw as RawListing;
}

export function stubListingProvider(name: string, levels: readonly Level[]): ListingProvider {
  return {
    name,
    levels,
    listings: async () => SAMPLE.filter((l) => levels.includes(l.level ?? 'local')).map(strip),
  };
}

export function stubAwardProvider(name: string, levels: readonly Level[]): AwardProvider {
  return {
    name,
    levels,
    awardsFor: async (listing) => {
      if (!levels.includes(listing.level ?? 'local')) return [];
      const found = SAMPLE.find((l) => l.id === listing.id);
      return (found?.awards ?? []).map(({ source: _source, ...award }) => award);
    },
  };
}

/** Open projects. SAM.gov for federal work; the state and local feed is not chosen yet. */
export const LISTING_PROVIDERS: readonly ListingProvider[] = [
  stubListingProvider('SAM.gov', ['federal']),
  stubListingProvider('State and local feed', ['local']),
];

/** Earlier awards. USAspending.gov for federal work; the state and local feed is not chosen yet. */
export const AWARD_PROVIDERS: readonly AwardProvider[] = [
  stubAwardProvider('USAspending.gov', ['federal']),
  stubAwardProvider('State and local feed', ['local']),
];
