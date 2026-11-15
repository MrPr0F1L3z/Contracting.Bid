import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@fontsource/archivo/600.css';
import '@fontsource/archivo/700.css';
import '@fontsource/archivo/800.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@/design/tokens.css';
import '@/design/components.css';
import './globals.css';
import { Analytics } from '@/screens/Analytics';

export const metadata: Metadata = {
  title: { default: 'Contracting.Bid: every bid, sub and dollar on one sheet', template: '%s · Contracting.Bid' },
  description:
    'Contracting.Bid finds the projects that fit your crew, builds the bid, then runs the job through subcontractors, scheduling, billing and closeout. Free for 7 days. No credit card needed.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="blueprint">
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
