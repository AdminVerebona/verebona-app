'use client';

/**
 * « Sécurisez votre compte » — premier facteur obligatoire (lot 110B, ticket
 * §2). Affiché dans le contexte PROVISOIRE (aucun accès aux biens ni aux
 * documents tant qu'il n'est pas terminé) : après l'inscription ou
 * l'activation, à la première connexion après l'activation de l'obligation,
 * ou après une récupération d'accès. Textes exacts du ticket.
 */
import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { KeyRound, Loader2, ShieldCheck, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MfaAuthCard, MfaAlert } from '@/components/auth/mfa/MfaAuthCard';
import { RecoveryCodesView } from '@/components/auth/mfa/RecoveryCodesView';
import { TotpSetup, type TotpStart } from '@/components/auth/mfa/TotpSetup';
import { PASSKEY_ERROR_TEXT, createPasskey, mfaPost, passkeysUsableHere, rememberLocalMethod } from '@/lib/auth/mfa/client';
import { publicSiteUrl } from '@/lib/external-urls';
import { safeReturnUrl } from '@/lib/safe-redirect';
import { PASSKEY_CARD_TEXT, PASSKEY_CARD_TITLE, SECURE_ACCOUNT_INTRO, SECURE_ACCOUNT_TITLE, TOTP_CARD_TITLE } from '@/components/auth/mfa/texts';

interface MfaState {
  step: 'challenge' | 'enroll';
  primaryMethod: string;
  hasPassword: boolean;
  passkeysAvailable: boolean;
  factorEnrolled: boolean;
  recovered: boolean;
}

type View = 'loading' | 'expired' | 'choose' | 'totp' | 'passkey' | 'codes' | 'done';


