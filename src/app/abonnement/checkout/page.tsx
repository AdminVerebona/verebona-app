"use client";

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { ForceTheme } from '@/components/ForceTheme';
import { LogoWithBaseline } from '@/components/Logo';
import { Loader2 } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import Link from 'next/link';

function CheckoutRedirect() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const rawPlan = searchParams.get('plan') || 'standard';
  const plan = rawPlan === 'duo' ? 'premium_duo' : rawPlan;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('bearer_token') : null;
    if (!token) {
      router.replace(`/login?returnUrl=/abonnement/checkout?plan=${plan}`);
      return;
    }

    apiClient.post<{ checkout_url?: string; message?: string }>('/api/billing/create-checkout-session', {
      plan,
      entry_point: 'signup_offer_flow',
    })
      .then((data) => {
        if (data.checkout_url) {
          window.location.href = data.checkout_url;
        } else {
          setError(data.message || 'Impossible de démarrer le paiement.');
        }
      })
      .catch((err) => {
        setError(err?.message || 'Une erreur est survenue.');
      });
  }, [plan, router]);

  return (
    <div className="public-page min-h-screen flex flex-col bg-[color:var(--bg-page)]">
      <ForceTheme theme="blue" />
      <header className="flex items-center justify-center py-6 px-4">
        <Link href="/"><LogoWithBaseline size={40} /></Link>
      </header>
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-sm bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] rounded-2xl shadow-2xl overflow-hidden">
          <div className="h-1 w-full bg-gradient-to-r from-[#3b82f6] to-[#22c55e]" />
          <div className="p-8 text-center space-y-4">
            {error ? (
              <>
                <p className="text-red-400 text-sm">{error}</p>
                <Link href="/mon-compte/offres" className="text-[#3b82f6] text-sm underline">
                  Réessayer depuis votre espace
                </Link>
              </>
            ) : (
              <>
                <Loader2 className="w-10 h-10 text-[#3b82f6] animate-spin mx-auto" />
                <p className="text-[color:var(--text-primary)] font-medium">Préparation du paiement…</p>
                <p className="text-sm text-[color:var(--text-muted)]">Vous allez être redirigé vers Stripe.</p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function CheckoutPage() {
  return (
    <Suspense fallback={
      <div className="public-page min-h-screen flex items-center justify-center bg-[color:var(--bg-page)]">
        <ForceTheme theme="blue" />
        <Loader2 className="w-8 h-8 text-[#3b82f6] animate-spin" />
      </div>
    }>
      <CheckoutRedirect />
    </Suspense>
  );
}
