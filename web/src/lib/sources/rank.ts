// Decides which listings are best fits for a contractor and puts those first.
// Nothing is hidden: a listing that misses a setting is still shown, after the best fits, with the reason.
import { distanceMiles } from './geo';
import type { Listing, ListingFit, Preferences } from './types';

const usd = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;
const sameTrade = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

export interface Assessment {
  fit: ListingFit;
  /** Whole miles from the contractor, when both ends are known. */
  miles?: number;
}

/**
 * Checks one listing against the contractor's settings and location.
 * A listing is a best fit when it misses none of the settings that apply.
 * A fact the listing does not state (no trade, no place, no value) is not held against it.
 */
export function assessListing(listing: Pick<Listing, 'trade' | 'place' | 'value'>, prefs: Preferences): Assessment {
  const reasons: string[] = [];

  if (prefs.trades.length > 0 && listing.trade && !prefs.trades.some((t) => sameTrade(t, listing.trade!))) {
    reasons.push(`${listing.trade} is not one of your trades`);
  }

  const exact = prefs.location ? distanceMiles(prefs.location, listing.place) : null;
  const miles = exact === null ? undefined : Math.round(exact);
  if (miles !== undefined && prefs.radiusMiles !== null && miles > prefs.radiusMiles) {
    reasons.push(`${miles} miles away, past your ${prefs.radiusMiles}`);
  }

  if (prefs.bondingLimitUsd !== null && typeof listing.value === 'number' && listing.value > prefs.bondingLimitUsd) {
    reasons.push(`Over your ${usd(prefs.bondingLimitUsd)} bonding limit`);
  }

  return { fit: { ideal: reasons.length === 0, reasons }, ...(miles === undefined ? {} : { miles }) };
}

/**
 * Stamps every listing with its fit and distance, then orders them: best fits first, the rest after.
 * Inside each group the stronger match comes first, then the nearer one, then the original order.
 */
export function rankListings<T extends Listing>(listings: readonly T[], prefs: Preferences): T[] {
  return listings
    .map((listing, index) => ({ listing: { ...listing, ...assessListing(listing, prefs) } as T, index }))
    .sort((a, b) => {
      const byFit = Number(b.listing.fit!.ideal) - Number(a.listing.fit!.ideal);
      if (byFit) return byFit;
      const byMatch = (b.listing.match ?? 0) - (a.listing.match ?? 0);
      if (byMatch) return byMatch;
      const byDistance = (a.listing.miles ?? Infinity) - (b.listing.miles ?? Infinity);
      if (byDistance) return byDistance;
      return a.index - b.index;
    })
    .map((x) => x.listing);
}
