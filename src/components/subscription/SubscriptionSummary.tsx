'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CreditCard, AlertTriangle, Clock, Crown, Lock, ShieldAlert, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { toast } from 'sonner';
import { useSession } from '@/hooks/useSession';
import { useEntitlements } from '@/hooks/useEntitlements';
import { apiClient, ApiClientError, isRequestAborted } from '@/lib/api-client';
import { buildStorageQuotaUsage, type StorageQuotaUsage } from '@/lib/storage-display';
import { DuoInvitationPanel } from './DuoInvitationPanel';
import { DuoLeaveButton } from './DuoLeaveButton';
import { libelleEssai } from './trial-label';
import { openBillingPortal } from '@/lib/billing/open-billing-portal';
import { isUnpaid, type UnpaidCyclePayload } from '@/lib/trial-status';
import { UnpaidPaymentNotice } from './UnpaidPaymentNotice';
import { formatEuroCents } from '@/lib/billing/plan-catalog';

/**
 * Ecran « Mon abonnement » (CDC tarification §9.1 et §9.4).
 *
 * Affiche l'etat reel du compte tel que calcule par le serveur : offre et
 * periodicite actives, prochaine echeance, reconduction, consommation des
 * quotas, acces aux factures et resiliation.
 *
 * Aucune donnee n'est deduite cote client : tout provient de
 * /api/billing/trial-status, lu par l'`EntitlementsProvider` (lot 24).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * BLOC UNIQUE D'ABONNEMENT
 *
 * « Mon compte » affichait deux blocs redondants : celui-ci et « Abonnement »
 * (InformationsTab). « Abonnement » est supprimé ; ce qu'il avait en propre
 * est repris ici :
 *   - « Changer d'offre » → /mon-compte/offres ;
 *   - 2e utilisateur — Offre Duo (panneau d'invitation, ou incitation).
 *
 * Lot 26 : l'espace de stockage devient une ligne de quota sous « Documents »
 * (même barre, « X sur Y », 1 / 5 / 10 Go selon l'offre) — l'ancienne carte
 * « Espace de stockage » est supprimée ; le parrainage a sa propre carte
 * (`ReferralCard`), hors de ce bloc.
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
  canWrite?: boolean;
  /** Cycle d'impayé en cours (paiement échoué), `null` sinon. */
  unpaid?: UnpaidCyclePayload | null;
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
      /** Prix accepté à la programmation (CDC lookup_key LK-36). */
      unitAmountCents?: number | null;
      /** `release_failed` : annulation non confirmée par Stripe (LK-59). */
      state?: string | null;
    } | null;
    /** Montant facturé pour la période en cours (prix contractuel, LK-113). */
    currentPrice?: { unitAmountCents: number; currency: string } | null;
    /** Nouveau montant au prochain renouvellement, s'il est confirmé (LK-113). */
    nextRenewalPrice?: { unitAmountCents: number; effectiveAt: string | null } | null;
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
function QuotaBar({ label, quota, fullHint }: { label: string; quota: QuotaUsage | StorageQuotaUsage; fullHint?: string }) {
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
      {quota.isFull && fullHint && <p className="mt-1 text-xs text-red-500">{fullHint}</p>}
    </div>
  );
}

/** Ligne unique du tiroir fermé. */
const RESUME = 'Votre offre, vos quotas et vos factures.';

/** Plein : seuls les nouveaux dépôts sont bloqués (CDC BO STO-003). */
const STOCKAGE_PLEIN =
  'Espace plein : les nouveaux dépôts sont bloqués. Vos documents restent consultables, exportables et supprimables.';

/**
 * Espace de stockage du compte (`/api/account/storage`, même calcul que le
 * contrôle de dépôt). Lu ici seulement — pas dans `/api/billing/trial-status`,
 * appelé sur chaque page : la somme des fichiers n'a rien à y faire. Échec :
 * la ligne n'est pas affichée (jamais une valeur inventée).
 */
