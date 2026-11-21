import type { Metadata } from 'next';
import { ArticleScreen } from '@/screens/SiteScreens';

// Placeholder text: keep out of search results until counsel supplies the real thing.
export const metadata: Metadata = { title: 'Terms of service', robots: { index: false } };

export default function Page() {
  return <ArticleScreen kind="terms" />;
}
