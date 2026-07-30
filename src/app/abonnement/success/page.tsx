'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Loader2, Sparkles, CheckCircle2 } from 'lucide-react';
import { PendingSyncBanner } from '@/components/subscription/PendingSyncBanner';

function AbonnementSuccessContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionId = searchParams.get('session_id');
  const [synced, setSynced] = useState(false);
  const [checking, setChecking] = useState(true);
  const [planType, setPlanType] = useState<string | null>(null);

  // Poll until webhook syncs the plan — up to 30s with increasing intervals
  useEffect(() => {
    let attempts = 0;
    let stopped = false;
    const DELAYS = [2000, 2000, 3000, 3000, 5000, 5000, 5000, 5000]; // ~30s total

    const poll = async () => {
      if (stopped) return;
      try {
        const url = sessionId ? `/api/billing/me?session_id=${encodeURIComponent(sessionId)}` : '/api/billing/me';
        const res = await fetch(url, {
          credentials: 'include',
        });
        if (res.ok) {
          const data = await res.json();
          const plan = data.plan_type?.toUpperCase();
          const status = data.subscription_status?.toUpperCase();

          if (status === 'TRIALING' || status === 'ACTIVE' || (plan && plan !== 'STANDARD')) {
            stopped = true;
            localStorage.removeItem('pending_checkout_plan');
            setPlanType(plan);

            // Force a refresh of the user session / JWT token
            try {
              const refreshRes = await fetch('/api/auth/refresh', {
      credentials: 'include',
                method: 'POST',
              });
              if (refreshRes.ok) {
                const refreshData = await refreshRes.json();
                if (refreshData.accessToken) {
                }
              }
            } catch (err) {
              console.error('[Success] Failed to refresh token:', err);
            }

            setSynced(true);
            setChecking(false);
            setTimeout(() => router.push('/accueil'), 1800);
            return;
          }
        }
      } catch {}
      if (stopped) return;
      const delay = DELAYS[attempts] ?? null;
      attempts++;
      if (delay !== null) {
        setTimeout(poll, delay);
      } else {
        setChecking(false);
      }
    };
    poll();
    return () => { stopped = true; };
  }, [router]);

  const handleSynced = () => {
    setSynced(true);
    setTimeout(() => router.push('/accueil'), 1800);
  };

  const planLabel = planType === 'PREMIUM_DUO' ? 'Premium Duo' : planType === 'PREMIUM_PRO' ? 'Premium Pro' : planType === 'PREMIUM' ? 'Premium' : 'Standard';

  return (
    <div className="min-h-screen flex items-center justify-center bg-[color:var(--bg-page)] p-4">
      <div className="w-full max-w-md space-y-4">
        {checking && !synced && (
          <div className="text-center space-y-4">
            <Loader2 className="w-12 h-12 text-blue-400 animate-spin mx-auto" />
            <p className="text-[color:var(--text-muted)] text-sm">Vérification de votre paiement…</p>
            <PendingSyncBanner onSynced={handleSynced} />
          </div>
        )}

        {!checking && !synced && (
          <div className="space-y-4">
            <PendingSyncBanner onSynced={handleSynced} />
            <div className="text-center">
              <Button
                variant="outline"
                onClick={() => router.push('/accueil')}
                className="mt-2"
              >
                Continuer vers l'accueil
              </Button>
            </div>
          </div>
        )}

        {synced && (
          <div className="text-center space-y-4 animate-in fade-in duration-300">
            <CheckCircle2 className="w-14 h-14 text-green-400 mx-auto" />
            <div>
              <p className="text-lg font-semibold text-[color:var(--text-primary)] flex items-center justify-center gap-2">
                <Sparkles className="w-5 h-5 text-blue-400" />
                Abonnement {planLabel} activé !
              </p>
              <p className="text-sm text-[color:var(--text-muted)] mt-1">
                Redirection vers l'accueil…
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function AbonnementSuccessPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-10 h-10 animate-spin text-blue-400" />
      </div>
    }>
      <AbonnementSuccessContent />
    </Suspense>
  );
}
