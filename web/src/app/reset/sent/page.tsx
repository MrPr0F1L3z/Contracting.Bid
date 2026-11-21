import type { Metadata } from 'next';
import { MessageScreen } from '@/screens/SiteScreens';

export const metadata: Metadata = { title: 'Check your email', robots: { index: false } };

export default function Page() {
  return <MessageScreen kind="reset_sent" />;
}
