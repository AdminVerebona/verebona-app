'use client';

import { useEffect, Suspense } from 'react';
import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useRouter, useSearchParams } from 'next/navigation';

function CancelContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const plan = searchParams.get('plan');
    if (plan === 'premium' || plan === 'premium_duo' || plan === 'duo') {
      const normalized = plan === 'duo' ? 'premium_duo' : plan;
      localStorage.setItem('pending_checkout_plan', normalized);
    }
  }, [searchParams]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[color:var(--bg-page)] p-4">
      <div className="w-full max-w-md space-y-4">
        <div className="w-full bg-amber-950/50 border border-amber-500/30 rounded-lg px-4 py-3 flex items-start gap-3">
          <AlertCircle className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
          <p className="text-sm text-amber-200">
            La souscription n'a pas été finalisée.
          </p>
        </div>

        <div className="text-center space-y-1">
          <p className="text-sm text-[color:var(--text-muted)]">
            Aucun paiement n'a été prélevé. Vous pouvez réessayer à tout moment.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Button
            onClick={() => router.push('/mon-compte/offres')}
            className="w-full"
          >
            Retour à mes offres
          </Button>
          <Button
            variant="outline"
            onClick={() => router.push('/accueil')}
            className="w-full"
          >
            Retour à l'accueil
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function AbonnementCancelPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-[color:var(--bg-page)]" />
    }>
      <CancelContent />
    </Suspense>
  );
}
