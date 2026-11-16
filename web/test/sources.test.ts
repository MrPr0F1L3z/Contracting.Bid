import { describe, expect, test } from 'vitest';
import sampleListings from '../src/design/sample-listings.json';
import {
  AWARD_PROVIDERS, LISTING_PROVIDERS, SAMPLE_PREFERENCES, assessListing, collectListings, distanceMiles, loadListings, parseBondingLimit, parseRadius,
  rankListings, stubAwardProvider, stubListingProvider,
  type AwardProvider, type Listing, type ListingProvider, type Preferences, type RawListing,
} from '../src/lib/sources';

const home = { lat: 40, lon: -105 };
const prefs: Preferences = { trades: ['HVAC', 'Paving'], radiusMiles: 50, bondingLimitUsd: 750_000, location: home };
const anywhere: Preferences = { trades: [], radiusMiles: null, bondingLimitUsd: null, location: null };
const listing = (over: Partial<Listing> = {}): Listing => ({ id: 'x', title: 'Job', owner: 'Agency', value: 100_000, trade: 'HVAC', place: { lat: 40.1, lon: -105 }, ...over });

describe('distanceMiles', () => {
  test('measures great-circle distance', () => {
    expect(distanceMiles(home, home)).toBe(0);
    expect(distanceMiles(home, { lat: 41, lon: -105 })).toBeCloseTo(69.1, 0); // one degree of latitude
    expect(distanceMiles({ lat: 40.7128, lon: -74.006 }, { lat: 34.0522, lon: -118.2437 })).toBeCloseTo(2446, -1); // New York to Los Angeles
    expect(distanceMiles(home, { lat: 41, lon: -105 })).toBe(distanceMiles({ lat: 41, lon: -105 }, home));
  });

  test('is null for a missing or impossible point', () => {
    for (const bad of [null, undefined, {}, { lat: 91, lon: 0 }, { lat: 0, lon: 181 }, { lat: '40', lon: -105 }, { lat: NaN, lon: 0 }]) {
      expect(distanceMiles(home, bad)).toBeNull();
      expect(distanceMiles(bad, home)).toBeNull();
    }
  });
});

describe('assessListing', () => {
  test('a listing inside every setting is a best fit, with its distance', () => {
    expect(assessListing(listing(), prefs)).toEqual({ fit: { ideal: true, reasons: [] }, miles: 7 });
  });

  test('names each setting a listing misses, in a fixed order', () => {
    const far = assessListing(listing({ trade: 'Fencing', place: { lat: 42.029, lon: -105 }, value: 1_240_000 }), prefs);
    expect(far.fit.ideal).toBe(false);
    expect(far.fit.reasons).toEqual(['Fencing is not one of your trades', '140 miles away, past your 50', 'Over your $750,000 bonding limit']);
    expect(far.miles).toBe(140);
  });

  test('the limits themselves still fit', () => {
    expect(assessListing(listing({ value: 750_000 }), prefs).fit.ideal).toBe(true);
    expect(assessListing(listing({ value: 750_001 }), prefs).fit.ideal).toBe(false);
    expect(assessListing(listing({ place: { lat: 40.72, lon: -105 } }), prefs)).toMatchObject({ miles: 50, fit: { ideal: true } });
    expect(assessListing(listing({ place: { lat: 40.75, lon: -105 } }), prefs)).toMatchObject({ miles: 52, fit: { ideal: false } });
  });

  test('trade matching ignores case and spacing', () => {
    expect(assessListing(listing({ trade: ' hvac ' }), prefs).fit.ideal).toBe(true);
  });

  test('a fact the listing does not state is not held against it', () => {
    expect(assessListing({ value: 100 }, prefs)).toEqual({ fit: { ideal: true, reasons: [] } });
    expect(assessListing(listing({ place: undefined }), prefs)).toEqual({ fit: { ideal: true, reasons: [] } });
  });

  test('no settings means everything fits, and no location means no distance', () => {
    const a = assessListing(listing({ trade: 'Fencing', value: 9e9, place: { lat: 60, lon: 10 } }), anywhere);
    expect(a).toEqual({ fit: { ideal: true, reasons: [] } });
    expect(assessListing(listing({ place: { lat: 60, lon: 10 } }), { ...anywhere, location: home }).miles).toBeGreaterThan(4000);
  });
});

