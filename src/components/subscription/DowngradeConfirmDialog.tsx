'use client';

import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useEntitlements } from '@/hooks/useEntitlements';
import { apiClient } from '@/lib/api-client';
import { toast } from 'sonner';

interface DowngradeConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentOffer: string;
  targetOffer: string;
  renewalDate: string | null;
  onConfirmed: () => void;
}

const OFFER_LABELS: Record<string, string> = {
  STANDARD: 'Standard',
  PREMIUM: 'Premium',
  PREMIUM_DUO: 'Premium Duo',
  PREMIUM_PRO: 'Premium Pro',
};

/**
 * Quota de biens par offre (CDC §2), miroir de `PLAN_QUOTAS` côté serveur.
 *
 * Dupliqué ici en connaissance de cause : ces valeurs ne servent qu'à
 * AVERTIR avant le changement. Le contrôle qui fait foi reste
 * `entitlements.service`, et il s'appliquera de toute façon à l'échéance.
 */
const QUOTA_BIENS: Record<string, number> = {
  STANDARD: 2,
  PREMIUM: 10,
  PREMIUM_DUO: 15,
};

export function DowngradeConfirmDialog({
  open,
  onOpenChange,
  currentOffer,
  targetOffer,
  renewalDate,
  onConfirmed,
}: DowngradeConfirmDialogProps) {
  const [isLoading, setIsLoading] = useState(false);
  const { entitlements } = useEntitlements();

  // ══════════════════════════════════════════════════════════════════════════
  // UN DOWNGRADE PEUT METTRE LE COMPTE AU-DESSUS DE SA NOUVELLE LIMITE
  //
  // La fenêtre annonçait la date d'effet et rien d'autre. Un compte à cinq
  // biens pouvait descendre vers une offre qui en autorise deux sans en être
  // averti, et découvrir à l'échéance que ses biens ne sont plus modifiables.
  //
  // Le changement n'est pas empêché — c'est le choix de l'utilisateur, et il
  // ne perd aucune donnée. Mais il doit savoir ce qui l'attend AVANT de
  // confirmer, pas après.
  // ══════════════════════════════════════════════════════════════════════════
  const biensActuels = entitlements?.quotas?.assets?.used ?? null;
  const quotaCible = QUOTA_BIENS[targetOffer?.toUpperCase()] ?? null;
  const depassementPrevu =
    biensActuels !== null && quotaCible !== null && biensActuels > quotaCible;

  const handleConfirm = async () => {
    setIsLoading(true);
    try {
      await apiClient.post('/api/billing/cancel-subscription', {
        target_offer: targetOffer.toLowerCase(),
      });
      toast.success("Le changement d'offre a bien été enregistré.");
      onOpenChange(false);
      onConfirmed();
    } catch (err: any) {
      toast.error(err?.message || 'Une erreur est survenue. Veuillez réessayer.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Confirmer ce changement d'offre</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm text-[color:var(--text-muted)]">
              <p>
                Votre offre actuelle reste active jusqu'à la fin de votre période en cours.
                Le changement prendra effet à la prochaine échéance.
              </p>
              <ul className="space-y-1 border border-border rounded-md p-3 text-[color:var(--text-primary)]">
                <li className="flex justify-between">
                  <span className="text-[color:var(--text-muted)]">Offre actuelle</span>
                  <span className="font-medium">{OFFER_LABELS[currentOffer] ?? currentOffer}</span>
                </li>
                <li className="flex justify-between">
                  <span className="text-[color:var(--text-muted)]">Offre après changement</span>
                  <span className="font-medium">{OFFER_LABELS[targetOffer] ?? targetOffer}</span>
                </li>
                {renewalDate && (
                  <li className="flex justify-between">
                    <span className="text-[color:var(--text-muted)]">Date d'effet</span>
                    <span className="font-medium">{renewalDate}</span>
                  </li>
                )}
              </ul>

              {depassementPrevu && (
                <div className="flex items-start gap-2.5 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                  <p className="text-[color:var(--text-primary)]">
                    À la prochaine échéance, votre compte contiendra{' '}
                    <span className="font-medium">{biensActuels} biens</span> pour une limite de{' '}
                    <span className="font-medium">{quotaCible}</span>. Vos biens resteront
                    consultables et exportables, mais vous ne pourrez plus les modifier ni en
                    ajouter tant que vous serez au-dessus de cette limite.
                  </p>
                </div>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
          <AlertDialogCancel disabled={isLoading}>Annuler</AlertDialogCancel>
          <Button onClick={handleConfirm} disabled={isLoading} className="w-full sm:w-auto">
            {isLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
            Confirmer le changement
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
