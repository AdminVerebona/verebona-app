'use client';

import { Suspense, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Loader2, Users, AlertCircle, CheckCircle2, XCircle } from 'lucide-react';
import { useSession } from '@/hooks/useSession';
import { FollowTheme } from '@/components/FollowTheme';
import { LogoWithBaseline } from '@/components/Logo';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  declineDuo,
  duoJoinErrorMessage,
  joinDuo,
  peekPendingDuoJoin,
  rememberPendingDuoJoin,
  settlePendingDuoJoin,
} from '@/lib/duo/pending-duo-join';

type PageState =
  | 'loading'
  | 'valid'
  | 'invalid'
  | 'expired'
  | 'used'
  | 'declined_link'
  | 'already_in_duo'
  | 'subscription_inactive'
  | 'joining'
  | 'declining'
  | 'declined'
  | 'success'
  | 'error';

interface TokenInfo {
  ownerName: string;
  inviteEmail: string | null;
}

function DuoJoinContent() {
  const params = useParams();
  const router = useRouter();
  const token = params?.token as string;
  const { user, isLoading: sessionLoading } = useSession();

  const [pageState, setPageState] = useState<PageState>('loading');
  const [tokenInfo, setTokenInfo] = useState<TokenInfo | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [confirmDecline, setConfirmDecline] = useState(false);

  useEffect(() => {
    if (!token) return;
    // Le jeton DOIT accompagner la vérification : sans lui, la route
    // répondait 400 MISSING_TOKEN et tout invité voyait « Lien invalide ».
    fetch(`/api/duo/join?token=${encodeURIComponent(token)}`, { credentials: 'include' })
      .then(async (res) => {
        const data = await res.json();
        if (res.ok && data.valid) {
          setTokenInfo({ ownerName: data.ownerName, inviteEmail: data.inviteEmail });
          setPageState('valid');
        } else if (data.error === 'EXPIRED_TOKEN') {
          setPageState('expired');
        } else if (data.error === 'USED_TOKEN') {
          setPageState('used');
        } else if (data.error === 'DECLINED_TOKEN') {
          setPageState('declined_link');
        } else if (data.error === 'SUBSCRIPTION_INACTIVE') {
          setPageState('subscription_inactive');
        } else {
          setPageState('invalid');
        }
      })
      .catch(() => setPageState('invalid'));
  }, [token]);

  const handleJoin = async () => {
    if (!user) {
      // Pas encore connecté : l'invitation est mémorisée, puis consommée
      // automatiquement une fois connecté (voir `lib/duo/pending-duo-join`).
      rememberPendingDuoJoin(token);
      router.push(`/signup?inviteToken=${encodeURIComponent(token)}`);
      return;
    }

    setPageState('joining');
    // Lot 57A : jeton mémorisé retiré APRÈS confirmation ou refus définitif.
    const result = await joinDuo(token);
    settlePendingDuoJoin(token, result);
    if (result.ok) {
      setPageState('success');
      // Lot 72D : session rouverte sur l'espace du Duo par la réponse
      // (cookies) — rechargement complet : identité, offre et caches repartent
      // de ce compte (desktop et application mobile, même WebView).
      setTimeout(() => window.location.assign('/accueil'), 2000);
    } else if (result.error === 'ALREADY_IN_DUO') {
      setPageState('already_in_duo');
    } else if (result.error === 'EXPIRED_TOKEN') {
      setPageState('expired');
    } else if (result.error === 'DECLINED_TOKEN') {
      setPageState('declined_link');
    } else {
      setErrorMessage(result.message || duoJoinErrorMessage(result.error));
      setPageState('error');
    }
  };

  // Lot 73B : refus, connecté ou non (aucun compte n'est créé). Le titulaire
  // est prévenu par le serveur ; la réponse ne dit rien de plus.
  const handleDecline = async () => {
    setConfirmDecline(false);
    setPageState('declining');
    const r = await declineDuo(token);
    if (r.ok) {
      setPageState('declined');
    } else {
      setErrorMessage('Le refus n’a pas pu être enregistré. Vérifiez votre connexion et réessayez.');
      setPageState('error');
    }
  };

  const handleLogin = () => {
    rememberPendingDuoJoin(token);
    // Le jeton vient de l'URL : encodé dans le chemin pour que la cible reste
    // exactement cette page (la page de connexion n'accepte de toute façon
    // qu'un chemin interne, voir `safe-redirect.ts`).
    router.push(`/login?returnUrl=${encodeURIComponent(`/duo/join/${encodeURIComponent(token)}`)}`);
  };

  // Retour sur la page après connexion (`returnUrl`) avec l'invitation
  // mémorisée : le rattachement se fait sans second clic.
  useEffect(() => {
    if (pageState !== 'valid' || sessionLoading || !user) return;
    if (peekPendingDuoJoin() !== token) return;
    void handleJoin();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- déclenchement unique, à la validation
  }, [pageState, sessionLoading, user, token]);

  const renderContent = () => {
    if (pageState === 'loading') {
      return (
        <div className="text-center space-y-4">
          <Loader2 className="w-10 h-10 animate-spin text-[color:var(--accent)] mx-auto" />
          <p className="text-sm text-[color:var(--text-muted)]">Vérification de l'invitation…</p>
        </div>
      );
    }

    if (pageState === 'joining' || pageState === 'declining') {
      return (
        <div className="text-center space-y-4">
          <Loader2 className="w-10 h-10 animate-spin text-[color:var(--accent)] mx-auto" />
          <p className="text-sm text-[color:var(--text-muted)]">
            {pageState === 'joining' ? 'Rattachement en cours…' : 'Enregistrement de votre refus…'}
          </p>
        </div>
      );
    }

    if (pageState === 'declined') {
      return (
        <div className="text-center space-y-4 animate-in fade-in duration-300" data-testid="duo-join-declined">
          <XCircle className="w-14 h-14 text-[color:var(--text-muted)] mx-auto" />
          <div>
            <p className="text-lg font-semibold text-[color:var(--text-primary)]">Invitation refusée</p>
            <p className="text-sm text-[color:var(--text-muted)] mt-1 leading-relaxed">
              {tokenInfo?.ownerName
                ? `${tokenInfo.ownerName} en est informé(e). `
                : 'La personne qui vous a invité en est informée. '}
              {user
                ? 'Votre espace n’est pas modifié.'
                : 'Aucun compte n’a été créé.'}
              {' '}Ce lien n’est plus valable.
            </p>
          </div>
          <Button variant="outline" onClick={() => router.push(user ? '/accueil' : '/')} className="mt-2">
            {user ? 'Retour à l\'accueil' : 'Fermer'}
          </Button>
        </div>
      );
    }

    if (pageState === 'success') {
      return (
        <div className="text-center space-y-4 animate-in fade-in duration-300">
          <CheckCircle2 className="w-14 h-14 text-[color:var(--text-success)] mx-auto" />
          <div>
            <p className="text-lg font-semibold text-[color:var(--text-primary)]">
              Vous avez rejoint l'espace Premium Duo !
            </p>
            <p className="text-sm text-[color:var(--text-muted)] mt-1">
              Redirection vers l'accueil…
            </p>
          </div>
        </div>
      );
    }

    if (pageState === 'invalid') {
      return (
        <ErrorBlock
          title="Lien invalide"
          message="Ce lien d'invitation est invalide ou a déjà été utilisé."
          showBack
          onBack={() => router.push('/accueil')}
        />
      );
    }

    if (pageState === 'expired') {
      return (
        <ErrorBlock
          title="Lien expiré"
          message="Ce lien d'invitation a expiré. Demandez au titulaire de l'abonnement d'en générer un nouveau."
          showBack
          onBack={() => router.push('/accueil')}
        />
      );
    }

    if (pageState === 'used') {
      return (
        <ErrorBlock
          title="Invitation déjà utilisée"
          message="Cette invitation Premium Duo a déjà été acceptée. Si vous l'avez acceptée vous-même, connectez-vous pour accéder à l'espace partagé ; sinon, demandez au titulaire une nouvelle invitation."
          showBack
          onBack={() => router.push(user ? '/accueil' : '/login')}
          backLabel={user ? 'Retour à l\'accueil' : 'Se connecter'}
        />
      );
    }

    if (pageState === 'declined_link') {
      return (
        <ErrorBlock
          title="Invitation refusée"
          message="Cette invitation Premium Duo a été refusée et n'est plus valable. Pour rejoindre cet espace, demandez au titulaire une nouvelle invitation."
          showBack
          onBack={() => router.push(user ? '/accueil' : '/')}
          backLabel={user ? 'Retour à l\'accueil' : 'Fermer'}
        />
      );
    }

    if (pageState === 'subscription_inactive') {
      return (
        <ErrorBlock
          title="Abonnement inactif"
          message="L'abonnement Premium Duo associé à cette invitation n'est plus actif."
          showBack
          onBack={() => router.push('/accueil')}
        />
      );
    }

    if (pageState === 'already_in_duo') {
      return (
        <ErrorBlock
          title="Déjà rattaché"
          message="Vous êtes déjà rattaché à une autre offre Premium Duo."
          showBack
          onBack={() => router.push('/accueil')}
        />
      );
    }

    if (pageState === 'error') {
      return (
        <ErrorBlock
          title="Une erreur est survenue"
          message={errorMessage}
          showBack
          onBack={() => setPageState('valid')}
          backLabel="Réessayer"
        />
      );
    }

    // pageState === 'valid'
    return (
      <div className="space-y-6">
        <div className="bg-[color:var(--bg-success)] border border-[color:var(--border-success)] rounded-xl p-5 flex items-start gap-4">
          <Users className="w-8 h-8 text-[color:var(--text-success)] flex-shrink-0 mt-0.5" />
          <div className="space-y-2">
            <p className="text-base font-semibold text-[color:var(--text-primary)]">
              {tokenInfo?.ownerName
                ? `${tokenInfo.ownerName} vous invite à rejoindre son offre Premium Duo.`
                : 'Vous avez été invité à rejoindre une offre Premium Duo.'}
            </p>
            <p className="text-sm text-[color:var(--text-muted)] leading-relaxed">
              Premium Duo vous permet de gérer à deux un même espace Verebona pour vos biens, documents et éléments d'agenda. Le titulaire conserve la gestion de l'abonnement et du paiement.
            </p>
          </div>
        </div>

        {!sessionLoading && !user && (
          <div className="bg-[color:var(--accent-soft)] border border-[color:var(--border-info)] rounded-lg px-4 py-3 text-sm text-[color:var(--text-info-soft)]">
            Vous devez être connecté pour rejoindre cet espace. Créez un compte ou connectez-vous pour continuer.
          </div>
        )}

        <div className="flex flex-col gap-2">
          <Button onClick={handleJoin} className="w-full" size="lg">
            {user ? 'Rejoindre' : 'Créer un compte et rejoindre'}
          </Button>
          {!sessionLoading && !user && (
            <Button variant="outline" onClick={handleLogin} className="w-full">
              J&apos;ai déjà un compte : me connecter et rejoindre
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => router.push(user ? '/accueil' : '/')}
            className="w-full"
          >
            Annuler
          </Button>
          {/* Lot 73B : refus explicite, connecté ou non (aucun compte créé). */}
          <Button
            variant="ghost"
            onClick={() => setConfirmDecline(true)}
            className="w-full text-destructive hover:text-destructive"
            data-testid="duo-join-decline"
          >
            <XCircle className="w-4 h-4 mr-2" />
            Refuser l’invitation
          </Button>
        </div>

        <AlertDialog open={confirmDecline} onOpenChange={setConfirmDecline}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Refuser l’invitation ?</AlertDialogTitle>
              <AlertDialogDescription>
                {tokenInfo?.ownerName ? `${tokenInfo.ownerName} sera informé(e) de votre refus.` : 'La personne qui vous a invité sera informée de votre refus.'}
                {' '}Ce lien ne sera plus valable ; {user ? 'votre espace n’est pas modifié.' : 'aucun compte ne sera créé.'}
                {' '}Une nouvelle invitation restera possible.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Retour</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => { e.preventDefault(); void handleDecline(); }}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Refuser l’invitation
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {!sessionLoading && user && (
          <p className="text-xs text-center text-[color:var(--text-muted)]">
            Connecté en tant que <span className="font-medium">{user.email}</span>
          </p>
        )}
      </div>
    );
  };

  return (
    <div className="public-page min-h-screen flex flex-col items-center justify-center bg-[color:var(--bg-page)] p-4">
      <FollowTheme />
      <div className="w-full max-w-md space-y-6">
        <div className="flex justify-center">
          <LogoWithBaseline size={44} />
        </div>
        <div className="bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] rounded-2xl p-6 shadow-xl">
          {renderContent()}
        </div>
      </div>
    </div>
  );
}

function ErrorBlock({
  title,
  message,
  showBack,
  onBack,
  backLabel = 'Retour à l\'accueil',
}: {
  title: string;
  message: string;
  showBack?: boolean;
  onBack?: () => void;
  backLabel?: string;
}) {
  return (
    <div className="text-center space-y-4">
      <AlertCircle className="w-12 h-12 text-[color:var(--attention-on-soft)] mx-auto" />
      <div>
        <p className="text-lg font-semibold text-[color:var(--text-primary)]">{title}</p>
        <p className="text-sm text-[color:var(--text-muted)] mt-1 leading-relaxed">{message}</p>
      </div>
      {showBack && onBack && (
        <Button variant="outline" onClick={onBack} className="mt-2">
          {backLabel}
        </Button>
      )}
    </div>
  );
}

export default function DuoJoinPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-10 h-10 animate-spin text-[color:var(--accent)]" />
      </div>
    }>
      <DuoJoinContent />
    </Suspense>
  );
}
