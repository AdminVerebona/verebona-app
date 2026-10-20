"use client"

/**
 * Identité sans espace — lot 72D (ticket P0 « Premium Duo — compte partagé »,
 * décision PO Q8).
 *
 * Un invité Premium Duo crée son IDENTITÉ (aucun compte personnel) ; tant
 * qu'il n'a pas accepté l'invitation — ou si elle a expiré, a été annulée, ou
 * si le Duo a été résilié entre-temps — il n'a aucun espace. Plutôt qu'un
 * tableau de bord vide (dont chaque lecture serait refusée), cet écran
 * propose :
 *   · « Rejoindre l'espace Premium Duo » si une invitation valide l'attend ;
 *   · « Créer mon espace » : compte Standard, avec l'essai de 7 jours
 *     SEULEMENT si cette adresse ne l'a jamais utilisé ;
 *   · lot 73B : « Refuser l'invitation » (confirmation) — le titulaire est
 *     prévenu, le lien ne vaut plus rien ; aucun espace n'est créé.
 * Même composant sur ordinateur et sur mobile (WebView).
 */
import { useEffect, useState } from 'react';
import { Loader2, Users, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import { LogoWithBaseline } from '@/components/Logo';
import { declineDuo, duoJoinErrorMessage, joinDuo, peekPendingDuoJoin, settlePendingDuoJoin } from '@/lib/duo/pending-duo-join';

const cadre = 'min-h-screen flex items-center justify-center bg-[color:var(--bg-page)] p-4 md:p-6';
const carte = 'w-full max-w-md space-y-5 rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-6 shadow-relief-md';

interface Options { pendingDuoInvitation: boolean; trialAvailable: boolean }

export function NoSpaceScreen({ firstName, onLogout }: { firstName?: string | null; onLogout: () => void }) {
  const [options, setOptions] = useState<Options | null>(null);
  const [busy, setBusy] = useState<'join' | 'create' | 'decline' | null>(null);
  const [error, setError] = useState('');
  const [confirmDecline, setConfirmDecline] = useState(false);
  const [declined, setDeclined] = useState(false);

  useEffect(() => {
    let annule = false;
    fetch('/api/accounts', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { options?: Options | null } | null) => {
        if (!annule) setOptions(d?.options ?? { pendingDuoInvitation: false, trialAvailable: false });
      })
      .catch(() => { if (!annule) setOptions({ pendingDuoInvitation: false, trialAvailable: false }); });
    return () => { annule = true; };
  }, []);

  const rejoindre = async () => {
    setBusy('join');
    setError('');
    // Invitation mémorisée dans ce navigateur d'abord ; sinon celle adressée
    // à l'adresse (vérifiée) de la session.
    const token = peekPendingDuoJoin();
    const r = await joinDuo(token);
    settlePendingDuoJoin(token, r);
    if (r.ok) { window.location.assign('/accueil'); return; }
    setError(r.message || duoJoinErrorMessage(r.error));
    setBusy(null);
  };

  // Lot 73B : refus des invitations adressées à l'adresse (vérifiée) de la
  // session — celles qu'annonce cet écran ; le jeton mémorisé est oublié.
  const refuser = async () => {
    setConfirmDecline(false);
    setBusy('decline');
    setError('');
    const r = await declineDuo(null);
    if (r.ok) {
      setDeclined(true);
      setOptions((o) => (o ? { ...o, pendingDuoInvitation: false } : o));
    } else {
      setError('Le refus n’a pas pu être enregistré. Réessayez dans un instant.');
    }
    setBusy(null);
  };

  const creer = async () => {
    setBusy('create');
    setError('');
    try {
      const res = await fetch('/api/accounts/personal', { method: 'POST', credentials: 'include' });
      if (res.ok) { window.location.assign('/accueil'); return; }
      setError('Votre espace n’a pas pu être créé. Réessayez dans un instant.');
    } catch {
      setError('Connexion impossible. Réessayez.');
    }
    setBusy(null);
  };

  return (
    <div className={cadre}>
      <div className={carte} data-testid="no-space-screen">
        <div className="flex justify-center"><LogoWithBaseline size={44} /></div>
        <div className="space-y-2 text-center">
          <h1 className="text-xl font-extrabold tracking-[-.02em] text-[color:var(--text-primary)]">
            {firstName ? `${firstName}, vous n’avez pas encore d’espace` : 'Vous n’avez pas encore d’espace'}
          </h1>
          <p className="text-sm text-[color:var(--text-muted)]">
            Votre identité Verebona est active. Pour retrouver des biens et des documents, rejoignez
            l’espace auquel vous avez été invité ou créez le vôtre.
          </p>
        </div>

        {!options ? (
          <div className="flex justify-center py-2"><Loader2 className="h-6 w-6 animate-spin text-[color:var(--accent)]" /></div>
        ) : (
          <div className="space-y-3">
            {options.pendingDuoInvitation && (
              <Button className="w-full" onClick={() => void rejoindre()} disabled={!!busy}>
                {busy === 'join' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Users className="mr-2 h-4 w-4" />}
                Rejoindre l’espace Premium Duo
              </Button>
            )}
            {options.pendingDuoInvitation && (
              <Button
                className="w-full text-destructive hover:text-destructive"
                variant="ghost"
                onClick={() => setConfirmDecline(true)}
                disabled={!!busy}
                data-testid="no-space-decline"
              >
                {busy === 'decline' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <XCircle className="mr-2 h-4 w-4" />}
                Refuser l’invitation
              </Button>
            )}
            {declined && (
              <p role="status" className="text-center text-sm text-[color:var(--text-muted)]">
                Invitation refusée : la personne qui vous a invité en est informée.
              </p>
            )}
            <Button
              className="w-full"
              variant={options.pendingDuoInvitation ? 'outline' : 'default'}
              onClick={() => void creer()}
              disabled={!!busy}
            >
              {busy === 'create' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Créer mon espace
            </Button>
            <p className="text-center text-xs text-[color:var(--text-muted)]">
              {options.trialAvailable
                ? 'Votre espace démarre avec l’essai gratuit de 7 jours, sans carte bancaire.'
                : 'Votre espace démarre en offre Standard (l’essai gratuit a déjà été utilisé avec cette adresse).'}
            </p>
          </div>
        )}

        {error && <p role="alert" className="text-center text-sm text-destructive">{error}</p>}

        <AlertDialog open={confirmDecline} onOpenChange={setConfirmDecline}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Refuser l’invitation ?</AlertDialogTitle>
              <AlertDialogDescription>
                La personne qui vous a invité sera informée de votre refus et le lien ne sera plus valable.
                Une nouvelle invitation restera possible. Vous pourrez aussi créer votre propre espace.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Retour</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => { e.preventDefault(); void refuser(); }}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Refuser l’invitation
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <button
          type="button"
          onClick={onLogout}
          className="block w-full text-center text-sm text-[color:var(--text-muted)] underline-offset-4 hover:underline"
        >
          Se déconnecter
        </button>
      </div>
    </div>
  );
}
