'use client';
import { useEffect, useState } from 'react';
import { ArticlePage, AuthPage, LandingPage, MessagePage, Onboarding, PricingPage } from '@/design';
import { takeSignupEmail } from '@/lib/signupEmail';
import { useSiteNav } from './useSiteNav';

export function HomeScreen() {
  return <LandingPage template="blueprint" onNavigate={useSiteNav()} />;
}

export function PricingScreen() {
  return <PricingPage onNavigate={useSiteNav()} />;
}

export function AuthScreen({ mode }: { mode: 'signup' | 'signin' | 'reset' | 'new_password' }) {
  const onNavigate = useSiteNav();
  // Read after mount: sessionStorage does not exist on the server, and reading it during render would mismatch.
  const [email, setEmail] = useState('');
  useEffect(() => {
    if (mode === 'signup') setEmail(takeSignupEmail());
  }, [mode]);
  return <AuthPage key={email} mode={mode} email={email || undefined} onNavigate={onNavigate} />;
}

export function OnboardingScreen() {
  return <Onboarding onNavigate={useSiteNav()} />;
}

export function ArticleScreen({ kind }: { kind: 'terms' | 'privacy' }) {
  return <ArticlePage kind={kind} onNavigate={useSiteNav()} />;
}

export function MessageScreen({ kind, onRetry }: { kind: 'trial_ended' | 'not_found' | 'error' | 'reset_sent'; onRetry?: () => void }) {
  const go = useSiteNav();
  // "Try again" on the error page re-renders the failed route instead of leaving it.
  return <MessagePage kind={kind} onNavigate={(page) => (kind === 'error' && page === 'app' && onRetry ? onRetry() : go(page))} />;
}
