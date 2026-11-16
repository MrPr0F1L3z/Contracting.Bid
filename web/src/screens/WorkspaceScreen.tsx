'use client';
import { useRouter } from 'next/navigation';
import { Workspace, type JobStats, type Listing, type WorkspaceView } from '@/design';
import { pagePath, viewPath } from '@/lib/routes';
import { TEMPLATE, type SiteTemplate } from '@/lib/template';

/** One workspace screen, chosen by the URL. Navigation inside the workspace changes the route. */
interface Props {
  view: WorkspaceView;
  template?: SiteTemplate;
  listings?: Listing[];
  /** False until the account has a bid, a project or a job: Overview then shows the welcome screen. */
  started?: boolean;
  /** Hi-Vis overview counts; the row is hidden while they are all zero. */
  stats?: JobStats;
}

export function WorkspaceScreen({ view, template = TEMPLATE, listings, started, stats }: Props) {
  const router = useRouter();
  return (
    <Workspace
      key={view}
      template={template}
      view={view}
      listings={listings}
      started={started}
      stats={stats}
      onNavigate={(next) => router.push(viewPath(next))}
      onPlans={() => router.push(pagePath('pricing'))}
      onSignOut={() => router.push(pagePath('home'))}
    />
  );
}
