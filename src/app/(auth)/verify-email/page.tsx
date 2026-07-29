"use client"

/**
 * Page de vérification de l'adresse email.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI CETTE PAGE EXISTE
 *
 * Elle n'existait pas. Deux parcours y menaient pourtant :
 *
 *   1. la fin de l'inscription — `router.push('/verify-email?email=...')` ;
 *   2. le lien reçu par email — `/api/auth/verify-email` redirige vers
 *      `/verify-email?status=...` ou `?error=...` dans les six cas de sortie.
 *
 * Les deux aboutissaient donc à un 404 : la création de compte paraissait
 * cassée même lorsque le compte était correctement créé côté serveur.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Aucun jeton ne transite plus par l'URL : la session est établie par les
 * cookies HttpOnly posés par la route de vérification (CDC cookies §5.1).
 */

import { useState, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LogoWithBaseline } from '@/components/Logo';
import { LandingFooter } from '@/components/LandingFooter';
import { ForceTheme } from '@/components/ForceTheme';
import { MailCheck, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';

/** Cas de sortie produits par `/api/auth/verify-email`. */
type VerificationError =
  | 'missing_token'
  | 'token_expired'
  | 'invalid_token'
  | 'user_not_found'
  | 'server_error';

/**
 * Messages d'erreur. Chacun dit ce qui s'est passé ET ce que l'utilisateur
 * peut faire : une page d'erreur sans issue est une impasse.
 */
const ERROR_CONTENT: Record<VerificationError, { title: string; message: string; canResend: boolean }> = {
  missing_token: {
    title: 'Lien incomplet',
    message:
      "Ce lien ne contient pas le jeton de vérification. Il a probablement été tronqué par votre messagerie. Copiez-le entièrement, ou demandez-en un nouveau.",
    canResend: true,
  },
  token_expired: {
    title: 'Lien expiré',
    message:
      "Ce lien de vérification a plus de 24 heures et n'est plus valable. Demandez-en un nouveau, il arrivera dans quelques instants.",
    canResend: true,
  },
  invalid_token: {
    title: 'Lien invalide',
    message:
      "Ce lien n'a pas pu être lu. Vérifiez que vous l'avez copié en entier, ou demandez un nouvel envoi.",
    canResend: true,
  },
  user_not_found: {
    title: 'Compte introuvable',
    message:
      "Aucun compte ne correspond à ce lien. Il se peut que le compte ait été supprimé entre-temps.",
    canResend: false,
  },
  server_error: {
    title: 'Vérification impossible pour le moment',
    message:
      "Un incident technique nous empêche de vérifier votre adresse. Votre compte n'est pas perdu : réessayez dans quelques minutes.",
    canResend: true,
  },
};

function VerifyEmailContent() {
  const params = useSearchParams();
  const router = useRouter();

  const status = params.get('status');
  const rawError = params.get('error');
  const emailFromUrl = params.get('email') ?? '';

  const error = (rawError && rawError in ERROR_CONTENT ? rawError : null) as VerificationError | null;

  const [resendEmail, setResendEmail] = useState(emailFromUrl);
  const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');

  const handleResend = async () => {
    if (!resendEmail) return;
    setResendState('sending');
    try {
      const response = await fetch('/api/auth/resend-verification', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: resendEmail }),
      });
      // La route répond volontairement de façon identique que le compte existe
      // ou non, pour ne pas permettre d'énumérer les adresses inscrites.
      setResendState(response.ok ? 'sent' : 'failed');
    } catch {
      setResendState('failed');
    }
  };

  // ── Vérification réussie ────────────────────────────────────────────────
  if (status === 'success' || status === 'already_verified') {
    const alreadyVerified = status === 'already_verified';
    return (
      <Shell>
        <CardHeader className="space-y-4">
          <div className="flex justify-center">
            <LogoWithBaseline size={50} />
          </div>
          <div className="flex justify-center">
            <CheckCircle className="w-14 h-14 text-emerald-500" />
          </div>
          <CardTitle className="text-center text-[color:var(--text-primary)]">
            {alreadyVerified ? 'Adresse déjà vérifiée' : 'Adresse vérifiée'}
          </CardTitle>
          <CardDescription className="text-center text-[color:var(--text-muted)]">
            {alreadyVerified
              ? 'Votre adresse email était déjà confirmée. Vous pouvez vous connecter.'
              : 'Votre compte est actif. Votre essai gratuit de 7 jours a commencé.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!alreadyVerified && (
            <div className="bg-blue-950/30 border border-blue-500/25 rounded-lg p-3 text-sm text-[color:var(--text-muted)]">
              Pendant 7 jours, toutes les fonctions Premium sont accessibles, dans la
              limite de 2 biens et 30 documents. Aucune carte bancaire n&apos;a été
              enregistrée et aucun prélèvement n&apos;aura lieu à la fin de l&apos;essai.
            </div>
          )}
          <Button className="w-full" onClick={() => router.push('/accueil')}>
            Accéder à Verebona
          </Button>
        </CardContent>
      </Shell>
    );
  }

  // ── Échec de la vérification ────────────────────────────────────────────
  if (error) {
    const content = ERROR_CONTENT[error];
    return (
      <Shell>
        <CardHeader className="space-y-4">
          <div className="flex justify-center">
            <LogoWithBaseline size={50} />
          </div>
          <div className="flex justify-center">
            <AlertCircle className="w-14 h-14 text-amber-500" />
          </div>
          <CardTitle className="text-center text-[color:var(--text-primary)]">{content.title}</CardTitle>
          <CardDescription className="text-center text-[color:var(--text-muted)]">
            {content.message}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {content.canResend && (
            <ResendBlock
              email={resendEmail}
              onEmailChange={setResendEmail}
              state={resendState}
              onResend={handleResend}
            />
          )}
          <div className="text-center text-sm text-[color:var(--text-muted)]">
            <Link href="/login" className="text-primary hover:underline">
              Retour à la connexion
            </Link>
          </div>
        </CardContent>
      </Shell>
    );
  }

  // ── Arrivée depuis l'inscription : en attente de vérification ───────────
  return (
    <Shell>
      <CardHeader className="space-y-4">
        <div className="flex justify-center">
          <LogoWithBaseline size={50} />
        </div>
        <div className="flex justify-center">
          <MailCheck className="w-14 h-14 text-blue-400" />
        </div>
        <CardTitle className="text-center text-[color:var(--text-primary)]">
          Vérifiez votre boîte mail
        </CardTitle>
        <CardDescription className="text-center text-[color:var(--text-muted)]">
          {emailFromUrl ? (
            <>
              Nous avons envoyé un lien de confirmation à{' '}
              <span className="font-medium text-[color:var(--text-primary)]">{emailFromUrl}</span>.
              Cliquez dessus pour activer votre compte et démarrer votre essai.
            </>
          ) : (
            <>
              Nous vous avons envoyé un lien de confirmation. Cliquez dessus pour
              activer votre compte et démarrer votre essai.
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-[color:var(--text-muted)] text-center">
          Le lien est valable 24 heures. Pensez à regarder dans vos courriers indésirables.
        </p>
        <ResendBlock
          email={resendEmail}
          onEmailChange={setResendEmail}
          state={resendState}
          onResend={handleResend}
        />
        <div className="text-center text-sm text-[color:var(--text-muted)]">
          Déjà vérifié ?{' '}
          <Link href="/login" className="text-primary hover:underline">
            Se connecter
          </Link>
        </div>
      </CardContent>
    </Shell>
  );
}

function ResendBlock({
  email,
  onEmailChange,
  state,
  onResend,
}: {
  email: string;
  onEmailChange: (value: string) => void;
  state: 'idle' | 'sending' | 'sent' | 'failed';
  onResend: () => void;
}) {
  if (state === 'sent') {
    return (
      <div className="bg-emerald-950/30 border border-emerald-500/25 rounded-lg p-3 text-sm text-[color:var(--text-muted)]">
        Si un compte existe avec cette adresse, un nouveau lien vient d&apos;être envoyé.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {!email && (
        <input
          type="email"
          value={email}
          onChange={(e) => onEmailChange(e.target.value)}
          placeholder="Votre adresse email"
          className="w-full rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-page)] px-3 py-2 text-sm text-[color:var(--text-primary)]"
        />
      )}
      <Button
        type="button"
        variant="outline"
        className="w-full"
        disabled={!email || state === 'sending'}
        onClick={onResend}
      >
        {state === 'sending' ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Envoi…
          </>
        ) : (
          'Renvoyer le lien de vérification'
        )}
      </Button>
      {state === 'failed' && (
        <p className="text-xs text-destructive text-center">
          L&apos;envoi a échoué. Réessayez dans quelques instants.
        </p>
      )}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="public-page min-h-screen flex flex-col bg-[color:var(--bg-page)]">
      <ForceTheme theme="blue" />
      <div className="flex-1 flex items-center justify-center p-4">
        <Card className="w-full max-w-md bg-[color:var(--bg-card)] border-[color:var(--border-subtle)] shadow-xl">
          {children}
        </Card>
      </div>
      <LandingFooter />
    </div>
  );
}

export default function VerifyEmailPage() {
  // `useSearchParams` impose une frontière Suspense en rendu statique.
  return (
    <Suspense
      fallback={
        <Shell>
          <CardHeader className="space-y-4">
            <div className="flex justify-center">
              <LogoWithBaseline size={50} />
            </div>
            <div className="flex justify-center">
              <Loader2 className="w-10 h-10 animate-spin text-[color:var(--text-muted)]" />
            </div>
          </CardHeader>
        </Shell>
      }
    >
      <VerifyEmailContent />
    </Suspense>
  );
}
