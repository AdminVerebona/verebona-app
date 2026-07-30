'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSession } from '@/hooks/useSession';
import { useBreadcrumb } from '@/contexts/BreadcrumbContext';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client';
import { toast } from 'sonner';
import { Check, Loader2, Gift } from 'lucide-react';
import { DowngradeConfirmDialog } from '@/components/subscription/DowngradeConfirmDialog';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import { getPlanTheme } from '@/lib/plan-theme';
import { SubscriptionSummary } from '@/components/subscription/SubscriptionSummary';

interface BillingInfo {
  plan_type: string;
  premium_until: string | null;
  subscription_status: string | null;
  role: string;
}

const offers = [
  {
    id: 'STANDARD',
    monthlyPrice: '2,90 €',
    yearlyPrice: '29 €',
    features: [
      '2 biens actifs',
      '10 documents analysés pendant essai',
      '50 documents analysés par an',
      'Agenda de mes biens',
      'Accès desktop et mobile',
      'Export ZIP de mes documents',
    ],
  },
  {
    id: 'PREMIUM',
    monthlyPrice: '5,90 €',
    yearlyPrice: '59 €',
    features: [
      'Tout Standard inclus',
      '10 biens actifs',
      '30 documents analysés pendant essai',
      '200 documents analysés par an',
      'Analyse automatique des documents IA',
      'Synchronisation avec votre agenda personnel',
      'Exports documentaires prêts à utiliser',
      'Support prioritaire',
    ],
  },
  {
    id: 'PREMIUM_DUO',
    monthlyPrice: '8,90 €',
    yearlyPrice: '89 €',
    features: [
      'Tout Premium inclus',
      '2 membres sur un même compte',
      '15 biens actifs',
      '50 documents analysés pendant essai',
      '300 documents analysés par an',
      'Espace commun : biens, documents, échéances',
      'Gestion collaborative',
    ],
  },
  {
    id: 'PREMIUM_PRO',
    monthlyPrice: '',
    yearlyPrice: '',
    features: [
      'Tout Premium inclus',
      'Gestion matériel professionnel',
      'Plusieurs utilisateurs avec rôles',
      'Gestion TTC/HT et TVA',
      'Rapports de valorisation avancés',
      'API et intégrations avancées',
      'Support prioritaire dédié',
    ],
    comingSoon: true,
  },
];

