"use client"

/**
 * /connexion-sociale — lot 93, CDC 18 §7.2, §8.1, §8.2, §12.4, §28, §37.
 *
 * Après Google / Apple, quand AUCUN compte Verebona n'est encore associé à ce
 * compte du fournisseur :
 *   · adresse attestée déjà utilisée par un compte (§8.1) → « Un compte
 *     Verebona utilise déjà cette adresse » : seule la connexion à ce compte
 *     (puis l'association) est proposée — jamais de second compte ;
 *   · sinon (§8.2, obligatoire) → « Vous avez déjà un compte Verebona ? » :
 *     « J'ai déjà un compte Verebona » (connexion complète puis association)
 *     ou « Créer un nouveau compte » (prénom, nom, adresse, CGSU).
 * Autre adresse que celle du fournisseur (ou relais Apple remplacé) : code à
 * 6 chiffres envoyé à cette adresse, saisi ici. Rien n'est créé avant la
 * validation finale ; « Annuler » ne laisse aucune trace (SIGN-11).
 * Desktop et mobile : une colonne, cibles tactiles ≥ 44 px.
 */
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LogoWithBaseline } from '@/components/Logo';
import { PasswordInput } from '@/components/ui/password-input';
import { Checkbox } from '@/components/ui/checkbox';
import { AuthFooter } from '@/components/LandingFooter';
import { FollowTheme } from '@/components/FollowTheme';
import { ProviderButton, socialStartUrl } from '@/components/auth/SocialSignInButtons';
import { SOCIAL_ERROR_MESSAGES } from '@/lib/auth/oauth/messages';

interface PendingState {
  provider: 'google' | 'apple';
  providerLabel: string;
  intent: 'login' | 'signup';
  stage: 'choice' | 'existing_email' | 'email_code';
  firstName: string | null;
  lastName: string | null;
  providerEmail: string | null;
  providerEmailVerified: boolean;
  isPrivateRelay: boolean;
  pendingEmail: string | null;
  referralCode: string | null;
  context: 'invitation' | 'transmission' | null;
  otherProviders: Array<'google' | 'apple'>;
}

type View = 'loading' | 'expired' | 'choice' | 'existing' | 'profile' | 'code';

