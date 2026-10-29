'use client';

/**
 * Lot 93 (CDC 18 §7, §9.1, SIGN-01) — « Continuer avec Google » / « Continuer
 * avec Apple », puis le séparateur « ou » avant le formulaire e-mail + mot de
 * passe. Rien n'est affiché tant qu'aucun fournisseur n'est configuré
 * (variables Scalingo absentes) : l'écran reste celui d'avant.
 *
 * Le contexte d'inscription (invitation, transmission, parrainage, retour
 * interne) part au serveur au démarrage et y reste (transaction OAuth) ; il
 * n'est jamais reconstruit à partir de l'URL au retour (§7).
 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { isNativeApp } from '@/lib/native/bridge';

type Providers = { google: boolean; apple: boolean };

export function GoogleLogo() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

export function AppleLogo() {
  return (
    <svg viewBox="0 0 814 1000" aria-hidden="true" focusable="false" fill="currentColor">
      <path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76.5 0-103.7 40.8-165.9 40.8s-105.6-57-155.5-127C46.7 790.7 0 663 0 541.8c0-194.4 126.4-297.5 250.8-297.5 66.1 0 121.2 43.4 162.7 43.4 39.5 0 101.1-46 176.3-46 28.5 0 130.9 2.6 198.3 99.2zm-234-181.5c31.1-36.9 53.1-88.1 53.1-139.3 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-110.8 33.7-147.1 75.8-28.5 32.4-55.1 83.6-55.1 135.5 0 7.8 1.3 15.6 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 45.4 0 102.5-30.4 135.5-71.3z" />
    </svg>
  );
}

/** Bouton de marque, utilisable seul (écran « J'ai déjà un compte », Mon compte). */
export function ProviderButton({ provider, label, onClick, disabled }: {
  provider: 'google' | 'apple'; label?: string; onClick: () => void; disabled?: boolean;
}) {
  const name = provider === 'google' ? 'Google' : 'Apple';
  return (
    <button
      type="button"
      className={`vb-social-btn vb-social-btn--${provider}`}
      onClick={onClick}
      disabled={disabled}
      data-testid={`social-${provider}`}
    >
      {provider === 'google' ? <GoogleLogo /> : <AppleLogo />}
      <span>{label ?? `Continuer avec ${name}`}</span>
    </button>
  );
}

/** URL de démarrage (GET) : le serveur crée la transaction et redirige vers le fournisseur. */
export function socialStartUrl(provider: 'google' | 'apple', params: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  return `/api/auth/oauth/${provider}/start?${q.toString()}`;
}

let cache: Promise<Providers> | null = null;
export function fetchProviders(): Promise<Providers> {
  cache ??= fetch('/api/auth/oauth/providers', { credentials: 'include' })
    .then((r) => (r.ok ? r.json() : { google: false, apple: false }))
    .catch(() => ({ google: false, apple: false }));
  return cache;
}

export function SocialSignInButtons(props: {
  mode: 'login' | 'signup';
  returnUrl?: string | null;
  inviteToken?: string | null;
  transmissionToken?: string | null;
  referralCode?: string | null;
  disabled?: boolean;
  className?: string;
}) {
  const [providers, setProviders] = useState<Providers | null>(null);
  const [going, setGoing] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchProviders().then((p) => { if (alive) setProviders(p); });
    return () => { alive = false; };
  }, []);

  if (!providers || (!providers.google && !providers.apple)) return null;

  const go = (provider: 'google' | 'apple') => {
    setGoing(provider);
    const params = {
      intent: props.mode,
      returnUrl: props.returnUrl ?? undefined,
      inviteToken: props.inviteToken ?? undefined,
      transmissionToken: props.transmissionToken ?? undefined,
      ref: props.referralCode ?? undefined,
    };
    // Lot 95 (PO M1) : dans l'application iOS / Android, le parcours s'ouvre
    // dans le navigateur système (jamais dans la vue de l'app). Web : inchangé.
    if (isNativeApp()) {
      void import('@/lib/native/oauth').then(({ startNativeSocialSignIn }) => startNativeSocialSignIn(provider, params))
        .then((r) => {
          if (r.status === 'signed_in') { window.location.assign(r.redirectTo); return; }
          if (r.status === 'failed') toast.error(r.message);
          setGoing(null);
        })
        .catch(() => setGoing(null));
      return;
    }
    window.location.assign(socialStartUrl(provider, params));
  };

  return (
    <div className={`space-y-3 ${props.className ?? ''}`} data-testid="social-sign-in">
      {providers.google && <ProviderButton provider="google" onClick={() => go('google')} disabled={!!going || props.disabled} />}
      {providers.apple && <ProviderButton provider="apple" onClick={() => go('apple')} disabled={!!going || props.disabled} />}
      <div className="vb-or-separator pt-1" role="separator" aria-label="ou">ou</div>
    </div>
  );
}
