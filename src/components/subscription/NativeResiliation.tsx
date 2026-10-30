'use client';

/**
 * Résiliation dans l'application iOS / Android — lot 100D (décision PO A9 :
 * « résiliation / gestion de compte » conservées dans l'app ; aucun achat,
 * aucun tarif, aucun portail de paiement).
 *
 * Bouton « Résilier mon abonnement » → confirmation → `POST
 * /api/billing/stop-renewal` (fin de période, sans remboursement : ce n'est
 * pas une rétractation). Résiliation déjà programmée : rappel de la date de
 * fin. Rendu seulement dans l'app, pour le titulaire d'un abonnement payant
 * en cours (le Web garde le portail Verebona, lot 70B). Desktop et mobile
 * (boutons pleine largeur sous 640 px), charte Sérénité.
 */
import { useState } from 'react';
import { Loader2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { apiClient, ApiClientError } from '@/lib/api-client';

function dateLongue(iso: string | null | undefined): string | null {
  if (!iso || Number.isNaN(Date.parse(iso))) return null;
  return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'long' }).format(new Date(iso));
}

export function NativeResiliation({ cancelAtPeriodEnd, periodEndAt, onDone }: {
  cancelAtPeriodEnd: boolean;
  periodEndAt: string | null;
  onDone?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scheduledEnd, setScheduledEnd] = useState<string | null | undefined>(undefined);
  const fin = dateLongue(scheduledEnd ?? periodEndAt);

  if (cancelAtPeriodEnd || scheduledEnd !== undefined) {
    return (
      <p className="text-sm text-[color:var(--text-muted)]" data-testid="native-resiliation-scheduled">
        Résiliation programmée : votre abonnement reste actif {fin ? `jusqu’au ${fin}` : 'jusqu’à la fin de la période en cours'}, puis ne sera pas renouvelé.
      </p>
    );
  }

  const confirmer = async () => {
    setBusy(true);
    try {
      const r = await apiClient.post<{ endsAt: string | null }>('/api/billing/stop-renewal', {});
      setScheduledEnd(r?.endsAt ?? null);
      setOpen(false);
      toast.success('Résiliation enregistrée.');
      onDone?.();
    } catch (e) {
      toast.error(e instanceof ApiClientError && e.serverMessage ? e.serverMessage : 'La résiliation n’a pas pu être enregistrée. Réessayez dans quelques minutes.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={() => setOpen(true)} data-testid="native-resiliation">
        <XCircle className="mr-1.5 h-4 w-4" />
        Résilier mon abonnement
      </Button>
      <AlertDialog open={open} onOpenChange={(o) => { if (!busy) setOpen(o); }}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Résilier votre abonnement ?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-[color:var(--text-muted)]">
                <p>
                  Votre abonnement ne sera pas renouvelé. Vous gardez votre offre {fin ? `jusqu’au ${fin}` : 'jusqu’à la fin de la période en cours'} ;
                  vos biens et documents restent conservés.
                </p>
                <p>
                  Ce n’est pas une rétractation : la période en cours n’est pas remboursée.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel disabled={busy}>Garder mon abonnement</AlertDialogCancel>
            <Button onClick={confirmer} disabled={busy} className="w-full sm:w-auto">
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Confirmer la résiliation
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
