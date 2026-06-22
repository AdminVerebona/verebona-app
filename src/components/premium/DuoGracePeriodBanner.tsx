"use client";

import { useSession } from '@/hooks/useSession';
import { AlertCircle, CreditCard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Link from 'next/link';

export function DuoGracePeriodBanner() {
  const { user } = useSession();

  if (!user || user.duoStatus !== 'PAST_DUE_GRACE') {
    return null;
  }

  const deadline = user.graceDeadlineAt ? new Date(user.graceDeadlineAt) : null;
  const daysRemaining = deadline 
    ? Math.ceil((deadline.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24))
    : null;

  return (
    <div className="bg-emerald-500/10 dark:bg-emerald-900/20 border-b border-emerald-500/20 px-4 py-2 flex items-center justify-between gap-4">
      <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-300 text-sm font-medium">
        <AlertCircle className="w-4 h-4" />
        <span>
          Attention : échec de paiement sur votre abonnement Duo.
          {daysRemaining !== null && ` Suspension de l'espace dans ${daysRemaining} jour${daysRemaining > 1 ? 's' : ''}.`}
        </span>
      </div>
      <Link href="/mon-compte">
        <Button size="sm" variant="outline" className="h-8 border-emerald-500/50 text-emerald-600 dark:text-emerald-300 hover:bg-emerald-500/10 gap-2">
          <CreditCard className="w-3.5 h-3.5" />
          Régulariser
        </Button>
      </Link>
    </div>
  );
}
