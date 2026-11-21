import type { Metadata } from 'next';
import { OnboardingScreen } from '@/screens/SiteScreens';

export const metadata: Metadata = { title: 'Set up your workspace', robots: { index: false } };

export default function Page() {
  return <OnboardingScreen />;
}
