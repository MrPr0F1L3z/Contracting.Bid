// Pulls listings and their award history from every provider, names the source on each record,
// and ranks the result for one contractor. One provider failing never empties the screen.
import { rankListings } from './rank';
import type { Award, AwardProvider, Listing, ListingProvider, Preferences, ProviderFailure, RawListing } from './types';

export interface Aggregated {
  listings: Listing[];
  failures: ProviderFailure[];
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const covers = (provider: { levels: readonly string[] }, listing: RawListing): boolean => provider.levels.includes(listing.level ?? 'local');

/** The same project listed by two providers is shown once, from the provider that comes first. */
function dedupe(listings: Listing[]): Listing[] {
  const seen = new Set<string>();
  return listings.filter((l) => (seen.has(l.id) ? false : (seen.add(l.id), true)));
}

async function awardsFor(listing: RawListing, providers: readonly AwardProvider[], failures: ProviderFailure[]): Promise<Award[]> {
  const relevant = providers.filter((p) => covers(p, listing));
  const results = await Promise.allSettled(relevant.map((p) => p.awardsFor(listing)));
  return results.flatMap((r, i) => {
    const provider = relevant[i]!;
    if (r.status === 'rejected') {
      if (!failures.some((f) => f.provider === provider.name)) failures.push({ provider: provider.name, message: message(r.reason) });
      return [];
    }
    return r.value.map((a) => ({ ...a, source: provider.name }));
  });
}

export async function collectListings(
  prefs: Preferences,
  listingProviders: readonly ListingProvider[],
  awardProviders: readonly AwardProvider[],
): Promise<Aggregated> {
  const failures: ProviderFailure[] = [];
  const results = await Promise.allSettled(listingProviders.map((p) => p.listings()));
  const raw: Array<RawListing & { source: string }> = results.flatMap((r, i) => {
    const provider = listingProviders[i]!;
    if (r.status === 'rejected') {
      failures.push({ provider: provider.name, message: message(r.reason) });
      return [];
    }
    return r.value.map((l) => ({ ...l, source: provider.name }));
  });

  const withAwards = await Promise.all(
    dedupe(raw).map(async (l): Promise<Listing> => {
      const awards = await awardsFor(l, awardProviders, failures);
      return awards.length ? { ...l, awards } : l;
    }),
  );
  return { listings: rankListings(withAwards, prefs), failures };
}
