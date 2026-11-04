'use client';

/**
 * Résiliation dans l'application iOS / Android — lot 100D (décision PO A9 :
 * « résiliation / gestion de compte » conservées dans l'app ; aucun achat,
 * aucun tarif, aucun portail de paiement).
 *
 * Bouton « Résilier mon abonnement » → confirmation → `POST
 * /api/billing/stop-renewal` (non-renouvellement à la fin de la période en
 * cours ; droits conservés jusqu'à cette date). Résiliation déjà programmée :
 * rappel de la date de fin. Lot 108F : texte de la confirmation imposé par le
 * PO (`lib/billing/resiliation-confirmation.ts`) — offre et date réelles. Rendu seulement dans l'app, pour le titulaire d'un abonnement payant
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
import {
  RESILIATION_CONFIRMATION, resiliationConfirmationLines, resiliationEndDate,
} from '@/lib/billing/resiliation-confirmation';

/** Corps de la confirmation (lot 108F) : deux phrases, offre et date réelles. */
export function ResiliationConfirmBody({ planCode, plan, periodEndAt }: {
  planCode: string | null | undefined;
  plan?: string | null;
  periodEndAt: string | null | undefined;
}) {
  const [l1, l2] = resiliationConfirmationLines({ planCode, plan, periodEndAt });
  return (
    <div className="space-y-2 break-words text-sm text-[color:var(--text-muted)]" data-testid="native-resiliation-body">
      <p>{l1}</p>
      <p>{l2}</p>
    </div>
  );
}

export function NativeResiliation({ cancelAtPeriodEnd, periodEndAt, planCode, plan, onDone }: {
  cancelAtPeriodEnd: boolean;
  periodEndAt: string | null;
  /** Offre de l'abonnement résilié (`subscription.planCode`). */
  planCode?: string | null;
  /** Offre des droits, repli si `planCode` est absent. */
  plan?: string | null;
  onDone?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scheduledEnd, setScheduledEnd] = useState<string | null | undefined>(undefined);
  const fin = resiliationEndDate(scheduledEnd ?? periodEndAt);

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
        {/* 320 px : marge de 1 rem de chaque côté (avant 108F, `max-w-md`
            écrasait le `max-w-[calc(100%-2rem)]` du composant), boutons
            pleine largeur empilés, libellés autorisés à passer à la ligne,
            défilement interne si la hauteur manque (texte agrandi, paysage). */}
        <AlertDialogContent className="max-w-[calc(100%-2rem)] sm:max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto" data-testid="native-resiliation-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{RESILIATION_CONFIRMATION.title}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <ResiliationConfirmBody planCode={planCode} plan={plan} periodEndAt={periodEndAt} />
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel disabled={busy} className="h-auto min-h-9 w-full whitespace-normal sm:w-auto">{RESILIATION_CONFIRMATION.cancel}</AlertDialogCancel>
            <Button onClick={confirmer} disabled={busy} className="h-auto min-h-9 w-full whitespace-normal sm:w-auto">
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {RESILIATION_CONFIRMATION.confirm}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
