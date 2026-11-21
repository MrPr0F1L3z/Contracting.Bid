import type { Metadata } from 'next';
import { AuthScreen } from '@/screens/SiteScreens';

export const metadata: Metadata = { title: 'Create your account' };

export default function Page() {
  return <AuthScreen mode="signup" />;
}
