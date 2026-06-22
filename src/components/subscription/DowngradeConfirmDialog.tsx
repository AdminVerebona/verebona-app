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
import { Loader2 } from 'lucide-react';
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

export function DowngradeConfirmDialog({
  open,
  onOpenChange,
  currentOffer,
  targetOffer,
  renewalDate,
  onConfirmed,
}: DowngradeConfirmDialogProps) {
  const [isLoading, setIsLoading] = useState(false);

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
