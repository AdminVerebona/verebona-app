"use client";

/**
 * « Reconsolider ce compte » (lot 48, O10 — point ouvert du lot 47 ; CDC
 * Opérations V1 C26.2 « correction du code puis reconsolidation »).
 *
 * Action de COMPTE, jamais une édition d'Opération (décision PO Q9,
 * INV-032) : confirmation + motif obligatoire, puis
 * `POST /api/admin/accounts/:id/operations-reconsolidation` (journalisé
 * côté serveur). Le travail T3 Opérations du compte (dédoublonné) et sa
 * projection Agenda sont mis en file ; rien n'est saisi ici.
 *
 * Desktop ET mobile : même composant ; bouton pleine largeur sur mobile
 * (`w-full sm:w-auto`), fenêtre de confirmation responsive (AlertDialog du
 * design system), zone de motif pleine largeur.
 */
import { useState } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { apiClient } from '@/lib/api-client';
import {
  RECONSOLIDATION_LABELS as L, RECONSOLIDATION_REASON_MAX, normalizeReconsolidationReason, reconsolidationHref,
} from '@/services/business-operations/admin-reconsolidation.model';

interface Props {
  accountId: number;
  /** Appelé après une mise en file réussie (rafraîchir l'écran). */
  onQueued?: () => void;
  size?: 'sm' | 'default';
  variant?: 'outline' | 'secondary' | 'ghost' | 'default';
}

export function ReconsolidateAccountButton({ accountId, onQueued, size = 'sm', variant = 'outline' }: Props) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = normalizeReconsolidationReason(reason) !== null;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      const r = await apiClient.post<{ waitsForReactivation?: boolean }>(reconsolidationHref(accountId), { reason: reason.trim() });
      toast.success(r?.waitsForReactivation ? L.waiting : L.queued);
      setOpen(false);
      setReason('');
      onQueued?.();
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'Mise en file impossible.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button type="button" variant={variant} size={size} className="w-full sm:w-auto" onClick={() => setOpen(true)} data-testid="reconsolidate-account">
        <RotateCcw className="h-4 w-4 mr-1.5" />
        {L.button}
      </Button>
      <AlertDialog open={open} onOpenChange={(o) => { if (!busy) setOpen(o); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{L.title}</AlertDialogTitle>
            <AlertDialogDescription>{L.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor={`reconsolidation-reason-${accountId}`}>{L.reason}</Label>
            <Textarea
              id={`reconsolidation-reason-${accountId}`}
              className="w-full"
              value={reason}
              maxLength={RECONSOLIDATION_REASON_MAX}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ex. : correction du code livrée (anomalie dure), reconsolidation demandée."
              disabled={busy}
            />
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
