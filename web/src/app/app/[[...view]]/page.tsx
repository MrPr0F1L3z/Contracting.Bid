import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { WORKSPACE_VIEWS, viewFromSegments, viewSlug } from '@/lib/routes';
import { loadListings } from '@/lib/sources';
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
  // The two screens that list open projects get them from the providers, ranked for the contractor.
  const listings = view === 'find_work' ? (await loadListings()).listings : undefined;
  return <WorkspaceScreen view={view} listings={listings} />;
}
