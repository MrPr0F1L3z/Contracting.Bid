import type { Metadata } from 'next';
import { PricingScreen } from '@/screens/SiteScreens';

export const metadata: Metadata = { title: 'Pricing', description: 'Every plan starts with the full product. Free for 7 days. No credit card needed.' };

export default function Page() {
  return <PricingScreen />;
}
