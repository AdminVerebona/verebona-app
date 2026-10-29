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
 *      `/verify-email?status=...` ou `?error=...` (dont `link_outdated` pour
 *      les liens émis avant le passage au lien signé).
 *
 * Les deux aboutissaient donc à un 404 : la création de compte paraissait
 * cassée même lorsque le compte était correctement créé côté serveur.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Aucun jeton ne transite plus par l'URL : la session est établie par les
 * cookies HttpOnly posés par la route de vérification (CDC cookies §5.1).
 */

import { useEffect, useRef, useState, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LogoWithBaseline } from '@/components/Logo';
import { LandingFooter } from '@/components/LandingFooter';
import { FollowTheme } from '@/components/FollowTheme';
import { MailCheck, CheckCircle, AlertCircle, Loader2, Users } from 'lucide-react';
import { publicSiteUrl } from '@/lib/external-urls';
import { duoJoinErrorMessage, joinDuo, peekPendingDuoJoin, settlePendingDuoJoin } from '@/lib/duo/pending-duo-join';

/** Lot 57A : accès à l'assistance quand l'e-mail n'arrive pas (site public). */
function SupportHint() {
  return (
    <p className="text-xs text-[color:var(--text-muted)] text-center">
      Toujours rien après quelques minutes ? Vérifiez vos courriers indésirables, renvoyez le lien, ou{' '}
      <a href={publicSiteUrl('/contact')} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
        contactez l&apos;assistance
      </a>
      .
    </p>
  );
}

/**
 * Lot 57A / ticket P2 : après vérification, rattachement au Premium Duo.
 * Jeton mémorisé dans ce navigateur → tentative automatique (parcours de
 * l'invitation) ; sinon (e-mail ouvert dans un autre navigateur) → bouton,
 * le serveur retrouvant l'invitation adressée à l'adresse vérifiée.
 * Le jeton n'est retiré qu'après confirmation ou refus définitif.
 */
function DuoJoinAfterVerification() {
  const [state, setState] = useState<'idle' | 'joining' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const started = useRef(false);

  const join = async () => {
    setState('joining');
    const token = peekPendingDuoJoin();
    const result = await joinDuo(token);
    settlePendingDuoJoin(token, result);
    if (result.ok) {
      setState('done');
      // Lot 72D : la session vient d'être rouverte sur l'espace du Duo
      // (cookies réémis) — rechargement complet pour repartir de ce compte
      // (identité, offre, caches du navigateur).
      setTimeout(() => window.location.assign('/accueil'), 1500);
    } else {
      setMessage(result.message || duoJoinErrorMessage(result.error));
      setState('error');
    }
  };

  useEffect(() => {
    if (started.current || !peekPendingDuoJoin()) return;
    started.current = true;
    void join();
  }, []);

  return (
    <div className="bg-[color:var(--bg-success)] border border-[color:var(--border-success)] rounded-lg p-3 space-y-3" data-testid="duo-join-after-verification">
      <div className="flex items-start gap-3 text-sm">
        <Users className="w-5 h-5 text-[color:var(--text-success)] flex-shrink-0 mt-0.5" />
        <p className="text-[color:var(--text-muted)]">
          {state === 'done'
            ? 'Vous avez rejoint l’espace Premium Duo. Redirection vers l’accueil…'
            : 'Vous avez été invité à rejoindre un abonnement Premium Duo. Votre adresse étant vérifiée, vous pouvez maintenant accepter l’invitation.'}
        </p>
      </div>
      {state === 'error' && <p className="text-xs text-destructive">{message}</p>}
      {state !== 'done' && (
        <Button className="w-full" onClick={() => void join()} disabled={state === 'joining'}>
          {state === 'joining' ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Rattachement…</> : state === 'error' ? 'Réessayer' : 'Rejoindre le Duo'}
        </Button>
      )}
    </div>
  );
}

