// Which design template the site is built in. Blueprint is the chosen one; Hi-Vis is the full
// alternative kept for side-by-side review. Set NEXT_PUBLIC_CB_TEMPLATE=hivis to build or run it.
export type SiteTemplate = 'blueprint' | 'hivis';

export const SITE_TEMPLATES: readonly SiteTemplate[] = ['blueprint', 'hivis'];

/** Anything unrecognised is Blueprint, so a typo can never produce an unstyled site. */
export function parseTemplate(value: unknown): SiteTemplate {
  const v = typeof value === 'string' ? value.trim().toLowerCase().replace(/[^a-z]/g, '') : '';
  return v === 'hivis' ? 'hivis' : 'blueprint';
}

export const TEMPLATE: SiteTemplate = parseTemplate(process.env.NEXT_PUBLIC_CB_TEMPLATE);