describe('rankListings', () => {
  const set = [
    listing({ id: 'far', match: 99, place: { lat: 43, lon: -105 } }),
    listing({ id: 'weak', match: 60 }),
    listing({ id: 'strong', match: 90 }),
    listing({ id: 'wrong-trade', match: 95, trade: 'Fencing' }),
    listing({ id: 'near-tie', match: 90, place: { lat: 40.01, lon: -105 } }),
  ];

  test('best fits first, then the rest; stronger match, then nearer, inside each', () => {
    expect(rankListings(set, prefs).map((l) => l.id)).toEqual(['near-tie', 'strong', 'weak', 'far', 'wrong-trade']);
  });

  test('keeps every listing and stamps each with fit and distance', () => {
    const ranked = rankListings(set, prefs);
    expect(ranked).toHaveLength(set.length);
    for (const l of ranked) expect(l.fit).toBeDefined();
    expect(ranked.find((l) => l.id === 'far')).toMatchObject({ miles: 207, fit: { ideal: false } });
  });

  test('does not change its input, and keeps the given order on a full tie', () => {
    const before = JSON.stringify(set);
    rankListings(set, prefs);
    expect(JSON.stringify(set)).toBe(before);
    expect(rankListings([listing({ id: 'a' }), listing({ id: 'b' }), listing({ id: 'c' })], prefs).map((l) => l.id)).toEqual(['a', 'b', 'c']);
    expect(rankListings([], prefs)).toEqual([]);
  });

  test('changing the settings changes the order', () => {
    expect(rankListings(set, { ...prefs, trades: ['Fencing'] }).map((l) => l.id)[0]).toBe('wrong-trade');
    expect(rankListings(set, anywhere).map((l) => l.id)).toEqual(['far', 'wrong-trade', 'strong', 'near-tie', 'weak']);
  });
});

describe('collectListings', () => {
  const raw = (id: string, level: 'federal' | 'local'): RawListing => ({ id, title: id, owner: 'A', value: 1000, trade: 'HVAC', level, place: home, match: 50 });
  const listings = (name: string, levels: Array<'federal' | 'local'>, rows: RawListing[]): ListingProvider => ({ name, levels, listings: async () => rows });
  const awards = (name: string, levels: Array<'federal' | 'local'>, calls: string[] = []): AwardProvider => ({
    name, levels,
    awardsFor: async (l) => (calls.push(`${name}:${l.id}`), [{ id: `${name}-${l.id}`, contractor: 'C', amount: 1, start: '2020-01', end: '2020-02' }]),
  });

  test('names the source on every listing and every award', async () => {
    const { listings: out, failures } = await collectListings(prefs, [listings('Fed', ['federal'], [raw('f1', 'federal')]), listings('Loc', ['local'], [raw('l1', 'local')])], [awards('FedAwards', ['federal']), awards('LocAwards', ['local'])]);
    expect(failures).toEqual([]);
    expect(out.map((l) => [l.id, l.source, l.awards?.map((a) => a.source)])).toEqual([['f1', 'Fed', ['FedAwards']], ['l1', 'Loc', ['LocAwards']]]);
  });

  test('asks an award provider only about the levels it covers', async () => {
    const calls: string[] = [];
    await collectListings(prefs, [listings('All', ['federal', 'local'], [raw('f1', 'federal'), raw('l1', 'local')])], [awards('FedAwards', ['federal'], calls), awards('LocAwards', ['local'], calls)]);
    expect(calls.sort()).toEqual(['FedAwards:f1', 'LocAwards:l1']);
  });

  test('two providers covering the same project each contribute their awards', async () => {
    const { listings: out } = await collectListings(prefs, [listings('Loc', ['local'], [raw('l1', 'local')])], [awards('A', ['local']), awards('B', ['local'])]);
    expect(out[0]!.awards?.map((a) => a.source)).toEqual(['A', 'B']);
  });

  test('a provider that fails is reported and the others still show', async () => {
    const broken: ListingProvider = { name: 'Down', levels: ['local'], listings: async () => { throw new Error('timeout'); } };
    const brokenAwards: AwardProvider = { name: 'AwardsDown', levels: ['federal', 'local'], awardsFor: async () => { throw new Error('503'); } };
    const { listings: out, failures } = await collectListings(prefs, [broken, listings('Fed', ['federal'], [raw('f1', 'federal'), raw('f2', 'federal')])], [brokenAwards, awards('FedAwards', ['federal'])]);
    expect(out.map((l) => l.id).sort()).toEqual(['f1', 'f2']);
    expect(out[0]!.awards?.map((a) => a.source)).toEqual(['FedAwards']);
    expect(failures).toEqual([{ provider: 'Down', message: 'timeout' }, { provider: 'AwardsDown', message: '503' }]); // each provider once
  });

  test('the same project from two providers is shown once, from the first', async () => {
    const { listings: out } = await collectListings(prefs, [listings('First', ['local'], [raw('dup', 'local')]), listings('Second', ['local'], [raw('dup', 'local')])], []);
    expect(out.map((l) => [l.id, l.source])).toEqual([['dup', 'First']]);
    expect(out[0]!.awards).toBeUndefined();
  });

  test('with no providers there is nothing, and no failure', async () => {
    expect(await collectListings(prefs, [], [])).toEqual({ listings: [], failures: [] });
  });
});

