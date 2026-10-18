'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { ForceTheme } from '@/components/ForceTheme';
import { LogoWithBaseline } from '@/components/Logo';
import { Loader2, ShieldCheck, Gift, Calendar, ArrowRight, AlertCircle } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { runAuthStorageMigration } from '@/lib/auth-migration';
import { useBillingCatalog } from '@/hooks/useBillingCatalog';
import { billingMention, findOffer, offerAmount, periodSuffix, priceConfirmationFromError, type CatalogOffer } from '@/lib/billing/catalog-client';

function OnboardingContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const cancelled = searchParams.get('cancelled') === 'true';
  const rawPlanParam = searchParams.get('plan');
  const planFromUrl = rawPlanParam === 'duo' ? 'premium_duo' : rawPlanParam || null;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // CDC lookup_key V4 (LK-34, LK-35) : le montant est affiché depuis le
  // catalogue serveur et sa révision accompagne la demande ; un tarif changé
  // est présenté et exige un nouveau clic (aucun renvoi automatique).
  const periodChoice: 'monthly' | 'yearly' = searchParams.get('billing_period') === 'monthly' ? 'monthly' : 'yearly';
  const { catalog } = useBillingCatalog();
  const [confirmedOffer, setConfirmedOffer] = useState<CatalogOffer | null>(null);
  const [priceChanged, setPriceChanged] = useState(false);
  const shownOffer = confirmedOffer ?? (planFromUrl ? findOffer(catalog, planFromUrl, periodChoice) : null);

  // CDC §5.1 / §16.4 : plus aucun jeton n'est transporte par l'URL ni ecrit
  // dans le navigateur. La session est deja etablie par les cookies HttpOnly
  // poses lors de la verification. Les anciens parametres `at` et `rt` ne sont
  // plus emis par `/api/auth/verify-email` et ne sont plus lus ici.
  useEffect(() => {
    runAuthStorageMigration();
  }, []);

  const handleStartTrial = async () => {
    // Sans offre choisie : la page Offres présente les tarifs (plus aucune
    // offre par défaut côté serveur, LK-37).
    if (!planFromUrl) {
      router.push('/mon-compte/offres');
      return;
    }
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
      payload.billing_period = periodChoice;
      payload.displayed_price_revision = shownOffer?.price_revision ?? null;

      const data = await apiClient.post<{ checkout_url?: string; message?: string }>('/api/billing/create-checkout-session', payload);
      if (data.checkout_url) {
        window.location.href = data.checkout_url;
      } else {
        setError(data.message || 'Impossible de démarrer la session de paiement.');
        setLoading(false);
      }
    } catch (err: any) {
      const confirmation = priceConfirmationFromError(err);
      if (confirmation) {
        setConfirmedOffer(confirmation.offer);
        setPriceChanged(true);
      } else {
        setError(err?.message || 'Une erreur est survenue lors de la création de la session de paiement.');
      }
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
          <div className="h-1.5 w-full bg-[color:var(--accent)]" />

          <div className="p-8 space-y-6">
            <div className="text-center space-y-2">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold text-[color:var(--text-success)] bg-[color:var(--bg-success)] border border-[color:var(--border-success)] rounded-full">
                <Gift className="w-3.5 h-3.5" /> Offre de bienvenue
              </span>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[color:var(--text-primary)] mt-3">
                Activez vos 2 mois offerts
              </h1>
              <p className="text-[color:var(--text-muted)] text-sm sm:text-base max-w-md mx-auto">
                Accédez gratuitement à l'ensemble de nos outils pour organiser, sécuriser et valoriser vos biens.
              </p>
            </div>

            {cancelled && (
              <div className="flex items-start gap-3 p-4 bg-[color:var(--accent-soft)] border border-[color:var(--border-info)] rounded-xl text-[color:var(--text-info)] text-sm">
                <AlertCircle className="w-5 h-5 flex-shrink-0 text-[color:var(--accent)] mt-0.5" />
                <div className="space-y-1">
                  <p className="font-semibold text-[color:var(--text-info-soft)]">Paiement annulé</p>
                  <p className="text-xs text-[color:var(--accent)]">
                    Pas d'inquiétude, aucune somme n'a été débitée. Vous pouvez reprendre votre inscription à tout moment ci-dessous.
                  </p>
                </div>
              </div>
            )}

            {error && (
              <div className="flex items-start gap-3 p-4 bg-[color:var(--danger-soft)] border border-[color:var(--danger-edge)] rounded-xl text-[color:var(--text-danger)] text-sm animate-shake">
                <AlertCircle className="w-5 h-5 flex-shrink-0 text-[color:var(--danger)] mt-0.5" />
                <div className="space-y-1">
                  <p className="font-semibold text-[color:var(--text-danger-soft)]">Une erreur s'est produite</p>
                  <p className="text-xs text-[color:var(--danger)]">{error}</p>
                </div>
              </div>
            )}

            <div className="space-y-4 py-2 border-y border-[color:var(--border-subtle)]">
              <div className="flex items-start gap-3">
                <div className="p-2 bg-[color:var(--accent-soft)] border border-[color:var(--border-info)] rounded-lg text-[color:var(--accent)]">
                  <Gift className="w-5 h-5" />
                </div>
                <div>
                  <p className="font-semibold text-[color:var(--text-primary)] text-sm">2 mois gratuits (60 jours d'essai)</p>
                  <p className="text-xs text-[color:var(--text-muted)]">
                    Découvrez sans engagement l'ensemble des outils conçus pour vos documents et biens.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <div className="p-2 bg-[color:var(--accent-soft)] border border-[color:var(--border-info)] rounded-lg text-[color:var(--accent)]">
                  <Calendar className="w-5 h-5" />
                </div>
                <div>
                  <p className="font-semibold text-[color:var(--text-primary)] text-sm">Libre et sans engagement</p>
                  <p className="text-xs text-[color:var(--text-muted)]">
                    Annulez en un clic à tout moment depuis votre compte. Vous ne payez rien aujourd'hui.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <div className="p-2 bg-[color:var(--accent-soft)] border border-[color:var(--border-info)] rounded-lg text-[color:var(--accent)]">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <div>
                  <p className="font-semibold text-[color:var(--text-primary)] text-sm">Sécurisé par Stripe</p>
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
                className="w-full flex items-center justify-center gap-2 py-3.5 px-4 bg-[color:var(--accent)] hover:bg-[color:var(--accent-hover)] text-[color:var(--on-accent)] font-bold rounded-[12px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed group cursor-pointer"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Chargement…
                  </>
                ) : (
                  <>
                    Commencer mes 2 mois offerts
                    <ArrowRight className="w-5 h-5" />
                  </>
                )}
              </button>

              {shownOffer && (
                <div className="text-center" data-testid="onboarding-amount">
                  <p className="text-sm text-[color:var(--text-primary)]">
                    Tarif : <span className="font-semibold">{offerAmount(shownOffer)}</span> {periodSuffix(shownOffer.billing_period)}
                    {billingMention(shownOffer) ? ` (${billingMention(shownOffer)})` : ''}
                  </p>
                  {priceChanged && (
                    <p className="text-xs text-[color:var(--attention-on-soft)] mt-1">
                      Le tarif a changé depuis l&apos;affichage de cette page. Vérifiez le nouveau montant avant de continuer.
                    </p>
                  )}
                </div>
              )}

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
        <Loader2 className="w-8 h-8 text-[color:var(--accent)] animate-spin" />
      </div>
    }>
      <OnboardingContent />
    </Suspense>
  );
}
