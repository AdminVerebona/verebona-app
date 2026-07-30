"use client"

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, XCircle, Loader2, Building2 } from 'lucide-react';
import { Logo } from '@/components/Logo';

interface TransmissionData {
  status: string;
  message?: string;
  recipientHasAccount?: boolean;
  recipientEmail?: string;
  asset: {
    id: number;
    name: string;
    category: string;
    subtype: string | null;
  } | null;
}

interface ConflictData {
  conflict: true;
  existingAssetId: number;
  message: string;
}

type PageState = 'loading' | 'ready' | 'accepting' | 'refusing' | 'accepted' | 'refused' | 'conflict' | 'error' | 'already_done' | 'cancelled';

export default function TransmissionPage() {
  const params = useParams();
  const router = useRouter();
  const token = params.token as string;

  const [transmission, setTransmission] = useState<TransmissionData | null>(null);
  const [pageState, setPageState] = useState<PageState>('loading');
  const [conflictData, setConflictData] = useState<ConflictData | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [recipientHasAccount, setRecipientHasAccount] = useState<boolean | null>(null);

  useEffect(() => {
    fetch(`/api/transmission/${token}`, { credentials: 'include' })
      .then(r => r.json())
      .then((data: TransmissionData) => {
        setTransmission(data);
        if (data.recipientHasAccount !== undefined) {
          setRecipientHasAccount(data.recipientHasAccount);
        }
        if (data.status === 'cancelled') {
          setPageState('cancelled');
        } else if (data.status === 'accepted' || data.status === 'refused') {
          setPageState('already_done');
        } else {
          setPageState('ready');
        }
      })
      .catch(() => {
        setPageState('error');
        setErrorMessage('Impossible de charger les données de cette invitation.');
      });
  }, [token]);

  const isAlreadyLoggedIn = () => {
    if (typeof window === 'undefined') return false;
    return true;
  };

  const handleAction = async (action: 'accept' | 'refuse', confirmDuplicate = false) => {
    setPageState(action === 'accept' ? 'accepting' : 'refusing');

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };

      const res = await fetch(`/api/transmission/${token}`, {
      credentials: 'include',
        method: 'POST',
        headers,
        body: JSON.stringify({ action, confirmDuplicate }),
      });
      const data = await res.json();

      if (data.requiresSignup) {
        // No account yet — save token, redirect to signup with email prefilled
        localStorage.setItem('pending_transfer_token', token);
        router.push(`/signup?email=${encodeURIComponent(data.recipientEmail ?? '')}`);
        return;
      } else if (data.conflict) {
        setConflictData(data);
        setPageState('conflict');
      } else if (data.error) {
        setPageState('error');
        setErrorMessage(data.message ?? data.error);
      } else {
        if (action === 'accept') {
          // If user is already logged in, redirect directly to dashboard
          if (isAlreadyLoggedIn()) {
            router.push('/accueil');
            return;
          }
          if (data.recipientHasAccount !== undefined) {
            setRecipientHasAccount(data.recipientHasAccount);
          }
        }
        setPageState(action === 'accept' ? 'accepted' : 'refused');
      }
    } catch {
      setPageState('error');
      setErrorMessage('Une erreur est survenue. Veuillez réessayer.');
    }
  };

  const asset = transmission?.asset;

  return (
    <div className="public-page min-h-screen flex items-center justify-center p-4" style={{ backgroundColor: '#020B1A' }}>
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="flex justify-center mb-8">
          <Logo size={36} withText={true} withBaseline={false} />
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Invitation de transmission</CardTitle>
          </CardHeader>
          <CardContent>
            {/* Loading */}
            {pageState === 'loading' && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            )}

            {/* Cancelled */}
            {pageState === 'cancelled' && (
              <div className="text-center py-6">
                <XCircle className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">
                  {transmission?.message ?? 'Cette invitation a été annulée.'}
                </p>
              </div>
            )}

            {/* Already done */}
            {pageState === 'already_done' && (
              <div className="text-center py-6">
                <CheckCircle2 className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">
                  {transmission?.message ?? 'Cette invitation a déjà été traitée.'}
                </p>
              </div>
            )}

            {/* Ready — affiche l'identité minimale du bien */}
            {pageState === 'ready' && asset && (
              <div className="space-y-5">
                <div className="rounded-lg border p-4 bg-muted/30">
                  <div className="flex items-start gap-3">
                    <Building2 className="w-5 h-5 text-muted-foreground mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="font-semibold text-base">{asset.name}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge variant="outline" className="text-xs">{asset.category}</Badge>
                        {asset.subtype && (
                          <span className="text-xs text-muted-foreground">{asset.subtype}</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                <p className="text-sm text-muted-foreground">
                  Vous avez reçu une invitation pour recevoir ce bien dans votre portefeuille.
                  Si vous acceptez, le bien sera ajouté à votre compte.
                </p>

                <div className="flex gap-3">
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => handleAction('refuse')}
                  >
                    Refuser
                  </Button>
                  <Button
                    className="flex-1"
                    onClick={() => handleAction('accept')}
                  >
                    Accepter
                  </Button>
                </div>
              </div>
            )}

            {/* Accepting */}
            {pageState === 'accepting' && (
              <div className="flex flex-col items-center justify-center py-8 gap-3">
                <Loader2 className="w-6 h-6 animate-spin" />
                <p className="text-sm text-muted-foreground">Transfert en cours…</p>
              </div>
            )}

            {/* Refusing */}
            {pageState === 'refusing' && (
              <div className="flex flex-col items-center justify-center py-8 gap-3">
                <Loader2 className="w-6 h-6 animate-spin" />
                <p className="text-sm text-muted-foreground">Traitement en cours…</p>
              </div>
            )}

            {/* Accepted */}
            {pageState === 'accepted' && (
              <div className="text-center py-6 space-y-3">
                <CheckCircle2 className="w-10 h-10 text-green-500 mx-auto" />
                <p className="font-semibold">Bien reçu !</p>
                {recipientHasAccount ? (
                  <>
                    <p className="text-sm text-muted-foreground">
                      Le bien a été ajouté à votre portefeuille. Connectez-vous pour y accéder.
                    </p>
                    <Button asChild className="mt-2">
                      <a href={`/login${transmission?.recipientEmail ? `?email=${encodeURIComponent(transmission.recipientEmail)}` : ''}`}>
                        Me connecter
                      </a>
                    </Button>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-muted-foreground">
                      Le bien vous attend. Créez votre compte Verebona pour y accéder.
                    </p>
                    <Button asChild className="mt-2">
                      <a href={`/signup${transmission?.recipientEmail ? `?email=${encodeURIComponent(transmission.recipientEmail)}` : ''}`}>
                        Créer mon compte
                      </a>
                    </Button>
                  </>
                )}
              </div>
            )}

            {/* Refused */}
            {pageState === 'refused' && (
              <div className="text-center py-6 space-y-3">
                <XCircle className="w-8 h-8 text-muted-foreground mx-auto" />
                <p className="text-sm text-muted-foreground">
                  Vous avez refusé la transmission. Aucune donnée n&apos;a été ajoutée à votre compte.
                </p>
              </div>
            )}

            {/* Conflict */}
            {pageState === 'conflict' && conflictData && (
              <div className="space-y-4">
                <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/20 p-4">
                  <p className="text-sm font-medium text-amber-800 dark:text-amber-400 mb-1">
                    Doublon détecté
                  </p>
                  <p className="text-xs text-amber-700 dark:text-amber-500">
                    {conflictData.message}
                  </p>
                </div>
                <div className="flex gap-3">
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => { setPageState('ready'); setConflictData(null); }}
                  >
                    Annuler
                  </Button>
                  <Button
                    className="flex-1"
                    onClick={() => handleAction('accept', true)}
                  >
                    Recevoir quand même
                  </Button>
                </div>
              </div>
            )}

            {/* Error */}
            {pageState === 'error' && (
              <div className="text-center py-6">
                <XCircle className="w-10 h-10 text-red-500 mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">
                  {errorMessage ?? 'Une erreur est survenue.'}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        <p className="text-center text-xs mt-6" style={{ color: '#6B7280' }}>
          Verebona — One place. Higher value.
        </p>
      </div>
    </div>
  );
}