describe('stub providers', () => {
  test('serve only their own level, without the fields the pipeline adds', async () => {
    const fed = await stubListingProvider('X', ['federal']).listings();
    expect(fed.map((l) => l.id)).toEqual(['l5']);
    for (const l of [...fed, ...(await stubListingProvider('Y', ['local']).listings())]) {
      expect(l).not.toHaveProperty('fit');
      expect(l).not.toHaveProperty('miles');
      expect(l).not.toHaveProperty('source');
      expect(l).not.toHaveProperty('awards');
    }
  });

  test('award stubs answer only for their level and leave the source to the aggregator', async () => {
    const [fed] = await stubListingProvider('X', ['federal']).listings();
    expect(await stubAwardProvider('Local', ['local']).awardsFor(fed!)).toEqual([]);
    const found = await stubAwardProvider('Fed', ['federal']).awardsFor(fed!);
    expect(found.map((a) => a.contractor)).toEqual(['Ridgeline Controls LLC']);
    expect(found[0]).not.toHaveProperty('source');
    expect(await stubAwardProvider('Fed', ['federal']).awardsFor({ ...fed!, id: 'unknown' })).toEqual([]);
  });

  test('the configured providers cover federal and local, for listings and for awards', () => {
    for (const set of [LISTING_PROVIDERS, AWARD_PROVIDERS]) expect(set.flatMap((p) => p.levels).sort()).toEqual(['federal', 'local']);
    expect(LISTING_PROVIDERS.map((p) => p.name)).toEqual(['SAM.gov', 'State and local feed']);
    expect(AWARD_PROVIDERS.map((p) => p.name)).toEqual(['USAspending.gov', 'State and local feed']);
  });
});

describe('loadListings', () => {
  test('rebuilds exactly what the design shows: order, fit, distance and every source', async () => {
    const { listings, failures } = await loadListings();
    expect(failures).toEqual([]);
    expect(listings).toEqual(sampleListings);
  });

  test('follows the contractor: other settings give another order', async () => {
    const { listings } = await loadListings({ ...SAMPLE_PREFERENCES, trades: ['Fencing'], radiusMiles: null, bondingLimitUsd: null });
    expect(listings.filter((l) => l.fit?.ideal).map((l) => l.id)).toEqual(['l4']);
  });
});

describe('reading settings', () => {
  test('parseRadius', () => {
    expect(parseRadius('50 miles')).toBe(50);
    expect(parseRadius(' 100 Miles ')).toBe(100);
    expect(parseRadius('1 mile')).toBe(1);
    for (const v of ['Anywhere in the state', '', 'fifty miles', 50, null, undefined]) expect(parseRadius(v)).toBeNull();
  });

  test('parseBondingLimit', () => {
    expect(parseBondingLimit('$750,000')).toBe(750_000);
    expect(parseBondingLimit(' 1,250,000.50 ')).toBe(1_250_000.5);
    expect(parseBondingLimit(500_000)).toBe(500_000);
    for (const v of ['', '$0', 0, -5, 'lots', '1e6', null, undefined, NaN]) expect(parseBondingLimit(v)).toBeNull();
  });
});
