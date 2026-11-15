// One place where product events leave the app. The design components report every click,
// form submit and experiment exposure through `setTracker`; this forwards them to `window.dataLayer`,
// which any tag manager or analytics tool can read. No vendor is wired in yet.
import type { TrackPayload } from '@/design/cb';

export interface DataLayerEvent {
  event: string;
  cb_at: number;
  [key: string]: unknown;
}

/** Flattens a tracker payload into one data-layer row; event props are prefixed so they can't collide. */
export function toDataLayerEvent(payload: TrackPayload): DataLayerEvent {
  const row: DataLayerEvent = { event: `cb_${payload.event}`, cb_at: payload.at };
  for (const [key, value] of Object.entries(payload.props ?? {})) {
    if (value === undefined || typeof value === 'function') continue;
    row[`cb_${key}`] = value;
  }
  return row;
}

/** Pushes a payload onto the given data layer and returns the row, so callers and tests can see it. */
export function pushEvent(layer: unknown[], payload: TrackPayload): DataLayerEvent {
  const row = toDataLayerEvent(payload);
  layer.push(row);
  return row;
}
