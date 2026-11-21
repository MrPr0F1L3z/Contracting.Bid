import type { MetadataRoute } from 'next';
import { robotsRules } from '../lib/robots';

// Static so the site can be exported as plain files for the cPanel host (see docs/CPANEL.md).
export const dynamic = 'force-static';

export default function robots(): MetadataRoute.Robots {
  return robotsRules(process.env.CB_SITE_ENV);
}
