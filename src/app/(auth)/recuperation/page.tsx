'use client';

/**
 * Récupération d'accès (lot 110B, ticket §5) : possession de l'adresse
 * (code reçu par e-mail ; pour un compte Google / Apple dont la connexion
 * vient d'être faite, la preuve du fournisseur en tient lieu) ET un code de
 * récupération. Puis enrôlement d'une nouvelle méthode — aucun accès aux
 * biens ni aux documents avant. Messages non énumérants.
 */
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MfaAuthCard, MfaAlert } from '@/components/auth/mfa/MfaAuthCard';
import { mfaPost } from '@/lib/auth/mfa/client';
import { safeReturnUrl } from '@/lib/safe-redirect';

const NO_RESET_TEXT = 'Si vous avez perdu à la fois vos méthodes de sécurité et tous vos codes de récupération, l’accès à votre compte ne peut pas être restauré : ni l’assistance ni un administrateur ne peuvent réinitialiser la double authentification.';

function Recovery() {
  const router = useRouter();
  const sp = useSearchParams();
  const returnUrl = safeReturnUrl(sp.get('returnUrl'));
  const [stage, setStage] = useState<'email' | 'codes'>('email');
  const [needsEmailCode, setNeedsEmailCode] = useState(true);
  const [email, setEmail] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Contexte Google / Apple déjà ouvert : pas de code e-mail.
  useEffect(() => {
    void fetch('/api/auth/mfa/state', { credentials: 'include', cache: 'no-store' }).then(async (r) => {
      if (!r.ok) return;
      const s = await r.json() as { recoveryNeedsEmailCode?: boolean };
      if (s.recoveryNeedsEmailCode === false) { setNeedsEmailCode(false); setStage('codes'); }
    }).catch(() => null);
  }, []);

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    const r = await mfaPost('/api/auth/mfa/recovery/start', { email });
    setBusy(false);
    if (!r.ok) { setError(r.data.message || 'Demande impossible pour le moment. Réessayez dans quelques minutes.'); return; }
    setInfo('Si un compte protégé correspond à cette adresse, un code de vérification vient de lui être envoyé.');
    setStage('codes');
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    const r = await mfaPost<{ redirectTo?: string }>('/api/auth/mfa/recovery/verify', { email, emailCode, recoveryCode });
    setBusy(false);
    if (!r.ok) { setError(r.data.message || 'Vérification impossible.'); return; }
    router.replace(`/securiser-mon-compte?returnUrl=${encodeURIComponent(returnUrl)}`);
  };

  return (
    <MfaAuthCard title="Retrouver l’accès à mon compte" description="Utilisez un de vos codes de récupération pour configurer une nouvelle méthode de sécurité.">
      <div className="space-y-4">
        {info && <MfaAlert tone="info">{info}</MfaAlert>}
        {error && <MfaAlert>{error}</MfaAlert>}
        {stage === 'email' ? (
          <form onSubmit={start} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="rc-email">Adresse e-mail du compte</Label>
              <Input id="rc-email" name="username" type="email" inputMode="email" autoComplete="username" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} required disabled={busy} />
            </div>
            <Button type="submit" className="w-full" disabled={busy || !email}>{busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}Recevoir un code de vérification</Button>
          </form>
        ) : (
          <form onSubmit={verify} className="space-y-3">
            {needsEmailCode && (
              <div className="space-y-1">
                <Label htmlFor="rc-email-code">Code reçu par e-mail</Label>
                <Input id="rc-email-code" name="one-time-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={emailCode} onChange={(e) => setEmailCode(e.target.value)} required disabled={busy} />
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="rc-code">Code de récupération</Label>
              <Input id="rc-code" name="recovery-code" autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="XXXX-XXXX-XXXX-XXXX"
                value={recoveryCode} onChange={(e) => setRecoveryCode(e.target.value)} required disabled={busy} />
            </div>
            <Button type="submit" className="w-full" disabled={busy || !recoveryCode || (needsEmailCode && emailCode.length !== 6)}>
              {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}Vérifier
            </Button>
            {needsEmailCode && <Button type="button" variant="ghost" className="w-full" onClick={() => setStage('email')} disabled={busy}>Renvoyer un code</Button>}
          </form>
        )}
        <p className="text-xs text-[color:var(--text-muted)]">{NO_RESET_TEXT}</p>
        <div className="text-center text-sm"><Link href="/login" className="text-primary hover:underline">Retour à la connexion</Link></div>
      </div>
    </MfaAuthCard>
  );
}

export default function RecoveryPage() {
  return <Suspense fallback={null}><Recovery /></Suspense>;
}
