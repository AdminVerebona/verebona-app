'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CreditCard, AlertTriangle, Clock, Crown, Lock, ShieldAlert, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client';
import { toast } from 'sonner';
import { useSession } from '@/hooks/useSession';
import { ReferralBlock } from '@/components/account/ReferralBlock';
import { DuoInvitationPanel } from './DuoInvitationPanel';
import { libelleEssai } from './trial-label';

/**
 * Ecran « Mon abonnement » (CDC tarification §9.1 et §9.4).
 *
 * Affiche l'etat reel du compte tel que calcule par le serveur : offre et
 * periodicite actives, prochaine echeance, reconduction, consommation des
 * quotas, acces aux factures et resiliation.
 *
 * Aucune donnee n'est deduite cote client : tout provient de
 * /api/billing/trial-status.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * BLOC UNIQUE D'ABONNEMENT
 *
 * « Mon compte » affichait deux blocs redondants : celui-ci et « Abonnement »
 * (InformationsTab). « Abonnement » est supprimé ; ce qu'il avait en propre
 * est repris ici :
 *   - « Changer d'offre » → /mon-compte/offres ;
 *   - 2e utilisateur — Offre Duo (panneau d'invitation, ou incitation) ;
 *   - Parrainage.
 * Les trois boutons « Mes factures », « Moyen de paiement » et « Résilier »
 * — qui ouvraient tous le même portail Stripe, ou une ancre inexistante
 * (`#resiliation`) — deviennent un seul bouton « Factures et moyens de
 * paiement ». La résiliation reste accessible dans ce portail.
 * ══════════════════════════════════════════════════════════════════════════
 */

interface QuotaUsage {
  used: number;
  limit: number;
  ratio: number;
  label: string;
  shouldWarn: boolean;
  isFull: boolean;
}

interface StatusResponse {
  trial: {
    status: 'none' | 'active' | 'expired' | 'converted';
    daysRemaining: number;
    endsAt: string | null;
    isUrgent: boolean;
  };
  plan: string;
  status: string;
  premiumFeatures: boolean;
  isRestricted: boolean;
  subscription: {
    planCode: string | null;
    billingPeriod: 'monthly' | 'yearly' | null;
    currentPeriodEndAt: string | null;
    cancelAtPeriodEnd: boolean;
    hasStripeSubscription: boolean;
    scheduledChange: {
      planCode: string;
      billingPeriod: 'monthly' | 'yearly';
      effectiveAt: string | null;
    } | null;
  };
  quotas: {
    assets: QuotaUsage;
    documents: QuotaUsage;
    users: { limit: number };
  };
}

const PLAN_LABELS: Record<string, string> = {
  trial: 'Essai Premium',
  standard: 'Standard',
  premium: 'Premium',
  premium_duo: 'Premium Duo',
  none: 'Aucune offre active',
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/** Barre de consommation d'un quota (CDC §9.4 : alerte a partir de 80 %). */
function QuotaBar({ label, quota }: { label: string; quota: QuotaUsage }) {
  const color = quota.isFull
    ? 'bg-red-500'
    : quota.shouldWarn
      ? 'bg-amber-500'
      : 'bg-[color:var(--accent)]';

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-sm text-[color:var(--text-muted)]">{label}</span>
        <span className="text-sm font-medium text-[color:var(--text-primary)]">{quota.label}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--bg-subtle)]">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(quota.ratio, 100)}%` }} />
      </div>
      {quota.shouldWarn && !quota.isFull && (
        <p className="mt-1 text-xs text-amber-600">Vous approchez de la limite de votre offre.</p>
      )}
    </div>
  );
}

