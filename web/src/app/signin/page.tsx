import type { Metadata } from 'next';
import { AuthScreen } from '@/screens/SiteScreens';

export const metadata: Metadata = { title: 'Sign in' };

export default function Page() {
  return <AuthScreen mode="signin" />;
}
