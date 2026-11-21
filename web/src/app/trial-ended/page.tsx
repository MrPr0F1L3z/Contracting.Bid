import type { Metadata } from 'next';
import { MessageScreen } from '@/screens/SiteScreens';

export const metadata: Metadata = { title: 'Your free trial has ended', robots: { index: false } };

export default function Page() {
  return <MessageScreen kind="trial_ended" />;
}
