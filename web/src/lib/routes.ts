// URL scheme for the site and the workspace. Pure functions, shared by links, navigation and tests.
import type { SitePage, WorkspaceView } from '@/design/cb';

export const PAGE_PATHS: Record<SitePage, string> = {
  home: '/',
  pricing: '/pricing',
  signin: '/signin',
  signup: '/signup',
  onboarding: '/onboarding',
  app: '/app',
  reset: '/reset',
  reset_sent: '/reset/sent',
  new_password: '/reset/new',
  terms: '/terms',
  privacy: '/privacy',
  trial_ended: '/trial-ended',
  // These two are rendered by Next.js itself (not-found.tsx, error.tsx); the paths exist so a link never dangles.
  not_found: '/not-found',
  error: '/error',
};

export const WORKSPACE_VIEWS: readonly WorkspaceView[] = [
  'overview', 'find_work', 'bids', 'projects', 'subs_vendors', 'schedule', 'money', 'closeout',
  'bid_detail', 'award', 'project_detail', 'pay_app', 'settings', 'welcome', 'import_bid', 'sub_detail', 'pay_run', 'change_order',
];

/** How the last onboarding step's choice maps to the first workspace screen. */
export const START_VIEWS: Record<string, WorkspaceView> = { import: 'import_bid', match: 'find_work', sample: 'overview' };

export function pagePath(page: string): string {
  return (PAGE_PATHS as Record<string, string>)[page] ?? PAGE_PATHS.home;
}

export function viewSlug(view: WorkspaceView): string {
  return view.replaceAll('_', '-');
}

export function viewPath(view: string): string {
  if (view === 'overview' || !(WORKSPACE_VIEWS as readonly string[]).includes(view)) return PAGE_PATHS.app;
  return `${PAGE_PATHS.app}/${viewSlug(view as WorkspaceView)}`;
}

/** The view for `/app/<slug>`; `undefined` segments mean the overview; `null` means no such screen. */
export function viewFromSegments(segments: readonly string[] | undefined): WorkspaceView | null {
  if (!segments || segments.length === 0) return 'overview';
  if (segments.length > 1) return null;
  const candidate = (segments[0] ?? '').replaceAll('-', '_');
  // `/app/overview` would duplicate `/app`.
  if (candidate === 'overview') return null;
  return (WORKSPACE_VIEWS as readonly string[]).includes(candidate) ? (candidate as WorkspaceView) : null;
}

export function startViewPath(start: unknown): string {
  return viewPath(typeof start === 'string' ? (START_VIEWS[start] ?? 'overview') : 'overview');
}
