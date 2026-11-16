'use client';
import { useRouter } from 'next/navigation';
import { Workspace, type Listing, type WorkspaceView } from '@/design';
import { pagePath, viewPath } from '@/lib/routes';
import { TEMPLATE, type SiteTemplate } from '@/lib/template';

/** One workspace screen, chosen by the URL. Navigation inside the workspace changes the route. */
export function WorkspaceScreen({ view, template = TEMPLATE, listings }: { view: WorkspaceView; template?: SiteTemplate; listings?: Listing[] }) {
  const router = useRouter();
  return (
    <Workspace
      key={view}
      template={template}
      view={view}
      listings={listings}
      onNavigate={(next) => router.push(viewPath(next))}
      onPlans={() => router.push(pagePath('pricing'))}
      onSignOut={() => router.push(pagePath('home'))}
    />
  );
}
