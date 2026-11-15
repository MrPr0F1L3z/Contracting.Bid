'use client';
import { useRouter } from 'next/navigation';
import { Workspace, type WorkspaceView } from '@/design';
import { pagePath, viewPath } from '@/lib/routes';

/** One workspace screen, chosen by the URL. Navigation inside the workspace changes the route. */
export function WorkspaceScreen({ view }: { view: WorkspaceView }) {
  const router = useRouter();
  return (
    <Workspace
      key={view}
      template="blueprint"
      view={view}
      onNavigate={(next) => router.push(viewPath(next))}
      onPlans={() => router.push(pagePath('pricing'))}
      onSignOut={() => router.push(pagePath('home'))}
    />
  );
}
