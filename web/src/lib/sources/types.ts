// The shapes that flow from data providers to the screen. A provider returns raw listings or awards;
// the aggregator stamps each with the provider's name, and the ranking adds `fit` and `miles`.
import type { Award, Listing, ListingFit } from '@/design/cb';

export type { Award, Listing, ListingFit };

/** Which governments a record belongs to. Providers declare the levels they cover. */
export type Level = 'federal' | 'local';

export interface GeoPoint {
  lat: number;
  lon: number;
}

/** What the contractor told us in Settings, plus where they are. Drives which listings are best fits. */
export interface Preferences {
  /** Trades the contractor performs or manages. Empty means no trade filter. */
  trades: string[];
  /** How far they will travel, in miles. `null` means anywhere. */
  radiusMiles: number | null;
  /** Largest single job they can bond, in dollars. `null` means no limit. */
  bondingLimitUsd: number | null;
  /** Where distances are measured from. `null` means distance is not considered. */
  location: GeoPoint | null;
}

/** A listing before ranking: what a provider knows about an open project. */
export type RawListing = Omit<Listing, 'fit' | 'miles' | 'source' | 'awards'>;

/** An award before it is stamped with its source. */
export type RawAward = Omit<Award, 'source'>;

/** A source of open projects, such as SAM.gov. */
export interface ListingProvider {
  /** Shown to the user as where a listing came from. */
  readonly name: string;
  readonly levels: readonly Level[];
  listings(): Promise<RawListing[]>;
}

/** A source of earlier awards for a project, such as USAspending.gov. */
export interface AwardProvider {
  /** Shown to the user beside each award. */
  readonly name: string;
  readonly levels: readonly Level[];
  awardsFor(listing: RawListing): Promise<RawAward[]>;
}

/** A provider that failed, so the screen can say what is missing instead of silently showing less. */
export interface ProviderFailure {
  provider: string;
  message: string;
}
