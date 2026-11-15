'use client';
// The app's entry to the design system. Importing from here (never from ./cb directly)
// guarantees links point at real URLs on the server render and in the browser alike.
import { setLinks } from './cb';
import { pagePath, viewPath } from '@/lib/routes';

setLinks({ page: pagePath, view: viewPath });

export * from './cb';
