/**
 * Dialog affiché quand l'utilisateur atteint la limite de 3 biens en Standard
 * SPECS V1: Message selon spécifications avec CTA Premium
 */

'use client';

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
import { Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';

interface AssetLimitReachedDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AssetLimitReachedDialog({
  open,
  onOpenChange,
}: AssetLimitReachedDialogProps) {
  const router = useRouter();

  const handleUpgrade = () => {
    onOpenChange(false);
    router.push('/mon-compte/offres');
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-primary" />
            Limite de biens atteinte
          </AlertDialogTitle>
          <AlertDialogDescription className="text-base">
            Vous avez atteint la limite de 3 biens du plan gratuit.
            <br />
            <br />
            <strong>Supprimez un bien</strong> ou <strong>passez au plan Premium</strong> pour gérer tous vos biens.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Annuler</AlertDialogCancel>
          <AlertDialogAction onClick={handleUpgrade} className="gap-2">
            <Sparkles className="w-4 h-4" />
            Passer à Premium
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