function SecureAccount() {
  const router = useRouter();
  const sp = useSearchParams();
  const returnUrl = safeReturnUrl(sp.get('returnUrl'));
  const [view, setView] = useState<View>('loading');
  const [state, setState] = useState<MfaState | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [redirectTo, setRedirectTo] = useState<string>(returnUrl);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [webauthnHere, setWebauthnHere] = useState(false);
  const [factor, setFactor] = useState<'passkey' | 'totp'>('totp');

  useEffect(() => { void passkeysUsableHere().then(setWebauthnHere); }, []);

  const load = useCallback(async () => {
    const res = await fetch('/api/auth/mfa/state', { credentials: 'include', cache: 'no-store' }).catch(() => null);
    if (!res || !res.ok) { setView('expired'); return; }
    const s = await res.json() as MfaState;
    if (s.step === 'challenge') { router.replace(`/verification?returnUrl=${encodeURIComponent(returnUrl)}`); return; }
    setState(s);
    if (s.factorEnrolled) {
      // Codes perdus au rechargement : le facteur vient d'être prouvé — nouveaux codes.
      const r = await mfaPost<{ recoveryCodes?: string[] }>('/api/auth/mfa/recovery-codes/confirm', { regenerate: true });
      if (r.ok && r.data.recoveryCodes) { setCodes(r.data.recoveryCodes); setView('codes'); return; }
      setView('expired');
      return;
    }
    setView('choose');
  }, [router, returnUrl]);

  useEffect(() => { void load(); }, [load]);

  const cancel = async () => {
    await mfaPost('/api/auth/mfa/cancel').catch(() => null);
    router.replace('/login');
  };

  const startTotp = useCallback(async (): Promise<TotpStart> => {
    const r = await mfaPost<TotpStart>('/api/auth/mfa/totp/enroll', { stage: 'start' });
    if (!r.ok) throw new Error(r.data.message || 'Configuration impossible pour le moment.');
    return r.data;
  }, []);

  const confirmTotp = async (code: string): Promise<string | null> => {
    const r = await mfaPost<{ recoveryCodes?: string[] }>('/api/auth/mfa/totp/enroll', { stage: 'confirm', code });
    if (r.status === 401 && r.data.code === 'MFA_EXPIRED') { setView('expired'); return null; }
    if (!r.ok) return r.data.message || 'Code incorrect.';
    setFactor('totp');
    setCodes(r.data.recoveryCodes ?? []);
    setView('codes');
    return null;
  };

  const enrollPasskey = async () => {
    setBusy(true);
    setError(null);
    try {
      const o = await mfaPost<{ options: unknown; challengeId: string }>('/api/auth/mfa/passkey/register', { stage: 'options' });
      if (!o.ok) { setError(o.data.message || 'Les clés d’accès ne sont pas disponibles pour le moment.'); return; }
      const c = await createPasskey(o.data.options);
      if (!c.ok) { setError(PASSKEY_ERROR_TEXT[c.error]); return; }
      const v = await mfaPost<{ recoveryCodes?: string[] }>('/api/auth/mfa/passkey/register', { stage: 'verify', challengeId: o.data.challengeId, response: c.response });
      if (!v.ok) { setError(v.data.message || PASSKEY_ERROR_TEXT.failed); return; }
      setFactor('passkey');
      setCodes(v.data.recoveryCodes ?? []);
      setView('codes');
    } finally {
      setBusy(false);
    }
  };

  const confirmCodes = async () => {
    const r = await mfaPost<{ redirectTo?: string }>('/api/auth/mfa/recovery-codes/confirm', { confirmed: true });
    if (!r.ok) { setError(r.data.message || 'La connexion n’a pas pu être terminée. Recommencez.'); return; }
    rememberLocalMethod(factor);
    setRedirectTo(typeof r.data.redirectTo === 'string' ? r.data.redirectTo : returnUrl);
    setView('done');
  };

  if (view === 'loading') {
    return <MfaAuthCard title={SECURE_ACCOUNT_TITLE}><div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-[color:var(--text-muted)]" /></div></MfaAuthCard>;
  }
  if (view === 'expired') {
    return (
      <MfaAuthCard title={SECURE_ACCOUNT_TITLE}>
        <div className="space-y-4">
          <MfaAlert>Votre étape de connexion a expiré. Reconnectez-vous pour sécuriser votre compte.</MfaAlert>
          <Button className="w-full" onClick={() => router.replace('/login')}>Se connecter</Button>
        </div>
      </MfaAuthCard>
    );
  }
  if (view === 'codes') {
    return (
      <MfaAuthCard title="Vos codes de récupération" description="Ils vous permettront de retrouver l’accès à votre compte si vous perdez votre méthode de sécurité.">
        {error && <div className="mb-3"><MfaAlert>{error}</MfaAlert></div>}
        <RecoveryCodesView codes={codes} onConfirm={confirmCodes} />
      </MfaAuthCard>
    );
  }
  if (view === 'done') {
    return (
      <MfaAuthCard title="Votre compte est sécurisé">
        <div className="space-y-4">
          <p className="text-sm text-[color:var(--text-muted)]">
            Conseil : ajoutez une seconde méthode (une autre clé d’accès ou une application d’authentification) dans
            Mon compte › Sécurité, pour ne jamais être bloqué.
          </p>
          <Button className="w-full" onClick={() => router.replace(redirectTo)}>Continuer</Button>
        </div>
      </MfaAuthCard>
    );
  }
  if (view === 'totp') {
    return (
      <MfaAuthCard title={TOTP_CARD_TITLE}>
        <TotpSetup start={startTotp} confirm={confirmTotp} onCancel={() => setView('choose')} />
      </MfaAuthCard>
    );
  }

  const social = state?.primaryMethod === 'google' || state?.primaryMethod === 'apple';
  const passkeyPossible = !!state?.passkeysAvailable && webauthnHere;
  return (
    <MfaAuthCard title={SECURE_ACCOUNT_TITLE} description={SECURE_ACCOUNT_INTRO} wide>
      <div className="space-y-4">
        {state?.recovered && <MfaAlert tone="info">Accès vérifié. Configurez maintenant une nouvelle méthode de sécurité.</MfaAlert>}
        {error && <MfaAlert>{error}</MfaAlert>}
        <div className="grid gap-3 sm:grid-cols-2">
          <section className="rounded-xl border border-[color:var(--border-subtle)] p-4 space-y-3 flex flex-col" data-testid="mfa-card-passkey">
            <div className="flex items-center gap-2">
              <KeyRound className="w-5 h-5 text-[color:var(--accent)]" />
              <h2 className="font-semibold">{PASSKEY_CARD_TITLE}</h2>
              <span className="ml-auto text-xs rounded-full bg-[color:var(--bg-success)] text-[color:var(--text-success)] px-2 py-0.5">Recommandée</span>
            </div>
            <p className="text-sm text-[color:var(--text-muted)] flex-1">{PASSKEY_CARD_TEXT}</p>
            {passkeyPossible
              ? <Button onClick={() => void enrollPasskey()} disabled={busy}>{busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}Créer une clé d’accès</Button>
              : <p className="text-xs text-[color:var(--text-muted)]">Non disponible sur cet appareil : choisissez le code de sécurité.</p>}
          </section>
          <section className="rounded-xl border border-[color:var(--border-subtle)] p-4 space-y-3 flex flex-col" data-testid="mfa-card-totp">
            <div className="flex items-center gap-2">
              <Smartphone className="w-5 h-5 text-[color:var(--accent)]" />
              <h2 className="font-semibold">{TOTP_CARD_TITLE}</h2>
            </div>
            <p className="text-sm text-[color:var(--text-muted)] flex-1">
              {social && !state?.hasPassword
                ? 'Vous vous connectez avec Google ou Apple : un code généré par une application d’authentification complètera chaque connexion. Vous pourrez ajouter un mot de passe ensuite dans Mon compte › Sécurité.'
                : 'Votre mot de passe, puis un code à 6 chiffres généré par une application d’authentification sur votre téléphone.'}
            </p>
            <Button variant="outline" onClick={() => { setError(null); setView('totp'); }} disabled={busy}>Configurer le code de sécurité</Button>
          </section>
        </div>
        <p className="text-xs text-[color:var(--text-muted)] flex items-start gap-1.5">
          <ShieldCheck className="w-4 h-4 shrink-0" />
          Vous pourrez ajouter d’autres méthodes ensuite. Tant que cette étape n’est pas terminée, vos biens et vos documents restent inaccessibles.
        </p>
        <div className="flex flex-col sm:flex-row gap-2 sm:justify-between text-sm">
          <Button variant="ghost" onClick={() => void cancel()}>Annuler et me déconnecter</Button>
          <Link href={publicSiteUrl('/contact')} className="self-center text-primary hover:underline" target="_blank" rel="noopener noreferrer">
            Résilier ou exercer mes droits sans me connecter
          </Link>
        </div>
      </div>
    </MfaAuthCard>
  );
}

export default function SecureAccountPage() {
  return <Suspense fallback={null}><SecureAccount /></Suspense>;
}
