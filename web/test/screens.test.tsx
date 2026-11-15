import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

import { PAGE_PATHS, WORKSPACE_VIEWS, viewPath } from '../src/lib/routes';
import { ArticleScreen, AuthScreen, HomeScreen, MessageScreen, OnboardingScreen, PricingScreen } from '../src/screens/SiteScreens';
import { WorkspaceScreen } from '../src/screens/WorkspaceScreen';

beforeEach(() => push.mockClear());

describe('site screens', () => {
  test('home renders Blueprint with real URLs, not hash links', () => {
    const html = renderToStaticMarkup(<HomeScreen />);
    expect(html).toContain('data-template="blueprint"');
    expect(html).toContain('href="/pricing"');
    expect(html).toContain('href="/signin"');
    expect(html).toContain('href="/terms"');
    expect(html).not.toMatch(/href="#/);
    expect(html).toContain('Free for 7 days. No credit card needed.');
  });

  test('pricing, onboarding and articles render their page', () => {
    expect(renderToStaticMarkup(<PricingScreen />)).toContain('data-page="pricing"');
    expect(renderToStaticMarkup(<OnboardingScreen />)).toContain('data-page="onboarding"');
    expect(renderToStaticMarkup(<ArticleScreen kind="privacy" />)).toContain('Privacy policy');
  });

  test.each(['signup', 'signin', 'reset', 'new_password'] as const)('auth screen: %s', (mode) => {
    const html = renderToStaticMarkup(<AuthScreen mode={mode} />);
    expect(html).toContain(`data-page="${mode}"`);
    expect(html).not.toMatch(/href="#/);
  });

  test.each(['trial_ended', 'not_found', 'error', 'reset_sent'] as const)('message screen: %s', (kind) => {
    expect(renderToStaticMarkup(<MessageScreen kind={kind} />)).toContain(`data-page="${kind}"`);
  });
});

describe('workspace screen', () => {
  test.each([...WORKSPACE_VIEWS])('renders %s with its nav item current and real URLs', (view) => {
    const html = renderToStaticMarkup(<WorkspaceScreen view={view} />);
    expect(html).toContain(`data-view="${view}"`);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain(`href="${PAGE_PATHS.app}"`);
    expect(html).toContain(`href="${viewPath('settings')}"`);
    expect(html).not.toMatch(/href="#/);
  });
});
