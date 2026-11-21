import { describe, expect, test } from 'vitest';
import { VIEWS, PAGES } from '../src/design/cb.js';
import { PAGE_PATHS, START_VIEWS, WORKSPACE_VIEWS, pagePath, startViewPath, viewFromSegments, viewPath, viewSlug } from '../src/lib/routes';

describe('routes', () => {
  test('every design-system page and view has a route, and nothing extra', () => {
    expect(Object.keys(PAGE_PATHS).sort()).toEqual([...PAGES].sort());
    expect([...WORKSPACE_VIEWS].sort()).toEqual([...VIEWS].sort());
  });

  test('page paths are unique and absolute', () => {
    const paths = Object.values(PAGE_PATHS);
    expect(new Set(paths).size).toBe(paths.length);
    for (const p of paths) expect(p.startsWith('/')).toBe(true);
  });

  test('pagePath falls back to home for an unknown page', () => {
    expect(pagePath('pricing')).toBe('/pricing');
    expect(pagePath('new_password')).toBe('/reset/new');
    expect(pagePath('nope')).toBe('/');
  });

  test('viewPath and viewSlug', () => {
    expect(viewSlug('subs_vendors')).toBe('subs-vendors');
    expect(viewPath('overview')).toBe('/app');
    expect(viewPath('bid_detail')).toBe('/app/bid-detail');
    expect(viewPath('nope')).toBe('/app');
  });

  test('viewFromSegments is the inverse of viewPath for every view', () => {
    for (const view of WORKSPACE_VIEWS) {
      const segments = viewPath(view).split('/').slice(2);
      expect(viewFromSegments(segments)).toBe(view);
    }
  });

  test('viewFromSegments rejects unknown, nested and duplicate URLs', () => {
    expect(viewFromSegments(undefined)).toBe('overview');
    expect(viewFromSegments([])).toBe('overview');
    expect(viewFromSegments(['nope'])).toBeNull();
    expect(viewFromSegments(['bids', 'extra'])).toBeNull();
    expect(viewFromSegments(['overview'])).toBeNull();
    expect(viewFromSegments([''])).toBeNull();
  });

  test('startViewPath maps the onboarding choice to a first screen', () => {
    expect(startViewPath('import')).toBe('/app/import-bid');
    expect(startViewPath('match')).toBe('/app/find-work');
    expect(startViewPath('sample')).toBe('/app');
    expect(startViewPath(undefined)).toBe('/app');
    expect(startViewPath('constructor')).toBe('/app');
    for (const v of Object.values(START_VIEWS)) expect(WORKSPACE_VIEWS).toContain(v);
  });
});
