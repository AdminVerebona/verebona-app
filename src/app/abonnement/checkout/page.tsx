"use client";

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { ForceTheme } from '@/components/ForceTheme';
import { LogoWithBaseline } from '@/components/Logo';
import { Loader2 } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { useBillingCatalog } from '@/hooks/useBillingCatalog';
import { parsePlanInput, PLAN_LABELS } from '@/lib/billing/plan-catalog';
import { billingMention, findOffer, offerAmount, periodSuffix, priceConfirmationFromError, type CatalogOffer } from '@/lib/billing/catalog-client';

/**
 * Préparation du paiement — CDC lookup_key V4, LK-34, LK-35, TC-35, TC-36.
 *
 * La page lançait Checkout dès son affichage, sans montrer de montant. Une
 * souscription exige désormais la RÉVISION du prix affiché : l'offre, la
 * périodicité et le montant (catalogue serveur) sont présentés, et c'est le
 * clic de l'utilisateur qui crée la session. Si le tarif change entre-temps,
 * le nouveau montant remplace l'ancien et un nouveau clic est requis — aucun
 * renvoi automatique. Même composant sur desktop et mobile.
 */
function CheckoutRedirect() {
  const searchParams = useSearchParams();
  const parsed = parsePlanInput(searchParams.get('plan') || 'standard');
  const plan = parsed.ok ? parsed.plan : null;
  const billingPeriod = searchParams.get('billing_period') === 'monthly' ? 'monthly' : 'yearly';
  const { catalog, loading } = useBillingCatalog();
  const [offer, setOffer] = useState<CatalogOffer | null>(null);
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!plan || changed) return;
    setOffer(findOffer(catalog, plan, billingPeriod));
  }, [catalog, plan, billingPeriod, changed]);

  const start = async () => {
    if (!plan || !offer) return;
    setBusy(true);
    setError(null);
    try {
      const data = await apiClient.post<{ checkout_url?: string; message?: string }>('/api/billing/create-checkout-session', {
        plan,
        billing_period: billingPeriod,
        displayed_price_revision: offer.price_revision,
        entry_point: 'signup_offer_flow',
      });
      if (data.checkout_url) {
        window.location.href = data.checkout_url;
        return;
      }
      setError(data.message || 'Impossible de démarrer le paiement.');
    } catch (err) {
      const confirmation = priceConfirmationFromError(err);
      if (confirmation) {
        // Nouveau montant affiché ; l'utilisateur doit cliquer de nouveau.
        setOffer(confirmation.offer);
        setChanged(true);
      } else {
        setError((err as Error)?.message || 'Une erreur est survenue.');
      }
    }
    setBusy(false);
  };

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
            {!plan ? (
              <p className="text-red-400 text-sm">Offre inconnue.</p>
            ) : loading ? (
              <>
                <Loader2 className="w-10 h-10 text-[#3b82f6] animate-spin mx-auto" />
                <p className="text-[color:var(--text-primary)] font-medium">Chargement du tarif…</p>
              </>
            ) : !offer ? (
              <p className="text-sm text-[color:var(--text-muted)]">Cette offre est momentanément indisponible. Aucun paiement n&apos;a été lancé.</p>
            ) : (
              <>
                <p className="text-sm text-[color:var(--text-muted)]">{PLAN_LABELS[plan]}</p>
                <p className="text-2xl font-bold text-[color:var(--text-primary)]" data-testid="checkout-amount">
                  {offerAmount(offer)} <span className="text-sm font-normal text-[color:var(--text-muted)]">{periodSuffix(offer.billing_period)}</span>
                </p>
                {billingMention(offer) && <p className="text-xs text-[color:var(--text-muted)]">{billingMention(offer)}</p>}
                {changed && (
                  <p className="text-sm text-amber-500">
                    Le tarif a changé depuis l&apos;affichage de cette page. Vérifiez le nouveau montant avant de continuer.
                  </p>
                )}
                <Button className="w-full" disabled={busy} onClick={start}>
                  {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                  Continuer vers le paiement
                </Button>
                <p className="text-xs text-[color:var(--text-muted)]">Vous allez être redirigé vers Stripe.</p>
              </>
            )}
            {error && (
              <>
                <p className="text-red-400 text-sm">{error}</p>
                <Link href="/mon-compte/offres" className="text-[#3b82f6] text-sm underline">
                  Réessayer depuis votre espace
                </Link>
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
