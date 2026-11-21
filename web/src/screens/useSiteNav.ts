'use client';
import { useRouter } from 'next/navigation';
import { useCallback } from 'react';
import { pagePath, startViewPath } from '@/lib/routes';
import { rememberSignupEmail } from '@/lib/signupEmail';

/** The `onNavigate` every site page takes: turns a page name into a route change. */
export function useSiteNav(): (page: string, extra?: unknown) => void {
  const router = useRouter();
  return useCallback(
    (page: string, extra?: unknown) => {
      if (page === 'signup') rememberSignupEmail(extra);
      router.push(page === 'app' ? startViewPath(extra) : pagePath(page));
    },
    [router],
  );
}
