import type { Preferences } from './types';

// Stands in for what a signed-in contractor has saved in Settings, until accounts exist.
// It matches the sample Settings screen: four trades, 50 miles, $750,000 bonding.
export const SAMPLE_PREFERENCES: Preferences = {
  trades: ['HVAC', 'Paving', 'Roofing', 'General building'],
  radiusMiles: 50,
  bondingLimitUsd: 750_000,
  location: { lat: 40.0, lon: -105.0 },
};

/** "50 miles" → 50; "Anywhere in the state" or anything unreadable → null (no distance limit). */
export function parseRadius(choice: unknown): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*miles?\s*$/i.exec(typeof choice === 'string' ? choice : '');
  return m ? Number(m[1]) : null;
}

/** "$750,000" → 750000; empty or unreadable → null (no limit). */
export function parseBondingLimit(text: unknown): number | null {
  if (typeof text === 'number') return Number.isFinite(text) && text > 0 ? text : null;
  const cleaned = (typeof text === 'string' ? text : '').replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return n > 0 ? n : null;
}
