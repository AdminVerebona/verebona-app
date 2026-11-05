'use client';

/**
 * Seconde étape de connexion (lot 110B, ticket §3) — après le mot de passe
 * ou Google / Apple, dans le contexte PROVISOIRE : clé d'accès OU code de
 * l'application d'authentification, selon les méthodes réellement
 * configurées (jamais une méthode non enrôlée). La dernière méthode employée
 * SUR CET APPAREIL est proposée en premier (préférence locale, sans
 * privilège). Aucune méthode possible → récupération.
 */
import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { KeyRound, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MfaAuthCard, MfaAlert } from '@/components/auth/mfa/MfaAuthCard';
import {
  PASSKEY_ERROR_TEXT, getPasskeyAssertion, lastLocalMethod, mfaPost, passkeysUsableHere, rememberLocalMethod,
} from '@/lib/auth/mfa/client';
import { safeReturnUrl } from '@/lib/safe-redirect';

interface MfaState { step: 'challenge' | 'enroll'; primaryMethod: string; methods: { passkey: boolean; totp: boolean }; passkeysAvailable: boolean }

function Verification() {
  const router = useRouter();
  const sp = useSearchParams();
  const returnUrl = safeReturnUrl(sp.get('returnUrl'));
  const [state, setState] = useState<MfaState | null>(null);
  const [expired, setExpired] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'code' | 'passkey' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [webauthnHere, setWebauthnHere] = useState(false);

  useEffect(() => { void passkeysUsableHere().then(setWebauthnHere); }, []);

  const load = useCallback(async () => {
    const res = await fetch('/api/auth/mfa/state', { credentials: 'include', cache: 'no-store' }).catch(() => null);
    if (!res || !res.ok) { setExpired(true); return; }
    const s = await res.json() as MfaState;
    if (s.step === 'enroll') { router.replace(`/securiser-mon-compte?returnUrl=${encodeURIComponent(returnUrl)}`); return; }
    setState(s);
  }, [router, returnUrl]);
  useEffect(() => { void load(); }, [load]);

  const finish = (redirectTo: unknown, method: 'passkey' | 'totp') => {
    rememberLocalMethod(method);
    router.replace(typeof redirectTo === 'string' && redirectTo.startsWith('/') ? redirectTo : returnUrl);
  };

  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy('code'); setError(null);
    const r = await mfaPost<{ redirectTo?: string }>('/api/auth/mfa/totp/verify', { code: code.replace(/\s+/g, '') });
    setBusy(null);
    if (r.ok) return finish(r.data.redirectTo, 'totp');
    if (r.data.code === 'MFA_EXPIRED') { setExpired(true); return; }
    setError(r.data.message || 'Code incorrect.');
    setCode('');
  };

  const signInWithPasskey = async () => {
    if (busy) return;
    setBusy('passkey'); setError(null);
    try {
      const o = await mfaPost<{ options: unknown; challengeId: string }>('/api/auth/mfa/passkey/options', { mode: 'pending' });
      if (!o.ok) { if (o.data.code === 'MFA_EXPIRED') setExpired(true); else setError(o.data.message || PASSKEY_ERROR_TEXT.failed); return; }
      const a = await getPasskeyAssertion(o.data.options);
      if (!a.ok) { setError(PASSKEY_ERROR_TEXT[a.error]); return; }
      const v = await mfaPost<{ redirectTo?: string }>('/api/auth/mfa/passkey/verify', { mode: 'pending', challengeId: o.data.challengeId, response: a.response });
      if (v.ok) return finish(v.data.redirectTo, 'passkey');
      if (v.data.code === 'MFA_EXPIRED') { setExpired(true); return; }
      setError(v.data.message || PASSKEY_ERROR_TEXT.failed);
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    await mfaPost('/api/auth/mfa/cancel').catch(() => null);
    router.replace('/login');
  };

  if (expired) {
    return (
      <MfaAuthCard title="Confirmez votre connexion">
        <div className="space-y-4">
          <MfaAlert>Votre étape de connexion a expiré. Recommencez la connexion.</MfaAlert>
          <Button className="w-full" onClick={() => router.replace('/login')}>Se connecter</Button>
        </div>
      </MfaAuthCard>
    );
  }
  if (!state) {
    return <MfaAuthCard title="Confirmez votre connexion"><div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-[color:var(--text-muted)]" /></div></MfaAuthCard>;
  }

  const passkeyUsable = state.methods.passkey && state.passkeysAvailable && webauthnHere;
  const passkeyFirst = passkeyUsable && (lastLocalMethod() !== 'totp' || !state.methods.totp);
  const passkeyBlock = passkeyUsable && (
    <Button key="pk" type="button" className="w-full" variant={passkeyFirst ? 'default' : 'outline'} onClick={() => void signInWithPasskey()} disabled={busy !== null}>
      {busy === 'passkey' ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <KeyRound className="w-4 h-4 mr-2" />}
      Utiliser ma clé d’accès
    </Button>
  );
  const codeBlock = state.methods.totp && (
    <form key="code" onSubmit={submitCode} className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor="mfa-code">Code de votre application d’authentification</Label>
        <Input id="mfa-code" name="one-time-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7}
          value={code} onChange={(e) => setCode(e.target.value)} disabled={busy !== null} autoFocus={!passkeyFirst} />
      </div>
      <Button type="submit" className="w-full" variant={passkeyFirst ? 'outline' : 'default'} disabled={busy !== null || code.replace(/\s+/g, '').length !== 6}>
        {busy === 'code' && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}Valider le code
      </Button>
    </form>
  );
  const blocks = passkeyFirst ? [passkeyBlock, codeBlock] : [codeBlock, passkeyBlock];
  const nothing = !passkeyUsable && !state.methods.totp;

  return (
    <MfaAuthCard title="Confirmez votre connexion" description="Pour protéger vos biens et vos documents, confirmez votre identité avec votre méthode de sécurité.">
      <div className="space-y-4">
        {error && <MfaAlert>{error}</MfaAlert>}
        {nothing && (
          <MfaAlert tone="info">
            {state.methods.passkey
              ? 'Votre clé d’accès ne peut pas être utilisée sur cet appareil. Utilisez un appareil où elle est disponible, ou un code de récupération.'
              : 'Aucune méthode de sécurité n’est utilisable ici. Utilisez un code de récupération.'}
          </MfaAlert>
        )}
        {blocks.filter(Boolean).map((b, i) => (
          <div key={i}>{i > 0 && <div className="vb-or-separator mb-3" role="separator">ou</div>}{b}</div>
        ))}
        <div className="text-center space-y-2 text-sm">
          <Link href={`/recuperation?returnUrl=${encodeURIComponent(returnUrl)}`} className="text-primary hover:underline">
            Je n’ai plus accès à ma méthode de sécurité
          </Link>
          <div><Button variant="ghost" size="sm" onClick={() => void cancel()}>Annuler</Button></div>
        </div>
      </div>
    </MfaAuthCard>
  );
}

export default function VerificationPage() {
  return <Suspense fallback={null}><Verification /></Suspense>;
}
