"use client"

/**
 * « Activez votre compte » — lot 96A (CDC 18 Q9 / P1).
 *
 * Le lien reçu par e-mail ne suffit plus : il mène ici, et l'activation
 * demande le mot de passe choisi à l'inscription (`POST
 * /api/auth/verify-email`). Sans lui, rien n'est activé — un lien reçu pour
 * une inscription faite par quelqu'un d'autre avec votre adresse n'active
 * donc jamais ce compte. Reprise : « Recommencer mon inscription ».
 *
 * Même écran sur ordinateur et mobile (carte centrée, pleine largeur sous
 * 640 px), charte Sérénité. Après succès, la page de destination est celle
 * que donnait le lien auparavant (essai, Premium Duo, offre choisie).
 */
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { AlertCircle, KeyRound, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import { LogoWithBaseline } from '@/components/Logo';
import { LandingFooter } from '@/components/LandingFooter';
import { FollowTheme } from '@/components/FollowTheme';

type Failure = { code: string; message: string; restartUrl?: string; email?: string; retryAfterSeconds?: number };

/** Codes pour lesquels le formulaire n'a plus d'objet (le lien lui-même est en cause). */
const LINK_DEAD = new Set(['MISSING_TOKEN', 'LINK_OUTDATED', 'INVALID_TOKEN', 'TOKEN_EXPIRED', 'ALREADY_VERIFIED']);

function ActivateContent() {
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const plan = params.get('plan');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const res = await fetch('/api/auth/verify-email', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password, ...(plan ? { plan } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && typeof data.redirectTo === 'string') {
        window.location.assign(data.redirectTo);
        return;
      }
      if (res.status === 429) {
        const minutes = Math.max(1, Math.ceil((Number(data.retryAfterSeconds) || 60) / 60));
        setFailure({ code: 'RATE_LIMIT_EXCEEDED', message: `Trop d’essais. Pour protéger ce compte, réessayez dans ${minutes} minute${minutes > 1 ? 's' : ''}.` });
      } else {
        setFailure({ code: data.code ?? 'SERVER_ERROR', message: data.message ?? 'Activation impossible pour le moment.', restartUrl: data.restartUrl, email: data.email });
      }
      setPassword('');
    } catch {
      setFailure({ code: 'SERVER_ERROR', message: 'Activation impossible pour le moment. Vérifiez votre connexion et réessayez.' });
    } finally {
      setBusy(false);
    }
  };

  const dead = !token || (failure && LINK_DEAD.has(failure.code));
  const resendHref = failure?.email ? `/verify-email?error=token_expired&email=${encodeURIComponent(failure.email)}` : '/verify-email';

  return (
    <Shell>
      <CardHeader className="space-y-4">
        <div className="flex justify-center"><LogoWithBaseline size={50} /></div>
        <div className="flex justify-center">
          {dead
            ? <AlertCircle className="w-14 h-14 text-[color:var(--attention-on-soft)]" />
            : <KeyRound className="w-14 h-14 text-[color:var(--accent)]" />}
        </div>
        <CardTitle role="heading" aria-level={1} className="text-center text-[26px] font-extrabold tracking-[-.02em] text-[color:var(--text-primary)]">
          {dead ? (failure?.code === 'ALREADY_VERIFIED' ? 'Compte déjà activé' : 'Ce lien ne peut pas être utilisé') : 'Activez votre compte'}
        </CardTitle>
        <CardDescription className="text-center text-[color:var(--text-muted)]">
          {dead
            ? (failure?.message ?? 'Ce lien est incomplet. Copiez-le entièrement depuis l’e-mail, ou demandez-en un nouveau.')
            : 'Pour terminer, saisissez le mot de passe que vous avez choisi en créant votre compte. C’est ce qui prouve que cette inscription est bien la vôtre.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!dead && (
          <form onSubmit={submit} className="space-y-3" data-testid="activation-form">
            <div className="space-y-1.5">
              <Label htmlFor="signup-password">Mot de passe choisi à l’inscription</Label>
              <PasswordInput id="signup-password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
            </div>
            {failure && (
              <p role="alert" className="text-sm text-[color:var(--danger)]">{failure.message}</p>
            )}
            <Button type="submit" className="w-full min-h-11" disabled={busy || !password}>
              {busy ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Activation…</> : 'Activer mon compte'}
            </Button>
          </form>
        )}
        {failure?.code === 'ALREADY_VERIFIED' ? (
          <Button asChild className="w-full min-h-11"><Link href="/login">Se connecter</Link></Button>
        ) : (
          <div className="rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--bg-page)] p-3 text-sm text-[color:var(--text-muted)] space-y-2">
            <p>
              Vous ne reconnaissez pas cette inscription, ou vous avez oublié le mot de passe choisi ? Recommencez votre
              inscription avec cette adresse : la demande en attente sera remplacée. Si vous avez été invité, repartez du lien
              d’invitation.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button asChild variant="outline" className="w-full min-h-11 sm:w-auto"><Link href="/signup">Recommencer mon inscription</Link></Button>
              {dead && failure?.code !== 'INVALID_TOKEN' && (
                <Button asChild variant="ghost" className="w-full min-h-11 sm:w-auto"><Link href={resendHref}>Recevoir un nouveau lien</Link></Button>
              )}
            </div>
          </div>
        )}
        <div className="text-center text-sm text-[color:var(--text-muted)]">
          Déjà activé ? <Link href="/login" className="text-primary hover:underline">Se connecter</Link>
        </div>
      </CardContent>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="public-page min-h-screen flex flex-col bg-[color:var(--bg-page)]">
      <FollowTheme />
      <div className="flex-1 flex items-center justify-center p-4">
        <Card className="w-full max-w-md bg-[color:var(--bg-card)] border-[color:var(--border-subtle)] shadow-xl">
          {children}
        </Card>
      </div>
      <LandingFooter />
    </div>
  );
}

export default function ActivateAccountPage() {
  // `useSearchParams` impose une frontière Suspense en rendu statique.
  return (
    <Suspense fallback={<Shell><CardHeader><div className="flex justify-center"><Loader2 className="w-10 h-10 animate-spin text-[color:var(--text-muted)]" /></div></CardHeader></Shell>}>
      <ActivateContent />
    </Suspense>
  );
}
