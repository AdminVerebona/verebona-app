'use client';

/**
 * Fenêtre de demande de démarrage immédiat avant le paiement (lot 102B),
 * pour Mon compte › Offres. Le bouton « Continuer vers le paiement » reste
 * inactif tant que la case n'est pas cochée. Desktop et mobile (AlertDialog).
 */
import { useEffect, useState } from 'react';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { ImmediateStartConsent } from './ImmediateStartConsent';

export function ImmediateStartDialog({
  open,
  offerLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  offerLabel: string | null;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [checked, setChecked] = useState(false);
  useEffect(() => { if (open) setChecked(false); }, [open]);
  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Avant le paiement</AlertDialogTitle>
          <AlertDialogDescription>
            {offerLabel ? `Offre choisie : ${offerLabel}.` : 'Vous allez être redirigé vers Stripe.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ImmediateStartConsent checked={checked} onChange={setChecked} disabled={busy} id="immediate-start-dialog" />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Annuler</AlertDialogCancel>
          <Button onClick={onConfirm} disabled={!checked || busy}>
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Continuer vers le paiement
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
