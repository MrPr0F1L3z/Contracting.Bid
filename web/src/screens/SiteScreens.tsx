'use client';
import { useEffect, useState } from 'react';
import { ArticlePage, AuthPage, LandingPage, MessagePage, Onboarding, PricingPage } from '@/design';
import { takeSignupEmail } from '@/lib/signupEmail';
import { TEMPLATE, type SiteTemplate } from '@/lib/template';
import { useSiteNav } from './useSiteNav';

// Every screen takes `template` so tests and previews can render either one; the app itself uses TEMPLATE.
interface Templated {
  template?: SiteTemplate;
}

export function HomeScreen({ template = TEMPLATE }: Templated) {
  return <LandingPage template={template} onNavigate={useSiteNav()} />;
}

export function PricingScreen({ template = TEMPLATE }: Templated) {
  return <PricingPage template={template} onNavigate={useSiteNav()} />;
}

export function AuthScreen({ mode, template = TEMPLATE }: Templated & { mode: 'signup' | 'signin' | 'reset' | 'new_password' }) {
  const onNavigate = useSiteNav();
  // Read after mount: sessionStorage does not exist on the server, and reading it during render would mismatch.
  const [email, setEmail] = useState('');
  useEffect(() => {
    if (mode === 'signup') setEmail(takeSignupEmail());
  }, [mode]);
  return <AuthPage key={email} template={template} mode={mode} email={email || undefined} onNavigate={onNavigate} />;
}

export function OnboardingScreen({ template = TEMPLATE }: Templated) {
  return <Onboarding template={template} onNavigate={useSiteNav()} />;
}

export function ArticleScreen({ kind, template = TEMPLATE }: Templated & { kind: 'terms' | 'privacy' }) {
  return <ArticlePage template={template} kind={kind} onNavigate={useSiteNav()} />;
}

export function MessageScreen({ kind, onRetry, template = TEMPLATE }: Templated & { kind: 'trial_ended' | 'not_found' | 'error' | 'reset_sent'; onRetry?: () => void }) {
  const go = useSiteNav();
  // "Try again" on the error page re-renders the failed route instead of leaving it.
  return <MessagePage template={template} kind={kind} onNavigate={(page) => (kind === 'error' && page === 'app' && onRetry ? onRetry() : go(page))} />;
}
