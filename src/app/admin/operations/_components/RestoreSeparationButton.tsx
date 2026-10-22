"use client";

/**
 * « Rétablir » une séparation automatique d'identité économique (lot 79A ;
 * séparation lot 78A, motif `T3_IDENTITY_SEPARATED`).
 *
 * SEULE action du détail d'Opération du BO (exception PO du 22/10/2026 à la
 * lecture seule Q9) : confirmation résumant ce qui sera rétabli (document,
 * Opération d'origine, montants, effet sur le TCO) + motif obligatoire, puis
 * `POST /api/admin/operations/:id/identity-reviews/:reviewId/restore`
 * (journalisé côté serveur). Aucune valeur saisie : le moteur T3 réapplique
 * une décision de rapprochement prioritaire.
 *
 * Desktop ET mobile : même composant ; bouton pleine largeur sur mobile
 * (`w-full sm:w-auto`), fenêtre de confirmation responsive (AlertDialog du
 * design system), zone de motif pleine largeur. Double clic : bouton désactivé
 * pendant l'envoi ; le serveur garantit de toute façon un seul rétablissement.
 */
import { useState } from 'react';
import { Loader2, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { apiClient } from '@/lib/api-client';
import { formatMoney } from '@/lib/admin/format';
import {
  RESTORE_LABELS as L, RESTORE_REASON_MAX, RESTORE_REASON_MIN, normalizeRestoreReason, restoreHref, restoreTcoEffect, type RestoreSummary,
} from '@/services/business-operations/identity-restore.model';

interface Props {
  /** Opération affichée (contrôle d'appartenance côté serveur). */
  operationId: number;
  restore: RestoreSummary;
  /** Appelé après un rétablissement (ou un refus « déjà rétabli ») : rafraîchir l'écran. */
  onDone?: () => void;
}

export function RestoreSeparationButton({ operationId, restore: r, onDone }: Props) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = normalizeRestoreReason(reason) !== null;
  const fieldId = `identity-restore-reason-${r.reviewId}`;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      await apiClient.post(restoreHref(operationId, r.reviewId), { reason: reason.trim() });
      toast.success(L.done);
      setOpen(false);
      setReason('');
      onDone?.();
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'Rétablissement impossible.');
      // Refus (déjà rétablie, source supprimée…) : l'écran est relu pour refléter l'état réel.
      setOpen(false);
      onDone?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button type="button" variant="outline" size="sm" className="w-full sm:w-auto" onClick={() => setOpen(true)}
        data-testid="identity-restore" data-review-id={r.reviewId}>
        <Undo2 className="h-4 w-4 mr-1.5" />
        {L.button}
      </Button>
      <AlertDialog open={open} onOpenChange={(o) => { if (!busy) setOpen(o); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{L.title}</AlertDialogTitle>
            <AlertDialogDescription>{L.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <dl className="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Document</dt>
            <dd className="break-words">document #{r.fileId} ({r.candidateKey}){r.summary ? ` — ${r.summary}` : ''}</dd>
            <dt className="text-muted-foreground">Opération d’origine</dt>
            <dd>#{r.originOperationId}</dd>
            <dt className="text-muted-foreground">Rattaché aujourd’hui à</dt>
            <dd>{r.currentOperationId !== null ? `#${r.currentOperationId}` : 'aucune Opération (en attente)'}</dd>
            <dt className="text-muted-foreground">Montants concernés</dt>
            <dd>{r.amounts.length ? r.amounts.map((a) => `${formatMoney(a.amountMinor, a.currency)} (${a.role})`).join(', ') : 'aucun'}</dd>
          </dl>
          <p className="text-sm rounded-xl border bg-muted/30 p-3">{restoreTcoEffect(r)}</p>
          <div className="space-y-1.5">
            <Label htmlFor={fieldId}>{L.reason}</Label>
            <Textarea
              id={fieldId}
              className="w-full"
              value={reason}
              minLength={RESTORE_REASON_MIN}
              maxLength={RESTORE_REASON_MAX}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ex. : vérifié avec le client, l’acte et la commande décrivent bien le même achat."
              disabled={busy}
            />
            <p className="text-xs text-muted-foreground">{reason.trim().length} / {RESTORE_REASON_MIN} caractères minimum</p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Annuler</AlertDialogCancel>
            <AlertDialogAction disabled={busy || !valid} onClick={(e) => { e.preventDefault(); void submit(); }}>
              {busy && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              {L.confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
