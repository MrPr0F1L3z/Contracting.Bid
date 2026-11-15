'use client';
import { MessageScreen } from '@/screens/SiteScreens';

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <MessageScreen kind="error" onRetry={reset} />;
}
