import type { Metadata } from 'next';
import { MessageScreen } from '@/screens/SiteScreens';

export const metadata: Metadata = { title: 'Page not found' };

export default function NotFound() {
  return <MessageScreen kind="not_found" />;
}