/** Cas de sortie produits par `/api/auth/verify-email`. */
type VerificationError =
  | 'link_outdated'
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
  // Liens envoyés avant le passage au lien signé : ils ne sont plus acceptés
  // (ils pouvaient être fabriqués). Le compte n'est pas en cause, et un
  // nouveau lien suffit — c'est ce que le message doit dire en premier.
  link_outdated: {
    title: 'Ce lien n’est plus valable',
    message:
      "Pour mieux protéger votre compte, nous avons changé le format des liens de vérification : celui-ci, envoyé avant ce changement, ne fonctionne plus. Votre compte n'est pas perdu. Demandez un nouveau lien ci-dessous, il arrivera dans quelques instants.",
    canResend: true,
  },
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
  // Lot 96A (CDC 18 Q9) : aussi le lien d'une inscription REMPLACÉE par une
  // inscription plus récente avec la même adresse — reprise de l'inscription.
  invalid_token: {
    title: 'Lien invalide',
    message:
      "Ce lien ne correspond à aucune inscription en attente. Vérifiez que vous l'avez copié en entier et qu'il s'agit du dernier lien reçu. Si vous venez de vous inscrire, le plus simple est de recommencer votre inscription.",
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
  // Contexte Premium Duo (lot 57A, P2) : posé par l'inscription d'un invité
  // et par la route de vérification (invitation en attente pour l'adresse).
  // Indication d'affichage seulement : le rattachement est contrôlé côté serveur.
  const duoContext = params.get('duo') === '1';
  // Lot 72D : identité qui rejoint un compte existant (Duo ou compte
  // partagé) — aucun essai n'est attribué, il ne doit pas être annoncé.
  const joinsSharedSpace = duoContext || params.get('joined') === '1' || params.get('space') === 'none';

  const error = (rawError && rawError in ERROR_CONTENT ? rawError : null) as VerificationError | null;

  const [resendEmail, setResendEmail] = useState(emailFromUrl);
  const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');

  const handleResend = async () => {
    if (!resendEmail) return;
    setResendState('sending');
    try {
      const response = await fetch('/api/auth/resend-verification', {
      credentials: 'include',
        method: 'POST',
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
            <CheckCircle className="w-14 h-14 text-[color:var(--text-success)]" />
          </div>
          <CardTitle role="heading" aria-level={1} className="text-center text-[26px] font-extrabold tracking-[-.02em] text-[color:var(--text-primary)]">
            {alreadyVerified ? 'Adresse déjà vérifiée' : 'Adresse vérifiée'}
          </CardTitle>
          <CardDescription className="text-center text-[color:var(--text-muted)]">
            {/* Un lien déjà utilisé n'ouvre plus de session (usage unique) :
                d'où l'invitation à se connecter, pas à « accéder ». */}
            {alreadyVerified
              ? 'Votre adresse email était déjà confirmée. Vous pouvez vous connecter.'
              : joinsSharedSpace
                ? 'Votre identité Verebona est active.'
                : 'Votre compte est actif. Votre essai gratuit de 7 jours a commencé.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!alreadyVerified && !joinsSharedSpace && (
            <div className="bg-[color:var(--accent-soft)] border border-[color:var(--border-info)] rounded-lg p-3 text-sm text-[color:var(--text-muted)]">
              Pendant 7 jours, toutes les fonctions Premium sont accessibles, dans la
              limite de 2 biens et 30 documents. Aucune carte bancaire n&apos;a été
              enregistrée et aucun prélèvement n&apos;aura lieu à la fin de l&apos;essai.
            </div>
          )}
          {duoContext && !alreadyVerified && <DuoJoinAfterVerification />}
          <Button
            className="w-full"
            variant={duoContext && !alreadyVerified ? 'outline' : 'default'}
            onClick={() => router.push(alreadyVerified ? '/login' : '/accueil')}
          >
            {alreadyVerified ? 'Se connecter' : 'Accéder à Verebona'}
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
            <AlertCircle className="w-14 h-14 text-[color:var(--attention-on-soft)]" />
          </div>
          <CardTitle role="heading" aria-level={1} className="text-center text-[26px] font-extrabold tracking-[-.02em] text-[color:var(--text-primary)]">{content.title}</CardTitle>
          <CardDescription className="text-center text-[color:var(--text-muted)]">
            {content.message}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {content.canResend && (
            <ResendBlock
              email={resendEmail}
              askEmail={!emailFromUrl}
              onEmailChange={setResendEmail}
              state={resendState}
              onResend={handleResend}
            />
          )}
          {error === 'invalid_token' && (
            <Button asChild variant="outline" className="w-full" data-testid="restart-signup">
              <Link href="/signup">Recommencer mon inscription</Link>
            </Button>
          )}
          {content.canResend && <SupportHint />}
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
          <MailCheck className="w-14 h-14 text-[color:var(--accent)]" />
        </div>
        <CardTitle role="heading" aria-level={1} className="text-center text-[26px] font-extrabold tracking-[-.02em] text-[color:var(--text-primary)]">
          Vérifiez votre boîte mail
        </CardTitle>
        <CardDescription className="text-center text-[color:var(--text-muted)]">
          {/* Lot 53A (CDC 18 §7.1, §9.1) : texte NEUTRE — l'inscription répond
              de la même façon si l'adresse a déjà un compte ; l'e-mail reçu dit
              alors comment se connecter. Même composant mobile et ordinateur. */}
          {/* Lot 57A (P0-A) : une DEMANDE est enregistrée — l'expédition
              n'est pas annoncée comme faite. */}
          {emailFromUrl ? (
            <>
              Votre demande est enregistrée : un e-mail va être envoyé à{' '}
              <span className="font-medium text-[color:var(--text-primary)]">{emailFromUrl}</span>{' '}
              dans quelques instants. Cliquez sur le lien qu&apos;il contient, puis saisissez votre mot de passe, pour activer votre compte
              {joinsSharedSpace ? '.' : ' et démarrer votre essai.'}
            </>
          ) : (
            <>
              Votre demande est enregistrée : un e-mail va vous être envoyé dans quelques instants.
              Cliquez sur le lien qu&apos;il contient, puis saisissez votre mot de passe, pour activer votre compte
              {joinsSharedSpace ? '.' : ' et démarrer votre essai.'}
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-[color:var(--text-muted)] text-center">
          Le lien est valable 24 heures. Pensez à regarder dans vos courriers indésirables.
          Si cette adresse a déjà un compte Verebona, l&apos;e-mail vous indique simplement comment vous connecter.
        </p>
        {duoContext && (
          <p className="text-xs text-[color:var(--text-muted)] text-center" data-testid="duo-context-pending">
            Une fois votre adresse vérifiée, vous pourrez rejoindre l&apos;abonnement Premium Duo auquel vous avez été invité,
            même si vous ouvrez l&apos;e-mail sur un autre appareil.
          </p>
        )}
        <ResendBlock
          email={resendEmail}
          askEmail={!emailFromUrl}
          onEmailChange={setResendEmail}
          state={resendState}
          onResend={handleResend}
        />
        <SupportHint />
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
  askEmail,
  onEmailChange,
  state,
  onResend,
}: {
  email: string;
  /** Adresse inconnue de l'URL : le champ reste affiché pendant la saisie. */
  askEmail: boolean;
  onEmailChange: (value: string) => void;
  state: 'idle' | 'sending' | 'sent' | 'failed';
  onResend: () => void;
}) {
  if (state === 'sent') {
    return (
      <div className="bg-[color:var(--bg-success)] border border-[color:var(--border-success)] rounded-lg p-3 text-sm text-[color:var(--text-muted)]">
        Demande enregistrée. Si un compte non vérifié correspond à cette adresse, un nouveau lien va lui
        être envoyé dans quelques instants. L&apos;ancien lien reste valable s&apos;il n&apos;a pas expiré.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Le champ disparaissait dès le premier caractère (`!email`) : il
          dépend de l'origine de l'adresse, pas de sa valeur courante. */}
      {askEmail && (
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
