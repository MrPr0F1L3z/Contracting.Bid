'use client';
import { useEffect } from 'react';
import { setTracker } from '@/design';
import { pushEvent } from '@/lib/analytics';

declare global {
  interface Window {
    dataLayer?: unknown[];
  }
}

/** Mount once in the root layout. Renders nothing. */
export function Analytics() {
  useEffect(() => {
    const layer = (window.dataLayer ??= []);
    setTracker((payload) => pushEvent(layer, payload));
    return () => setTracker(null);
  }, []);
  return null;
}