async function post(body: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await fetch('/api/auth/oauth/pending', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  let data: Record<string, unknown> = {};
  try { data = await res.json(); } catch { /* corps vide */ }
  return { ok: res.ok, status: res.status, data };
}

const messageOf = (d: Record<string, unknown>, fallback = 'Une erreur est survenue. Réessayez.') =>
  (typeof d.message === 'string' && d.message) || (typeof d.error === 'string' && d.error) || fallback;

function ErrorBox({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div role="alert" className="flex items-start gap-2 text-sm bg-[color:var(--danger-soft)] border border-[color:var(--danger-edge)] text-[color:var(--danger)] p-3 rounded-md">
      <span className="shrink-0 mt-0.5" aria-hidden="true">⚠</span>
      <p>{text}</p>
    </div>
  );
}

function SocialPending() {
  const [state, setState] = useState<PendingState | null>(null);
  const [view, setView] = useState<View>('loading');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // « J'ai déjà un compte »
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');

  // Profil
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [referral, setReferral] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [legal, setLegal] = useState<{ versionCode: string; permalink: string } | null>(null);

  // Code
  const [code, setCode] = useState('');
  const [codeEmail, setCodeEmail] = useState('');
  const [info, setInfo] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/auth/oauth/pending', { credentials: 'include' });
        if (!res.ok) { setView('expired'); return; }
        const s = (await res.json()) as PendingState;
        setState(s);
        setFirstName(s.firstName ?? '');
        setLastName(s.lastName ?? '');
        setEmail(s.providerEmail ?? '');
        setLoginEmail(s.providerEmail && !s.isPrivateRelay ? s.providerEmail : '');
        setReferral(s.referralCode ?? '');
        if (s.stage === 'existing_email') setView('existing');
        else if (s.stage === 'email_code') { setCodeEmail(s.pendingEmail ?? ''); setView('code'); }
        else setView('choice');
      } catch {
        setView('expired');
      }
    })();
    // Version des CGSU affichée = celle enregistrée (CDC 7 §18, SIGN-03).
    fetch('/api/legal/cgvu/current', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.versionCode) setLegal({ versionCode: d.versionCode, permalink: d.permalink }); })
      .catch(() => {});
  }, []);

  const finish = (data: Record<string, unknown>) => {
    const to = typeof data.redirectTo === 'string' ? data.redirectTo : '/accueil';
    window.location.assign(to);
  };

  const linkWithPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setBusy(true);
    const r = await post({ action: 'link-password', email: loginEmail, password: loginPassword }).catch(() => null);
    if (r?.ok) return finish(r.data);
    setBusy(false);
    if (r?.status === 410) { setView('expired'); return; }
    setError(r ? messageOf(r.data) : 'Connexion au serveur impossible. Vérifiez votre réseau.');
  };

  const createAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!accepted) { setError('Vous devez accepter les conditions générales pour créer un compte.'); return; }
    setBusy(true);
    const r = await post({
      action: 'signup', firstName, lastName, email, acceptedTerms: accepted, termsVersion: legal?.versionCode,
      referralCode: state?.context === 'invitation' ? undefined : referral || undefined,
    }).catch(() => null);
    setBusy(false);
    if (r?.ok && r.data.stage === 'email_code') {
      setCodeEmail(String(r.data.email ?? email)); setCode(''); setInfo(''); setView('code');
      return;
    }
    if (r?.ok) return finish(r.data);
    if (r?.status === 410) { setView('expired'); return; }
    if (r?.data.code === 'ACCOUNT_ALREADY_EXISTS') { setView('existing'); }
    setError(r ? messageOf(r.data) : 'Connexion au serveur impossible. Vérifiez votre réseau.');
  };

  const verifyCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setBusy(true);
    const r = await post({ action: 'verify-code', code }).catch(() => null);
    if (r?.ok) return finish(r.data);
    setBusy(false);
    if (r?.status === 410 || (r?.status === 429 && r.data.code === 'RATE_LIMIT_EXCEEDED' && !r.data.retryAfterSeconds)) { setView('expired'); }
    setError(r ? messageOf(r.data) : 'Connexion au serveur impossible. Vérifiez votre réseau.');
  };

  const resend = async () => {
    setError(''); setInfo('');
    const r = await post({ action: 'resend-code' }).catch(() => null);
    if (r?.ok) setInfo('Un nouveau code vient d’être envoyé.');
    else setError(r ? messageOf(r.data) : 'Connexion au serveur impossible.');
  };

  const cancel = async () => {
    setBusy(true);
    const r = await post({ action: 'cancel' }).catch(() => null);
    window.location.assign(typeof r?.data.redirectTo === 'string' ? r.data.redirectTo : '/login');
  };

  const viaOtherProvider = (p: 'google' | 'apple') => {
    setBusy(true);
    window.location.assign(socialStartUrl(p, { intent: 'login', link_pending: '1' }));
  };

  const label = state?.providerLabel ?? 'Google ou Apple';

  const existingAccountPanel = (
    <div className="space-y-4" data-testid="social-existing-account">
      <form onSubmit={linkWithPassword} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="link-email">Adresse e-mail de votre compte Verebona</Label>
          <Input id="link-email" type="email" autoComplete="email" value={loginEmail} onChange={(e) => setLoginEmail(e.target.value)} required disabled={busy} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="link-password">Mot de passe</Label>
          <PasswordInput id="link-password" autoComplete="current-password" value={loginPassword} onChange={(e) => setLoginPassword(e.target.value)} required disabled={busy} />
        </div>
        <Button type="submit" className="w-full min-h-11" disabled={busy}>
          {busy ? 'Connexion…' : `Me connecter et associer ${label}`}
        </Button>
      </form>
      {state && state.otherProviders.length > 0 && (
        <div className="space-y-3">
          <div className="vb-or-separator" role="separator">ou, si votre compte utilise déjà</div>
          {state.otherProviders.map((p) => (
            <ProviderButton key={p} provider={p} onClick={() => viaOtherProvider(p)} disabled={busy} />
          ))}
        </div>
      )}
      <p className="text-xs text-[color:var(--text-muted)]">
        Mot de passe oublié ?{' '}
        <Link href="/forgot-password" className="text-primary hover:underline">Le réinitialiser</Link>
        , puis recommencez avec {label}.
      </p>
    </div>
  );

  return (
    <div className="public-page min-h-screen flex flex-col bg-[color:var(--bg-page)]">
      <FollowTheme />
      <div className="flex-1 flex items-center justify-center p-4">
        <Card className="w-full max-w-md bg-[color:var(--bg-card)] border-[color:var(--border-subtle)] shadow-xl">
          <CardHeader className="space-y-4">
            <div className="flex justify-center"><LogoWithBaseline size={50} /></div>
            <CardTitle role="heading" aria-level={1} className="text-center text-[24px] font-extrabold tracking-[-.02em] text-[color:var(--text-primary)]">
              {view === 'existing' ? 'Vous avez déjà un compte Verebona'
                : view === 'profile' ? 'Créer votre compte'
                : view === 'code' ? 'Confirmez votre adresse'
                : view === 'expired' ? 'Connexion interrompue'
                : 'Vous avez déjà un compte Verebona ?'}
            </CardTitle>
            {state && view !== 'expired' && view !== 'loading' && (
              <CardDescription className="text-center text-[color:var(--text-muted)]">
                {view === 'existing'
                  ? SOCIAL_ERROR_MESSAGES.ACCOUNT_ALREADY_EXISTS
                  : view === 'code'
                    ? `Saisissez le code à 6 chiffres envoyé à ${codeEmail}.`
                    : `Vous vous êtes identifié avec ${label}${state.providerEmail && !state.isPrivateRelay ? ` (${state.providerEmail})` : ''}. Aucun compte Verebona n’est encore associé à ce compte ${label}.`}
              </CardDescription>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            {view === 'loading' && <p className="text-center text-[color:var(--text-muted)]">Chargement…</p>}

            {view === 'expired' && (
              <div className="space-y-4 text-center">
                <p className="text-sm text-[color:var(--text-muted)]">{SOCIAL_ERROR_MESSAGES.OAUTH_STATE_INVALID}</p>
                <Button asChild className="w-full min-h-11"><Link href="/login">Retour à la connexion</Link></Button>
              </div>
            )}

            {view === 'choice' && state && (
              <div className="space-y-3" data-testid="social-choice">
                <Button type="button" className="w-full min-h-11" onClick={() => { setError(''); setView('existing'); }}>
                  J’ai déjà un compte Verebona
                </Button>
                <Button type="button" variant="outline" className="w-full min-h-11" onClick={() => { setError(''); setView('profile'); }}>
                  Créer un nouveau compte
                </Button>
              </div>
            )}

            {view === 'existing' && existingAccountPanel}

            {view === 'profile' && state && (
              <form onSubmit={createAccount} className="space-y-4" data-testid="social-profile">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="sp-first">Prénom *</Label>
                    <Input id="sp-first" value={firstName} onChange={(e) => setFirstName(e.target.value)} required disabled={busy} autoComplete="given-name" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="sp-last">Nom *</Label>
                    <Input id="sp-last" value={lastName} onChange={(e) => setLastName(e.target.value)} required disabled={busy} autoComplete="family-name" />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="sp-email">Adresse e-mail principale *</Label>
                  <Input id="sp-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required disabled={busy} autoComplete="email" />
                  <p className="text-xs text-[color:var(--text-muted)]">
                    {state.isPrivateRelay
                      ? 'Adresse masquée par Apple : vous pouvez la garder, ou indiquer votre adresse habituelle (un code de confirmation vous sera envoyé).'
                      : !state.providerEmail
                        ? `${label} ne nous a pas transmis d’adresse : un code de confirmation vous sera envoyé.`
                        : `Si vous indiquez une autre adresse que celle de ${label}, un code de confirmation vous y sera envoyé.`}
                  </p>
                </div>
                {state.context !== 'invitation' && (
                  <div className="space-y-2">
                    <Label htmlFor="sp-ref">Code de parrainage (facultatif)</Label>
                    <Input id="sp-ref" value={referral} onChange={(e) => setReferral(e.target.value.toUpperCase().trim())} disabled={busy} autoComplete="off" />
                  </div>
                )}
                <div className="flex items-start gap-3">
                  <Checkbox id="sp-terms" checked={accepted} onCheckedChange={(v) => setAccepted(v === true)} disabled={busy} className="mt-1" />
                  <Label htmlFor="sp-terms" className="text-sm leading-relaxed cursor-pointer font-normal text-foreground">
                    J’ai lu et j’accepte les Conditions générales de vente et d’utilisation de Verebona, incluant la Politique de confidentialité.{' '}
                    <Link href={legal?.permalink ?? '/cgvu'} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Lire les conditions</Link>
                    {legal && <span className="block text-xs text-[color:var(--text-muted)] mt-1">Version {legal.versionCode}</span>}
                  </Label>
                </div>
                <Button type="submit" className="w-full min-h-11" disabled={busy}>{busy ? 'Création…' : 'Créer mon compte'}</Button>
                <Button type="button" variant="ghost" className="w-full" onClick={() => setView('choice')} disabled={busy}>Retour</Button>
              </form>
            )}

            {view === 'code' && (
              <form onSubmit={verifyCode} className="space-y-4" data-testid="social-email-code">
                <div className="space-y-2">
                  <Label htmlFor="sp-code">Code de confirmation</Label>
                  <Input
                    id="sp-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7}
                    value={code} onChange={(e) => setCode(e.target.value)} required disabled={busy}
                    className="text-center text-lg tracking-[.3em]"
                  />
                  <p className="text-xs text-[color:var(--text-muted)]">Le code est valable 15 minutes. Rien reçu ? Vérifiez vos courriers indésirables.</p>
                </div>
                {info && <p className="text-sm text-[color:var(--text-success)]">{info}</p>}
                <Button type="submit" className="w-full min-h-11" disabled={busy}>{busy ? 'Vérification…' : 'Confirmer et créer mon compte'}</Button>
                <div className="flex flex-col sm:flex-row gap-2">
                  <Button type="button" variant="outline" className="flex-1 min-h-11" onClick={resend} disabled={busy}>Renvoyer le code</Button>
                  <Button type="button" variant="ghost" className="flex-1 min-h-11" onClick={() => setView('profile')} disabled={busy}>Changer d’adresse</Button>
                </div>
              </form>
            )}

            <ErrorBox text={error} />

            {view !== 'loading' && view !== 'expired' && (
              <Button type="button" variant="ghost" className="w-full text-[color:var(--text-muted)]" onClick={cancel} disabled={busy}>
                Annuler
              </Button>
            )}
          </CardContent>
        </Card>
      </div>
      <AuthFooter />
    </div>
  );
}

export default function SocialPendingPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-[color:var(--bg-page)] text-[color:var(--text-muted)]">Chargement…</div>}>
      <SocialPending />
    </Suspense>
  );
}
