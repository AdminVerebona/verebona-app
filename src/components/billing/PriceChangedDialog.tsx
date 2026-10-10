'use client';

/**
 * Nouvelle confirmation d'un tarif (CDC lookup_key V4, LK-34, TC-35, TC-36).
 *
 * Affichée quand le serveur répond 409 PRICE_CHANGED (le prix a changé
 * entre l'affichage et le clic) ou PRICE_CONFIRMATION_REQUIRED. Le nouveau
 * montant est montré ; AUCUN second envoi automatique : seul le clic de
 * l'utilisateur relance l'opération, avec la nouvelle révision.
 * Composant unique pour desktop et mobile (dialogue plein écran sur mobile
 * par le composant `AlertDialog` existant).
 */
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { PLAN_LABELS, type PlanCode } from '@/lib/billing/plan-catalog';
import { billingMention, offerAmount, periodSuffix, type PriceConfirmationPayload } from '@/lib/billing/catalog-client';

export function PriceChangedDialog({
  pending,
  busy,
  onConfirm,
  onCancel,
}: {
  pending: PriceConfirmationPayload | null;
  busy?: boolean;
  onConfirm: (revision: string) => void;
  onCancel: () => void;
}) {
  const offer = pending?.offer;
  return (
    <AlertDialog open={Boolean(pending)} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {pending?.code === 'PRICE_CHANGED' ? 'Le tarif a changé' : 'Confirmez le tarif'}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {pending?.code === 'PRICE_CHANGED'
              ? "Le tarif a changé depuis l'affichage de cette page. Vérifiez le nouveau montant avant de continuer."
              : 'Vérifiez le montant avant de continuer.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {offer && (
          <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-page)] px-4 py-3" data-testid="price-confirmation-amount">
            <p className="text-sm text-[color:var(--text-muted)]">{PLAN_LABELS[offer.plan_code as PlanCode] ?? offer.plan_code}</p>
            <p className="text-xl font-bold text-[color:var(--text-primary)]">
              {offerAmount(offer)} <span className="text-sm font-normal text-[color:var(--text-muted)]">{periodSuffix(offer.billing_period)}</span>
            </p>
            {billingMention(offer) && <p className="text-xs text-[color:var(--text-muted)]">{billingMention(offer)}</p>}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Annuler</AlertDialogCancel>
          <Button disabled={busy || !offer} onClick={() => offer && onConfirm(offer.price_revision)}>
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Confirmer ce tarif
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
