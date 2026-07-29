'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { ForceTheme } from '@/components/ForceTheme';
import { LogoWithBaseline } from '@/components/Logo';
import { Loader2, ShieldCheck, Gift, Calendar, ArrowRight, AlertCircle } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { runAuthStorageMigration } from '@/lib/auth-migration';

function OnboardingContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const cancelled = searchParams.get('cancelled') === 'true';
  const rawPlanParam = searchParams.get('plan');
  const planFromUrl = rawPlanParam === 'duo' ? 'premium_duo' : rawPlanParam || null;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // CDC §5.1 / §16.4 : plus aucun jeton n'est transporte par l'URL ni ecrit
  // dans le navigateur. La session est deja etablie par les cookies HttpOnly
  // poses lors de la verification. Les anciens parametres `at` et `rt` ne sont
  // plus emis par `/api/auth/verify-email` et ne sont plus lus ici.
  useEffect(() => {
    runAuthStorageMigration();
  }, []);

  const handleStartTrial = async () => {
    setLoading(true);
    setError(null);
    try {
      // L'offre provient uniquement de l'URL. Le repli sur
      // `localStorage.getItem('pending_checkout_plan')` a ete retire : plus
      // aucune ecriture de parcours dans le navigateur (CDC cookies §5.1), et
      // l'inscription ne choisit plus d'offre (CDC tarification §3.1).
      const payload: any = { entry_point: 'onboarding_page' };
      if (planFromUrl) payload.plan = planFromUrl;
      // CDC §4.1 : periodicite choisie (defaut annuel).
      payload.billing_period = searchParams.get('billing_period') === 'monthly' ? 'monthly' : 'yearly';

      const data = await apiClient.post<{ checkout_url?: string; message?: string }>('/api/billing/create-checkout-session', payload);
      if (data.checkout_url) {
        window.location.href = data.checkout_url;
      } else {
        setError(data.message || 'Impossible de démarrer la session de paiement.');
        setLoading(false);
      }
    } catch (err: any) {
      setError(err?.message || 'Une erreur est survenue lors de la création de la session de paiement.');
      setLoading(false);
    }
  };

  return (
    <div className="public-page min-h-screen flex flex-col bg-[color:var(--bg-page)] text-[color:var(--text-primary)]">
      <ForceTheme theme="blue" />

      <header className="flex items-center justify-center py-8 px-4">
        <LogoWithBaseline size={48} />
      </header>

      <main className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-lg bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] rounded-2xl shadow-2xl overflow-hidden">
          <div className="h-1.5 w-full bg-gradient-to-r from-[#3b82f6] to-[#10b981]" />

          <div className="p-8 space-y-6">
            <div className="text-center space-y-2">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold text-emerald-400 bg-emerald-950/40 border border-emerald-800/40 rounded-full">
                <Gift className="w-3.5 h-3.5" /> Offre de bienvenue
              </span>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white mt-3">
                Activez vos 2 mois offerts
              </h1>
              <p className="text-[color:var(--text-muted)] text-sm sm:text-base max-w-md mx-auto">
                Accédez gratuitement à l'ensemble de nos outils pour organiser, sécuriser et valoriser vos biens.
              </p>
            </div>

            {cancelled && (
              <div className="flex items-start gap-3 p-4 bg-blue-950/30 border border-blue-900/50 rounded-xl text-blue-300 text-sm">
                <AlertCircle className="w-5 h-5 flex-shrink-0 text-blue-400 mt-0.5" />
                <div className="space-y-1">
                  <p className="font-semibold text-blue-200">Paiement annulé</p>
                  <p className="text-xs text-blue-400">
                    Pas d'inquiétude, aucune somme n'a été débitée. Vous pouvez reprendre votre inscription à tout moment ci-dessous.
                  </p>
                </div>
              </div>
            )}

            {error && (
              <div className="flex items-start gap-3 p-4 bg-red-950/30 border border-red-900/50 rounded-xl text-red-300 text-sm animate-shake">
                <AlertCircle className="w-5 h-5 flex-shrink-0 text-red-400 mt-0.5" />
                <div className="space-y-1">
                  <p className="font-semibold text-red-200">Une erreur s'est produite</p>
                  <p className="text-xs text-red-400">{error}</p>
                </div>
              </div>
            )}

            <div className="space-y-4 py-2 border-y border-[color:var(--border-subtle)]">
              <div className="flex items-start gap-3">
                <div className="p-2 bg-blue-950/50 border border-blue-900/30 rounded-lg text-[#3b82f6]">
                  <Gift className="w-5 h-5" />
                </div>
                <div>
                  <p className="font-semibold text-white text-sm">2 mois gratuits (60 jours d'essai)</p>
                  <p className="text-xs text-[color:var(--text-muted)]">
                    Découvrez sans engagement l'ensemble des outils conçus pour vos documents et biens.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <div className="p-2 bg-blue-950/50 border border-blue-900/30 rounded-lg text-[#3b82f6]">
                  <Calendar className="w-5 h-5" />
                </div>
                <div>
                  <p className="font-semibold text-white text-sm">Libre et sans engagement</p>
                  <p className="text-xs text-[color:var(--text-muted)]">
                    Annulez en un clic à tout moment depuis votre compte. Vous ne payez rien aujourd'hui.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <div className="p-2 bg-blue-950/50 border border-blue-900/30 rounded-lg text-[#3b82f6]">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <div>
                  <p className="font-semibold text-white text-sm">Sécurisé par Stripe</p>
                  <p className="text-xs text-[color:var(--text-muted)]">
                    Vos informations de paiement sont cryptées et gérées par Stripe, leader mondial des paiements en ligne.
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <button
                onClick={handleStartTrial}
                disabled={loading}
                className="w-full flex items-center justify-center gap-2 py-3.5 px-4 bg-[#3b82f6] hover:bg-[#2563eb] text-white font-semibold rounded-xl shadow-lg shadow-blue-500/10 hover:shadow-blue-500/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed group cursor-pointer"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Chargement…
                  </>
                ) : (
                  <>
                    Commencer mes 2 mois offerts
                    <ArrowRight className="w-5 h-5 transition-transform group-hover:translate-x-1" />
                  </>
                )}
              </button>

              <div className="text-center">
                <p className="text-xs text-[color:var(--text-muted)]">
                  Facturation selon le plan choisi à la fin des 2 mois d'essai, sauf annulation préalable de votre part.
                </p>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

export default function OnboardingPage() {
  return (
    <Suspense fallback={
      <div className="public-page min-h-screen flex items-center justify-center bg-[color:var(--bg-page)]">
        <ForceTheme theme="blue" />
        <Loader2 className="w-8 h-8 text-[#3b82f6] animate-spin" />
      </div>
    }>
      <OnboardingContent />
    </Suspense>
  );
}