export function SubscriptionSummary() {
  const router = useRouter();
  const { user } = useSession();
  const isDuoMember = user?.duoRole === 'MEMBER';
  const [data, setData] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [portalLoading, setPortalLoading] = useState(false);
  const [cancelLoading, setCancelLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/billing/trial-status', { credentials: 'include' });
        if (!res.ok) return;
        const json = (await res.json()) as StatusResponse;
        if (!cancelled) setData(json);
      } catch {
        // Silencieux : le reste de la page reste utilisable.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const cancelChange = async () => {
    setCancelLoading(true);
    try {
      const res = await fetch('/api/billing/schedule-change', {
      credentials: 'include',
        method: 'DELETE',
      });
      if (res.ok) {
        toast.success('Changement programmé annulé.');
        setData((d) =>
          d ? { ...d, subscription: { ...d.subscription, scheduledChange: null } } : d,
        );
      } else {
        toast.error('Impossible d\'annuler le changement.');
      }
    } catch {
      toast.error('Une erreur est survenue.');
    } finally {
      setCancelLoading(false);
    }
  };

  const openPortal = async () => {
    setPortalLoading(true);
    try {
      const res = await apiClient.post<{ portal_url?: string; message?: string }>(
        '/api/billing/create-customer-portal-session',
        {},
      );
      if (res.portal_url) window.location.href = res.portal_url;
      else toast.error(res.message || 'Portail indisponible pour le moment.');
    } catch {
      toast.error('Impossible d\'ouvrir le portail de facturation.');
    } finally {
      setPortalLoading(false);
    }
  };

  if (loading) return null;

  // Actions : toujours proposées, y compris quand l'état de l'abonnement n'a
  // pas pu être chargé — ce bloc est désormais le SEUL accès à la gestion de
  // l'offre et des factures (l'ancien bloc « Abonnement » a été retiré).
  const actions = isDuoMember ? (
    <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-950/30 px-3 py-2.5 text-sm text-[color:var(--text-warning-soft)]">
      <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-400" />
      <p>Seul le titulaire de l&apos;abonnement peut modifier l&apos;offre et gérer le paiement.</p>
    </div>
  ) : (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" onClick={() => router.push('/mon-compte/offres')}>
        <Crown className="mr-1.5 h-4 w-4" />
        Changer d&apos;offre
      </Button>
      {/* Données absentes : on ne sait pas s'il existe un abonnement Stripe,
          le portail répondra lui-même (message d'erreur explicite sinon). */}
      {(!data || data.subscription.hasStripeSubscription) && (
        <Button variant="outline" size="sm" onClick={openPortal} disabled={portalLoading}>
          <CreditCard className="mr-1.5 h-4 w-4" />
          Factures et moyens de paiement
        </Button>
      )}
    </div>
  );

  if (!data) {
    return (
      <div className="mb-6 rounded-xl border border-[color:var(--border)] bg-[color:var(--bg-subtle)] p-5">
        <h2 className="mb-2 text-base font-semibold text-[color:var(--text-primary)]">Mon abonnement</h2>
        <p className="mb-4 text-sm text-[color:var(--text-muted)]">
          Le détail de votre abonnement est momentanément indisponible.
        </p>
        {actions}
      </div>
    );
  }

  const { trial, subscription, quotas } = data;
  const planLabel = PLAN_LABELS[data.plan] ?? data.plan;
  const periodLabel =
    subscription.billingPeriod === 'monthly'
      ? 'Mensuelle'
      : subscription.billingPeriod === 'yearly'
        ? 'Annuelle'
        : '—';

  return (
    <div className="mb-6 rounded-xl border border-[color:var(--border)] bg-[color:var(--bg-subtle)] p-5">
      <h2 className="mb-4 text-base font-semibold text-[color:var(--text-primary)]">Mon abonnement</h2>

      {/* Etat du compte */}
      <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-[color:var(--text-muted)]">Offre</p>
          <p className="text-sm font-medium text-[color:var(--text-primary)]">{planLabel}</p>
        </div>

        <div>
          <p className="text-xs uppercase tracking-wide text-[color:var(--text-muted)]">Périodicité</p>
          <p className="text-sm font-medium text-[color:var(--text-primary)]">{periodLabel}</p>
        </div>

        <div>
          <p className="text-xs uppercase tracking-wide text-[color:var(--text-muted)]">
            {trial.status === 'active' ? 'Fin de l\'essai' : 'Prochaine échéance'}
          </p>
          <p className="text-sm font-medium text-[color:var(--text-primary)]">
            {trial.status === 'active'
              ? formatDate(trial.endsAt)
              : formatDate(subscription.currentPeriodEndAt)}
          </p>
        </div>

        <div>
          <p className="text-xs uppercase tracking-wide text-[color:var(--text-muted)]">Reconduction</p>
          <p className="text-sm font-medium text-[color:var(--text-primary)]">
            {!subscription.hasStripeSubscription
              ? '—'
              : subscription.cancelAtPeriodEnd
                ? 'Résiliation programmée'
                : 'Automatique'}
          </p>
        </div>
      </div>

      {/* Essai en cours */}
      {trial.status === 'active' && (
        <div className="mb-5 flex items-center gap-2 rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-page)] px-3 py-2">
          <Clock className="h-4 w-4 shrink-0 text-[color:var(--text-muted)]" />
          <p className="text-sm text-[color:var(--text-primary)]">
            {libelleEssai(trial.daysRemaining)}.
            {' '}Aucune carte bancaire n&apos;est enregistrée.
          </p>
        </div>
      )}

      {/* Essai expiré */}
      {data.isRestricted && (
        <div className="mb-5 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <p className="text-sm text-[color:var(--text-primary)]">
            Votre essai est terminé et aucun prélèvement n&apos;a été effectué. Vos données sont
            conservées : choisissez une offre pour reprendre l&apos;ajout et la modification.
          </p>
        </div>
      )}

      {/* Changement programmé (CDC §9.1 / §10.3) */}
      {subscription.scheduledChange && (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-page)] px-3 py-2">
          <p className="flex-1 text-sm text-[color:var(--text-primary)]">
            Changement programmé : passage à{' '}
            <span className="font-medium">
              {PLAN_LABELS[subscription.scheduledChange.planCode] ?? subscription.scheduledChange.planCode}
            </span>{' '}
            en facturation{' '}
            {subscription.scheduledChange.billingPeriod === 'monthly' ? 'mensuelle' : 'annuelle'}
            {subscription.scheduledChange.effectiveAt
              ? ` le ${formatDate(subscription.scheduledChange.effectiveAt)}`
              : ' à la prochaine échéance'}
            .
          </p>
          <Button variant="ghost" size="sm" onClick={cancelChange} disabled={cancelLoading}>
            Annuler
          </Button>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════
          PAS D'OFFRE ⇒ PAS DE QUOTA À MONTRER

          Un compte restreint n'a aucun quota : `entitlements` renvoie 0. La
          barre affichait alors « 0 sur 0 » remplie en rouge, et « 2 sur 0 »
          dès qu'une ligne traînait — un plein sur une capacité nulle, qui se
          lit comme un dépassement alors qu'il n'y a rien à dépasser.

          Le bandeau au-dessus dit déjà l'essentiel : l'essai est terminé,
          les données sont conservées. Les jauges n'ajoutent rien.
          ══════════════════════════════════════════════════════════════ */}
      {(quotas.assets.limit > 0 || quotas.documents.limit > 0) && (
        <div className="mb-5 grid gap-4 sm:grid-cols-2">
          {quotas.assets.limit > 0 && <QuotaBar label="Biens" quota={quotas.assets} />}
          {quotas.documents.limit > 0 && <QuotaBar label="Documents" quota={quotas.documents} />}
        </div>
      )}

      {/* Actions */}
      {actions}

      {/* 2e utilisateur — Offre Duo (repris de l'ancien bloc « Abonnement ») */}
      {!isDuoMember && data.plan === 'premium_duo' && user?.duoRole === 'BILLING_OWNER' && (
        <div className="mt-5 border-t border-[color:var(--border)] pt-4">
          <div className="mb-3 flex items-center gap-2">
            <Users className="h-4 w-4 text-emerald-400" />
            <span className="text-sm font-medium text-[color:var(--text-primary)]">2e utilisateur Duo</span>
          </div>
          <DuoInvitationPanel />
        </div>
      )}
      {!isDuoMember && data.plan !== 'premium_duo' && (
        <div className="mt-5 border-t border-[color:var(--border)] pt-4">
          <div className="flex flex-col gap-3 rounded-lg border border-dashed border-emerald-500/30 bg-emerald-500/5 px-3 py-3 sm:flex-row sm:items-start">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <Lock className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-400/60" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-[color:var(--text-primary)]">2e utilisateur — Offre Duo</p>
                <p className="mt-0.5 text-xs text-[color:var(--text-muted)]">Partagez votre espace avec une 2e personne.</p>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="w-full gap-1 rounded-full border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 sm:w-auto sm:shrink-0"
              onClick={() => router.push('/mon-compte/offres')}
            >
              <Users className="h-3.5 w-3.5" />Passer au Duo
            </Button>
          </div>
        </div>
      )}

      {/* Parrainage (repris de l'ancien bloc « Abonnement ») */}
      {!isDuoMember && (
        <div className="mt-5 border-t border-[color:var(--border)] pt-4">
          <ReferralBlock />
        </div>
      )}
    </div>
  );
}
