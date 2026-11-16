import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@fontsource/archivo/600.css';
import '@fontsource/archivo/700.css';
import '@fontsource/archivo/800.css';
import '@fontsource/archivo/900.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@/design/tokens.css';
import '@/design/components.css';
import './globals.css';
import { TEMPLATE } from '@/lib/template';
import { Analytics } from '@/screens/Analytics';

export const metadata: Metadata = {
  title: { default: 'Contracting.Bid: AI runs the office work, you run the company', template: '%s · Contracting.Bid' },
  description:
    'Contracting.Bid uses AI to find projects, build bids and run each job through subcontractors, scheduling, billing and closeout, while you approve the decisions that matter. Free for 7 days. No credit card needed.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme={TEMPLATE}>
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
