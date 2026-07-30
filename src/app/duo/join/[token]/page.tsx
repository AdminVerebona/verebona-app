'use client';

import { Suspense, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Loader2, Users, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useSession } from '@/hooks/useSession';
import { ForceTheme } from '@/components/ForceTheme';
import { LogoWithBaseline } from '@/components/Logo';

type PageState =
  | 'loading'
  | 'valid'
  | 'invalid'
  | 'expired'
  | 'already_in_duo'
  | 'subscription_inactive'
  | 'joining'
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

  useEffect(() => {

    // Validate the token
    fetch(`/api/duo/join`, { credentials: 'include' })
      .then(async (res) => {
        const data = await res.json();
        if (res.ok && data.valid) {
          setTokenInfo({ ownerName: data.ownerName, inviteEmail: data.inviteEmail });
          setPageState('valid');
        } else if (data.error === 'EXPIRED_TOKEN') {
          setPageState('expired');
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
      // Not logged in — redirect to signup with invite token
      router.push(`/signup?inviteToken=${encodeURIComponent(token)}`);
      return;
    }

    setPageState('joining');
    try {
      const res = await fetch('/api/duo/join', {
      credentials: 'include',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token }),
      });

      const data = await res.json();

      if (res.ok) {
        setPageState('success');
        setTimeout(() => router.push('/accueil'), 2000);
      } else if (data.error === 'ALREADY_IN_DUO') {
        setPageState('already_in_duo');
      } else if (data.error === 'EXPIRED_TOKEN') {
        setPageState('expired');
      } else {
        setErrorMessage(data.message || 'Une erreur est survenue.');
        setPageState('error');
      }
    } catch {
      setErrorMessage('Une erreur est survenue. Veuillez réessayer.');
      setPageState('error');
    }
  };

  const renderContent = () => {
    if (pageState === 'loading') {
      return (
        <div className="text-center space-y-4">
          <Loader2 className="w-10 h-10 animate-spin text-blue-400 mx-auto" />
          <p className="text-sm text-[color:var(--text-muted)]">Vérification de l'invitation…</p>
        </div>
      );
    }

    if (pageState === 'joining') {
      return (
        <div className="text-center space-y-4">
          <Loader2 className="w-10 h-10 animate-spin text-blue-400 mx-auto" />
          <p className="text-sm text-[color:var(--text-muted)]">Rattachement en cours…</p>
        </div>
      );
    }

    if (pageState === 'success') {
      return (
        <div className="text-center space-y-4 animate-in fade-in duration-300">
          <CheckCircle2 className="w-14 h-14 text-green-400 mx-auto" />
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
        <div className="bg-emerald-950/40 border border-emerald-500/30 rounded-xl p-5 flex items-start gap-4">
          <Users className="w-8 h-8 text-emerald-400 flex-shrink-0 mt-0.5" />
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
          <div className="bg-blue-950/40 border border-blue-500/30 rounded-lg px-4 py-3 text-sm text-blue-200">
            Vous devez être connecté pour rejoindre cet espace. Créez un compte ou connectez-vous pour continuer.
          </div>
        )}

        <div className="flex flex-col gap-2">
          <Button onClick={handleJoin} className="w-full" size="lg">
            {user ? 'Rejoindre' : 'Créer un compte et rejoindre'}
          </Button>
          <Button
            variant="outline"
            onClick={() => router.push(user ? '/accueil' : '/')}
            className="w-full"
          >
            Annuler
          </Button>
        </div>

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
      <ForceTheme theme="blue" />
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
      <AlertCircle className="w-12 h-12 text-amber-400 mx-auto" />
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
        <Loader2 className="w-10 h-10 animate-spin text-blue-400" />
      </div>
    }>
      <DuoJoinContent />
    </Suspense>
  );
}
