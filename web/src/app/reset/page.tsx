import type { Metadata } from 'next';
import { AuthScreen } from '@/screens/SiteScreens';

export const metadata: Metadata = { title: 'Reset your password', robots: { index: false } };

export default function Page() {
  return <AuthScreen mode="reset" />;
}
