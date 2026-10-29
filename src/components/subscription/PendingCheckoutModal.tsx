'use client';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Crown, Users } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useNativeCommerceHidden } from '@/hooks/useNativeCommerceHidden';

interface PendingCheckoutModalProps {
  plan: 'premium' | 'premium_duo';
  onDismiss: () => void;
}

export function PendingCheckoutModal({ plan, onDismiss }: PendingCheckoutModalProps) {
  const router = useRouter();
  // Lot 97B (COM-01/05) : jamais de reprise de paiement dans l'application.
  const commerceHidden = useNativeCommerceHidden();

  const isDuo = plan === 'premium_duo';
  if (commerceHidden) return null;

  const handleCheckout = () => {
    onDismiss();
    router.push(`/abonnement/checkout?plan=${plan}`);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onDismiss(); }}>
      <DialogContent className="max-w-md bg-[color:var(--bg-card)] border-[color:var(--border-subtle)]">
        <DialogHeader className="space-y-3">
          <div className="flex justify-center">
            <div className={`w-14 h-14 rounded-2xl flex items-center justify-center ${
              isDuo
                ? 'bg-[color:var(--bg-success)] border border-[color:var(--border-success)]'
                : 'bg-[color:var(--accent-soft)] border border-[color:var(--border-info)]'
            }`}>
              {isDuo
                ? <Users className="w-7 h-7 text-[color:var(--text-success)]" />
                : <Crown className="w-7 h-7 text-[color:var(--accent)]" />
              }
            </div>
          </div>
          <DialogTitle className="text-center text-[color:var(--text-primary)]">
            Votre paiement n'a pas abouti
          </DialogTitle>
          <DialogDescription className="text-center text-[color:var(--text-muted)] leading-relaxed">
            Votre compte est actuellement en <span className="font-medium text-[color:var(--text-primary)]">Standard</span>.
            {' '}Vous pouvez finaliser votre passage à{' '}
            <span className={`font-medium ${isDuo ? 'text-[color:var(--text-success)]' : 'text-[color:var(--accent)]'}`}>
              {isDuo ? 'Premium Duo' : 'Premium'}
            </span>{' '}
            à tout moment — aucun paiement n'a été prélevé.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 mt-2">
          <Button
            className={`w-full font-semibold ${
              isDuo
                ? 'bg-[color:var(--accent)] hover:bg-[color:var(--accent-hover)] text-[color:var(--on-accent)]'
                : 'bg-[color:var(--accent)] hover:bg-[color:var(--accent-hover)] text-[color:var(--on-accent)]'
            }`}
            onClick={handleCheckout}
          >
            Passer à {isDuo ? 'Premium Duo' : 'Premium'}
          </Button>
          <Button
            variant="ghost"
            className="w-full text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]"
            onClick={onDismiss}
          >
            Continuer en Standard
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
