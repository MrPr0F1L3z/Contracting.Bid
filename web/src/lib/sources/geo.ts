import type { GeoPoint } from './types';

const EARTH_RADIUS_MILES = 3958.8;
const rad = (deg: number): number => (deg * Math.PI) / 180;

export function isGeoPoint(p: unknown): p is GeoPoint {
  if (!p || typeof p !== 'object') return false;
  const { lat, lon } = p as Record<string, unknown>;
  return typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

/** Great-circle distance in miles, or null when either point is missing or not a real coordinate. */
export function distanceMiles(a: unknown, b: unknown): number | null {
  if (!isGeoPoint(a) || !isGeoPoint(b)) return null;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}
