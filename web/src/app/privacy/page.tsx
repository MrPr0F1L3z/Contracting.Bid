import type { Metadata } from 'next';
import { ArticleScreen } from '@/screens/SiteScreens';

// Placeholder text: keep out of search results until counsel supplies the real thing.
export const metadata: Metadata = { title: 'Privacy policy', robots: { index: false } };

export default function Page() {
  return <ArticleScreen kind="privacy" />;
}
