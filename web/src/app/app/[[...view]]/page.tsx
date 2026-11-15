import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { WORKSPACE_VIEWS, viewFromSegments, viewSlug } from '@/lib/routes';
import { WorkspaceScreen } from '@/screens/WorkspaceScreen';

// The workspace is behind sign-in in the real product; never index it.
export const metadata: Metadata = { title: 'Workspace', robots: { index: false, follow: false } };

// Only the known screens exist; anything else is a 404 rather than a blank workspace.
export const dynamicParams = false;

export function generateStaticParams() {
  return WORKSPACE_VIEWS.map((view) => ({ view: view === 'overview' ? [] : [viewSlug(view)] }));
}

export default async function Page({ params }: { params: Promise<{ view?: string[] }> }) {
  const view = viewFromSegments((await params).view);
  if (!view) notFound();
  return <WorkspaceScreen view={view} />;
}