function useStorageQuota(): StorageQuotaUsage | null {
  const [quota, setQuota] = useState<StorageQuotaUsage | null>(null);
  useEffect(() => {
    let annule = false;
    fetch('/api/account/storage', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { usedBytes?: number; limitBytes?: number } | null) => {
        if (annule || !d || typeof d.usedBytes !== 'number' || typeof d.limitBytes !== 'number') return;
        setQuota(buildStorageQuotaUsage(d.usedBytes, d.limitBytes));
      })
      .catch(() => {});
    return () => { annule = true; };
  }, []);
  return quota;
}

export function SubscriptionSummary() {
  const router = useRouter();
  const { user } = useSession();
  const isDuoMember = user?.duoRole === 'MEMBER';
  // État du compte : celui de l'`EntitlementsProvider` (une lecture de
  // `/api/billing/trial-status` partagée par la garde, le layout et cette
  // page — APP-PERF-12), plus de lecture propre au montage. La réponse porte
  // aussi le bloc `subscription` affiché ici.
  const { entitlements, isLoading, refresh } = useEntitlements();
  const servi = entitlements && 'subscription' in entitlements ? (entitlements as unknown as StatusResponse) : null;
  // Annulation d'un changement programmé : affichée tout de suite, en
  // attendant la relecture des droits.
  const [changementAnnule, setChangementAnnule] = useState(false);
  const data: StatusResponse | null = servi && changementAnnule
    ? { ...servi, subscription: { ...servi.subscription, scheduledChange: null } }
    : servi;
  const loading = isLoading && !servi;
  const [portalLoading, setPortalLoading] = useState(false);
  const storage = useStorageQuota();
  const [cancelLoading, setCancelLoading] = useState(false);

  useEffect(() => {
    // Relecture servie : l'état serveur fait foi de nouveau.
    setChangementAnnule(false);
  }, [entitlements]);

  const cancelChange = async () => {
    setCancelLoading(true);
    try {
      await apiClient.delete('/api/billing/schedule-change');
      toast.success('Changement programmé annulé.');
      setChangementAnnule(true);
      void refresh();
    } catch (err) {
      if (isRequestAborted(err)) return;
      // LK-59 : en cas d'échec, le changement reste programmé et c'est dit.
      toast.error(err instanceof ApiClientError && err.status > 0
        ? (err.serverMessage || 'Impossible d\'annuler le changement.')
        : 'Une erreur est survenue.');
    } finally {
      setCancelLoading(false);
    }
  };

  /**
   * Portail Stripe (factures, moyens de paiement) : dans un NOUVEL onglet,
   * pour ne pas quitter Verebona. Séquence partagée : `openBillingPortal`.
   */
  const openPortal = async () => {
    setPortalLoading(true);
    try {
      await openBillingPortal();
    } finally {
      setPortalLoading(false);
    }
  };

  if (loading) return null;

  // Actions : toujours proposées, y compris quand l'état de l'abonnement n'a
  // pas pu être chargé — ce bloc est désormais le SEUL accès à la gestion de
  // l'offre et des factures (l'ancien bloc « Abonnement » a été retiré).
  const actions = isDuoMember ? (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-950/30 px-3 py-2.5 text-sm text-[color:var(--text-warning-soft)]">
        <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-400" />
        <p>Seul le titulaire de l&apos;abonnement peut modifier l&apos;offre et gérer le paiement.</p>
      </div>
      {/* Départ volontaire du second utilisateur (AID-DUO-006). */}
      <DuoLeaveButton />
    </div>
  ) : (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" onClick={() => router.push('/mon-compte/offres')}>
        <Crown className="mr-1.5 h-4 w-4" />
        Changer d&apos;offre
      </Button>
      {/* Données absentes : on ne sait pas s'il existe un abonnement Stripe,
          le portail répondra lui-même (message d'erreur explicite sinon). */}
      {(!data || data.subscription.hasStripeSubscription || isUnpaid(data)) && (
        <Button variant="outline" size="sm" onClick={openPortal} disabled={portalLoading}>
          <CreditCard className="mr-1.5 h-4 w-4" />
          Factures et moyens de paiement
        </Button>
      )}
    </div>
  );

  if (!data) {
    return (
      <CollapsibleCard icon={<CreditCard className="w-5 h-5" />} title="Mon abonnement" description={RESUME}>
        <p className="mb-4 text-sm text-[color:var(--text-muted)]">
          Le détail de votre abonnement est momentanément indisponible.
        </p>
        {actions}
      </CollapsibleCard>
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
    // Tiroir fermé par défaut, sur le modèle « Informations légales » —
    // sauf impayé ou compte restreint : l'alerte ne doit pas rester cachée.
    <CollapsibleCard
      icon={<CreditCard className="w-5 h-5" />}
      title="Mon abonnement"
      description={isUnpaid(data) ? 'Paiement en échec : une action est requise.' : RESUME}
      defaultOpen={isUnpaid(data) || Boolean(data.isRestricted)}
    >

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

      {/* Tarif de la période en cours et, si confirmé, du prochain
          renouvellement — distincts du prix des nouvelles souscriptions
          (CDC lookup_key LK-36, LK-113). Factures passées inchangées. */}
      {subscription.currentPrice && (
        <div className="mb-5 grid gap-4 sm:grid-cols-2" data-testid="tarif-contractuel">
          <div>
            <p className="text-xs uppercase tracking-wide text-[color:var(--text-muted)]">Tarif de la période en cours</p>
            <p className="text-sm font-medium text-[color:var(--text-primary)]">
              {formatEuroCents(subscription.currentPrice.unitAmountCents)}
              {subscription.billingPeriod === 'yearly' ? ' par an' : subscription.billingPeriod === 'monthly' ? ' par mois' : ''}
            </p>
          </div>
          {subscription.nextRenewalPrice && (
            <div>
              <p className="text-xs uppercase tracking-wide text-[color:var(--text-muted)]">Au prochain renouvellement</p>
              <p className="text-sm font-medium text-[color:var(--text-primary)]">
                {formatEuroCents(subscription.nextRenewalPrice.unitAmountCents)}
                {subscription.billingPeriod === 'yearly' ? ' par an' : subscription.billingPeriod === 'monthly' ? ' par mois' : ''}
                {subscription.nextRenewalPrice.effectiveAt ? ` à partir du ${formatDate(subscription.nextRenewalPrice.effectiveAt)}` : ''}
              </p>
            </div>
          )}
        </div>
      )}

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

      {/* Impayé : paiement échoué, date limite, ce qui reste possible et
          mise à jour du moyen de paiement. Ce n'est PAS une fin d'essai. */}
      {isUnpaid(data) && <UnpaidPaymentNotice unpaid={data.unpaid} />}

      {/* Essai expiré (ou restriction sans impayé) */}
      {data.isRestricted && !isUnpaid(data) && (
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
            {typeof subscription.scheduledChange.unitAmountCents === 'number'
              ? ` (${formatEuroCents(subscription.scheduledChange.unitAmountCents)} ${subscription.scheduledChange.billingPeriod === 'monthly' ? 'par mois' : 'par an'})`
              : ''}
            .
            {subscription.scheduledChange.state === 'release_failed' && (
              <span className="mt-1 block text-xs text-amber-600">
                La dernière demande d&apos;annulation n&apos;a pas pu être confirmée : ce changement reste programmé.
              </span>
            )}
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
          {/* Lot 26 : sous « Documents », même barre (1 / 5 / 10 Go). */}
          {storage && storage.limit > 0 && (
            <QuotaBar label="Espace de stockage" quota={storage} fullHint={STOCKAGE_PLEIN} />
          )}
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

      {/* Parrainage : carte dédiée (`ReferralCard`), lot 26. */}
    </CollapsibleCard>
  );
}