export default function OffresPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useSession();
  const { setBreadcrumbs } = useBreadcrumb();

  useEffect(() => {
    setBreadcrumbs([{ label: 'Mon compte', href: '/mon-compte' }, { label: 'Offres' }]);
  }, [setBreadcrumbs]);

  const [billingInfo, setBillingInfo] = useState<BillingInfo | null>(null);
  const [billingLoaded, setBillingLoaded] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);
  // CDC §4.1 : l'utilisateur choisit son offre ET sa periodicite.
  const [billingPeriod, setBillingPeriod] = useState<'monthly' | 'yearly'>('yearly');
  // Periodicite reellement facturee, pour distinguer souscription et changement
  const [activePeriod, setActivePeriod] = useState<'monthly' | 'yearly' | null>(null);
  const [hasSubscription, setHasSubscription] = useState(false);

  useEffect(() => {
    // CDC §17 : consultation des offres
    void fetch('/api/analytics/track', {
      credentials: 'include',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'offers_viewed' }),
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/billing/trial-status', { credentials: 'include' });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        setHasSubscription(Boolean(data.subscription?.hasStripeSubscription));
        setActivePeriod(data.subscription?.billingPeriod ?? null);
        if (data.subscription?.billingPeriod) setBillingPeriod(data.subscription.billingPeriod);
      } catch {
        // Sans cette information, on reste sur le comportement de souscription.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /** Programme un changement d'offre ou de periodicite (CDC §10). */
  const handleScheduleChange = async (planId: string) => {
    setCheckoutLoading(planId);
    try {
      const res = await fetch('/api/billing/schedule-change', {
      credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan_code: planId.toLowerCase(), billing_period: billingPeriod }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(
          data.effectiveAt
            ? `Changement programmé pour le ${new Date(data.effectiveAt).toLocaleDateString('fr-FR')}.`
            : 'Changement programmé pour la prochaine échéance.',
        );
      } else {
        toast.error(data.message || 'Impossible de programmer ce changement.');
      }
    } catch {
      toast.error('Une erreur est survenue.');
    } finally {
      setCheckoutLoading(null);
    }
  };

  // Code de parrainage — depuis URL (?ref=CODE) ou cookie
  const [referralCode, setReferralCode] = useState<string | null>(null);
  const [referralValid, setReferralValid] = useState<boolean | null>(null);

  useEffect(() => {
    // CDC §4.3 : le code provient uniquement du parcours en cours (URL).
    // Aucune lecture de cookie ni de stockage local.
    const code = searchParams?.get('ref');
    if (code) {
      setReferralCode(code.toUpperCase());
      // Valider le code
      fetch(`/api/referral/validate/${code.toUpperCase()}`, { credentials: 'include' })
        .then((r) => r.json())
        .then((data) => setReferralValid(data.valid === true))
        .catch(() => setReferralValid(false));
    }
  }, [searchParams]);

  const [downgradeDialog, setDowngradeDialog] = useState<{
    open: boolean;
    targetOffer: string;
    renewalDate: string | null;
  }>({ open: false, targetOffer: '', renewalDate: null });

  // Load billing info once
  useEffect(() => {
    apiClient.get<any>('/api/billing/me').then((data) => {
      setBillingInfo({
        plan_type: data.plan_type?.toUpperCase() || 'STANDARD',
        premium_until: data.premium_until || null,
        subscription_status: data.subscription_status || null,
        role: data.role || 'owner',
      });
      setBillingLoaded(true);
    }).catch(() => setBillingLoaded(true));
  }, []);

  const rawCurrentPlan = billingInfo?.plan_type || user?.subscription?.plan || 'STANDARD';
  const currentPlan = rawCurrentPlan;
  const isDuoMember = user?.duoRole === 'MEMBER';
  const renewalDate = billingInfo?.premium_until
    ? format(new Date(Number(billingInfo.premium_until) * 1000), 'PPP', { locale: fr })
    : null;

  const handleUpgrade = async (planId: string) => {
    setCheckoutLoading(planId);
    try {
      const data = await apiClient.post<any>('/api/billing/create-checkout-session', {
        plan: planId.toLowerCase(),
        billing_period: billingPeriod,
        entry_point: 'app_offer_comparison',
        ...(referralValid && referralCode ? { referralCode } : {}),
      });
      if (data.checkout_url) {
        window.location.href = data.checkout_url;
      } else {
        toast.error(data.message || 'Impossible de démarrer le paiement.');
      }
    } catch (error: any) {
      toast.error(error.message || 'Une erreur est survenue.');
    } finally {
      setCheckoutLoading(null);
    }
  };

  const handleDowngrade = (targetPlan: string) => {
    setDowngradeDialog({ open: true, targetOffer: targetPlan, renewalDate });
  };

  const getButtonState = (offerId: string): { label: string; action: (() => void) | null; variant: 'default' | 'outline' | 'ghost'; disabled: boolean } => {
    if (offerId === 'PREMIUM_PRO') {
      return { label: 'Bientôt disponible', action: null, variant: 'outline', disabled: true };
    }
    // Offre ET periodicite identiques : rien a proposer.
    if (offerId === currentPlan && (!activePeriod || activePeriod === billingPeriod)) {
      return { label: 'Offre actuelle', action: null, variant: 'outline', disabled: true };
    }

    // CDC §10 : pour un compte deja abonne, tout changement — d'offre comme de
    // periodicite — est programme pour la prochaine echeance, jamais immediat.
    if (hasSubscription) {
      const theme = getPlanTheme(offerId as any);
      const sameOffer = offerId === currentPlan;
      return {
        label: sameOffer
          ? `Passer en ${billingPeriod === 'monthly' ? 'mensuel' : 'annuel'}`
          : `Programmer ${theme.label}`,
        action: () => handleScheduleChange(offerId),
        variant: sameOffer ? 'outline' : 'default',
        disabled: false,
      };
    }
    if (isDuoMember) {
      return { label: 'Lecture seule', action: null, variant: 'ghost', disabled: true };
    }

    const planOrder = ['STANDARD', 'PREMIUM', 'PREMIUM_DUO', 'PREMIUM_PRO'];
    const currentIndex = planOrder.indexOf(currentPlan);
    const targetIndex = planOrder.indexOf(offerId);

    if (targetIndex > currentIndex) {
      const theme = getPlanTheme(offerId as any);
      return {
        label: `Passer à ${theme.label}`,
        action: () => handleUpgrade(offerId),
        variant: 'default',
        disabled: false,
      };
    } else {
      const theme = getPlanTheme(offerId as any);
      return {
        label: `Choisir ${theme.label}`,
        action: () => handleDowngrade(offerId),
        variant: 'outline',
        disabled: false,
      };
    }
  };

  return (
    <>
      <div className="space-y-5 w-full max-w-full">

        <div>
          <h1 className="text-xl md:text-3xl font-bold">
            Choisissez votre abonnement
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Comparez les offres et choisissez celle qui vous convient.
          </p>
        </div>

        {/* Bandeau parrainage filleul */}
        {referralValid && referralCode && (
          <div className="flex items-start gap-3 bg-blue-950/30 border border-blue-500/30 rounded-lg px-4 py-3">
            <Gift className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-blue-200">Offre parrainage active — code <span className="font-mono">{referralCode}</span></p>
              <p className="text-xs text-blue-300 mt-0.5">En souscrivant maintenant, vous bénéficiez de <strong>3 mois d'essai offerts</strong> au lieu de 2, grâce à votre parrain.</p>
            </div>
          </div>
        )}

        {referralCode && referralValid === false && (
          <div className="flex items-start gap-3 bg-amber-950/30 border border-amber-500/30 rounded-lg px-4 py-3">
            <Gift className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-amber-200">Le code de parrainage <span className="font-mono font-semibold">{referralCode}</span> n'est pas valide ou a expiré.</p>
          </div>
        )}

        {isDuoMember && (
          <div className="bg-amber-950/30 border border-amber-500/30 rounded-lg px-4 py-3 text-sm text-amber-200">
            {"Seul le titulaire de l'abonnement peut modifier l'offre et gérer le paiement."}
          </div>
        )}

        {/* Etat de l'abonnement (CDC §9.1 / §9.4) */}
        <SubscriptionSummary />

        {/* Choix de la periodicite (CDC §4.1) */}
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <div
            role="group"
            aria-label="Periodicite de facturation"
            className="inline-flex gap-1 rounded-full border border-[color:var(--border)] bg-[color:var(--bg-subtle)] p-1"
          >
            <button
              type="button"
              onClick={() => setBillingPeriod('monthly')}
              className={
                billingPeriod === 'monthly'
                  ? 'rounded-full bg-[color:var(--bg-page)] px-4 py-1.5 text-sm font-medium text-[color:var(--text-primary)] shadow-sm'
                  : 'rounded-full px-4 py-1.5 text-sm font-medium text-[color:var(--text-muted)]'
              }
            >
              Mensuel
            </button>
            <button
              type="button"
              onClick={() => setBillingPeriod('yearly')}
              className={
                billingPeriod === 'yearly'
                  ? 'rounded-full bg-[color:var(--bg-page)] px-4 py-1.5 text-sm font-medium text-[color:var(--text-primary)] shadow-sm'
                  : 'rounded-full px-4 py-1.5 text-sm font-medium text-[color:var(--text-muted)]'
              }
            >
              Annuel
            </button>
          </div>
          {billingPeriod === 'yearly' && (
            <span className="text-sm text-[color:var(--text-muted)]">
              En annuel, vous economisez l&apos;equivalent de 2 mois.
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 max-w-6xl">
          {offers.map((offer) => {
            const theme = getPlanTheme(offer.id as any);
            const Icon = theme.icon;
            const isCurrentPlan = offer.id === currentPlan;
            const btn = getButtonState(offer.id);

            return (
              <div
                key={offer.id}
                className={`relative flex flex-col rounded-xl border p-5 bg-[color:var(--bg-card)] ${isCurrentPlan ? (offer.id === 'PREMIUM' ? 'border-blue-500/50 ring-2 ring-blue-500/40' : offer.id === 'PREMIUM_DUO' ? 'border-emerald-500/50 ring-2 ring-emerald-500/40' : 'border-slate-400/50 ring-2 ring-slate-400/40') : theme.colors.border} ${offer.comingSoon ? 'opacity-60' : ''}`}
              >
                {isCurrentPlan && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 z-10">
                    <span className={`text-xs font-semibold px-3 py-1.5 rounded-full backdrop-blur-sm ${offer.id === 'PREMIUM' ? 'bg-blue-600/90 text-white border border-blue-500' : offer.id === 'PREMIUM_DUO' ? 'bg-emerald-600/90 text-white border border-emerald-500' : 'bg-slate-500/90 text-white border border-slate-400'}`}>
                      Offre actuelle
                    </span>
                  </div>
                )}

                <div className="flex items-center gap-2 mb-3">
                  <Icon className={`w-5 h-5 ${theme.colors.icon}`} />
                  <span className="font-semibold text-[color:var(--text-primary)]">{theme.label}</span>
                </div>

                <div className="mb-4">
                  {offer.comingSoon ? (
                    <p className="text-sm text-[color:var(--text-muted)] italic">Bientôt disponible</p>
                  ) : (
                    <>
                      <span className="text-2xl font-bold text-[color:var(--text-primary)]">
                        {billingPeriod === 'yearly' ? offer.yearlyPrice : offer.monthlyPrice}
                      </span>
                      <span className="text-sm text-[color:var(--text-muted)] ml-1">
                        {billingPeriod === 'yearly' ? 'par an' : 'par mois'}
                      </span>
                    </>
                  )}
                </div>

                <ul className="space-y-1.5 mb-5 flex-1">
                  {offer.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2 text-sm text-[color:var(--text-muted)]">
                      <Check className={`w-3.5 h-3.5 mt-0.5 ${offer.id === 'PREMIUM' ? 'text-blue-400' : offer.id === 'PREMIUM_DUO' ? 'text-emerald-400' : 'text-slate-400'} flex-shrink-0`} />
                      {feature}
                    </li>
                  ))}
                </ul>

                <Button
                  variant={btn.variant}
                  disabled={btn.disabled || checkoutLoading === offer.id}
                  onClick={btn.action || undefined}
                  className={`w-full text-sm ${btn.variant === 'default' ? (offer.id === 'PREMIUM' ? '!bg-blue-600 hover:!bg-blue-700' : offer.id === 'PREMIUM_DUO' ? '!bg-emerald-600 hover:!bg-emerald-700 !border-emerald-600' : offer.id === 'STANDARD' ? '!bg-slate-600 hover:!bg-slate-700' : '') : ''}`}
                  size="sm"
                >
                  {checkoutLoading === offer.id ? (
                    <Loader2 className="w-4 h-4 animate-spin mr-1" />
                  ) : null}
                  {btn.label}
                </Button>
              </div>
            );
          })}
        </div>

        <DowngradeConfirmDialog
          open={downgradeDialog.open}
          onOpenChange={(open) => setDowngradeDialog((prev) => ({ ...prev, open }))}
          currentOffer={currentPlan}
          targetOffer={downgradeDialog.targetOffer}
          renewalDate={downgradeDialog.renewalDate}
          onConfirmed={() => router.push('/mon-compte')}
        />
      </div>
    </>
  );
}
