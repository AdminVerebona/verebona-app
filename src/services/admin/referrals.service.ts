/**
 * Parrainages & promotions — CDC Back-Office V1 §8 (REF-001 à REF-009,
 * PRO-001 à PRO-003).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX MÉCANISMES, JAMAIS ADDITIONNÉS
 *
 * Le parrainage Verebona (`referral_links`, `referral_events`) et les
 * promotions Stripe (`promo_codes`, usages lus dans `signup_contexts`) sont
 * présentés séparément ; aucun total ne mélange les deux (§8).
 *
 * « Conversion payante » : le compte filleul (ou le compte ayant utilisé le
 * code promo) a été facturé au moins une fois (`first_billed_at`).
 *
 * Aucune mutation : ni attribution, ni annulation, ni correction d'un
 * avantage (REF-009) ; ni création ni modification de code promo (PRO-001).
 * Pas de CA ni de taux de conversion par code (REF-001), pas de recherche
 * (REF-003), pas de paramètres Stripe détaillés (PRO-003).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { stripeDashboardUrl } from '@/lib/stripe-links';
import { REFERRAL_REWARD_MONTHS, withdrawalDeadline } from '@/services/referral-reward.service';
import type { Page } from './subscriptions.service';

export type ListSortDirection = 'asc' | 'desc';
export const CODE_SORTS = ['uses', 'conversions'] as const;
export type CodeSort = typeof CODE_SORTS[number];

export function parseCodeSort(value: string | null): CodeSort {
  return value === 'conversions' ? 'conversions' : 'uses';
}

// ── Synthèse (§8.1) ─────────────────────────────────────────────────────────

export interface ReferralPromotionSummary {
  referral: { activeCodes: number; totalUses: number; paidConversions: number };
  promotions: { totalUses: number; paidConversions: number };
}

/** Rapprochement signup_contexts ↔ promo_codes (code résolu ou identifiant Stripe). */
const PROMO_USAGE_JOIN = `
  (sc.resolved_code_type = 'promo_code' AND sc.resolved_code_id = pc.id)
  OR (pc.stripe_promotion_code_id IS NOT NULL AND sc.stripe_promotion_code_id = pc.stripe_promotion_code_id)`;

export async function getReferralPromotionSummary(): Promise<ReferralPromotionSummary> {
  const [ref] = await pgClient.unsafe<{ active_codes: number; total_uses: number; paid_conversions: number }[]>(
    `SELECT
        (SELECT count(*)::int FROM referral_links WHERE is_active) AS active_codes,
        (SELECT count(*)::int FROM referral_events) AS total_uses,
        (SELECT count(*)::int FROM referral_events re
           LEFT JOIN account_subscriptions s ON s.account_id = re.referred_account_id
          WHERE coalesce(re.first_billed_at, s.first_billed_at) IS NOT NULL) AS paid_conversions`,
  );
  const [promo] = await pgClient.unsafe<{ total_uses: number; paid_conversions: number }[]>(
    `SELECT count(DISTINCT sc.account_id)::int AS total_uses,
            count(DISTINCT sc.account_id) FILTER (WHERE s.first_billed_at IS NOT NULL)::int AS paid_conversions
       FROM promo_codes pc
       JOIN signup_contexts sc ON ${PROMO_USAGE_JOIN}
       LEFT JOIN account_subscriptions s ON s.account_id = sc.account_id
      WHERE sc.account_id IS NOT NULL`,
  );
  return {
    referral: {
      activeCodes: Number(ref?.active_codes ?? 0),
      totalUses: Number(ref?.total_uses ?? 0),
      paidConversions: Number(ref?.paid_conversions ?? 0),
    },
    promotions: {
      totalUses: Number(promo?.total_uses ?? 0),
      paidConversions: Number(promo?.paid_conversions ?? 0),
    },
  };
}

// ── Parrainage : codes / comptes parrains (REF-002, REF-004, REF-005) ──────

export interface ReferrerItem {
  linkId: number;
  code: string;
  isActive: boolean;
  accountId: number;
  accountName: string;
  uses: number;
  paidConversions: number;
  inProgress: number;
  validated: number;
  rewardsGranted: number;
  rewardsCanceled: number;
}

export async function listReferrers(sort: CodeSort, dir: ListSortDirection, page: number, pageSize: number): Promise<Page<ReferrerItem>> {
  const [{ total }] = await pgClient.unsafe<{ total: number }[]>(`SELECT count(*)::int AS total FROM referral_links`);
  const totalPages = Math.max(1, Math.ceil(Number(total) / pageSize));
  const current = Math.min(Math.max(1, page), totalPages);
  // Colonne et sens issus de listes fermées : pas d'injection possible.
  const orderColumn = sort === 'conversions' ? 'paid_conversions' : 'uses';
  const orderDir = dir === 'asc' ? 'ASC' : 'DESC';
  const rows = await pgClient.unsafe<Array<Record<string, unknown>>>(
    `SELECT rl.id AS link_id, rl.code, rl.is_active, rl.account_id, a.name AS account_name,
            count(re.id)::int AS uses,
            count(re.id) FILTER (WHERE coalesce(re.first_billed_at, s.first_billed_at) IS NOT NULL)::int AS paid_conversions,
            count(re.id) FILTER (WHERE re.status = 'link_used')::int AS in_progress,
            count(re.id) FILTER (WHERE re.status = 'reward_granted')::int AS validated,
            count(re.id) FILTER (WHERE re.status = 'canceled')::int AS rewards_canceled
       FROM referral_links rl
       JOIN accounts a ON a.id = rl.account_id
       LEFT JOIN referral_events re ON re.referral_link_id = rl.id
       LEFT JOIN account_subscriptions s ON s.account_id = re.referred_account_id
      GROUP BY rl.id, a.name
      ORDER BY ${orderColumn} ${orderDir}, rl.id ASC
      LIMIT $1 OFFSET $2`,
    [pageSize, (current - 1) * pageSize],
  );
  const items = rows.map((r) => ({
    linkId: Number(r.link_id),
    code: String(r.code),
    isActive: Boolean(r.is_active),
    accountId: Number(r.account_id),
    accountName: String(r.account_name ?? ''),
    uses: Number(r.uses),
    paidConversions: Number(r.paid_conversions),
    inProgress: Number(r.in_progress),
    validated: Number(r.validated),
    // Un avantage accordé par filleul validé (un mois offert, CDC tarification §13).
    rewardsGranted: Number(r.validated),
    rewardsCanceled: Number(r.rewards_canceled),
  }));
  return { items, page: current, pageSize, total: Number(total), totalPages };
}

// ── Parrainage : détail (REF-006 à REF-008) ─────────────────────────────────

export type ReferralEventStatus = 'in_progress' | 'validated' | 'canceled';

export const REFERRAL_STATUS_LABELS: Record<ReferralEventStatus, string> = {
  in_progress: 'En cours',
  validated: 'Validé — avantage accordé',
  canceled: 'Avantage annulé',
};

export interface ReferralEventSource {
  id: number;
  referredAccountId: number;
  referredAccountName: string | null;
  status: string;
  usedAt: Date;
  firstBilledAt: Date | null;
  rewardAppliedAt: Date | null;
  rewardedAt: Date | null;
  rewardGrantedAt: Date | null;
  updatedAt: Date | null;
  metadata: Record<string, unknown> | null;
}

export interface ReferralEventView {
  id: number;
  referredAccountId: number;
  referredAccountName: string | null;
  status: ReferralEventStatus;
  statusLabel: string;
  usedAt: string;
  /** REF-007 : date prévisionnelle d'attribution (parrainage en cours). */
  forecastRewardAt: string | null;
  /** Date réelle d'attribution. */
  rewardedAt: string | null;
  reward: string | null;
  canceledAt: string | null;
}

export function toReferralStatus(status: string): ReferralEventStatus {
  if (status === 'reward_granted') return 'validated';
  if (status === 'canceled') return 'canceled';
  return 'in_progress';
}

/**
 * Vue d'un parrainage. Date prévisionnelle : fin du délai de rétractation du
 * filleul après son premier paiement (CDC tarification §13) ; inconnue tant
 * que le filleul n'a pas été facturé.
 */
export function describeReferralEvent(e: ReferralEventSource): ReferralEventView {
  const status = toReferralStatus(e.status);
  const rewardedAt = e.rewardAppliedAt ?? e.rewardedAt ?? e.rewardGrantedAt;
  const ineligibility = (e.metadata?.rewardIneligibility as { at?: string } | undefined)?.at;
  return {
    id: e.id,
    referredAccountId: e.referredAccountId,
    referredAccountName: e.referredAccountName,
    status,
    statusLabel: REFERRAL_STATUS_LABELS[status],
    usedAt: e.usedAt.toISOString(),
    forecastRewardAt: status === 'in_progress' && e.firstBilledAt ? withdrawalDeadline(e.firstBilledAt).toISOString() : null,
    rewardedAt: status === 'validated' && rewardedAt ? rewardedAt.toISOString() : null,
    reward: status === 'validated'
      ? `${REFERRAL_REWARD_MONTHS} mois offert${REFERRAL_REWARD_MONTHS > 1 ? 's' : ''} au parrain`
      : null,
    canceledAt: status === 'canceled'
      ? (ineligibility ? new Date(ineligibility).toISOString() : e.updatedAt?.toISOString() ?? null)
      : null,
  };
}

export interface ReferrerDetail {
  linkId: number;
  code: string;
  isActive: boolean;
  accountId: number;
  accountName: string;
  events: ReferralEventView[];
}

export async function getReferrerDetail(linkId: number): Promise<ReferrerDetail | null> {
  const [link] = await pgClient.unsafe<Array<Record<string, unknown>>>(
    `SELECT rl.id, rl.code, rl.is_active, rl.account_id, a.name AS account_name
       FROM referral_links rl JOIN accounts a ON a.id = rl.account_id
      WHERE rl.id = $1`,
    [linkId],
  );
  if (!link) return null;
  const rows = await pgClient.unsafe<Array<Record<string, unknown>>>(
    `SELECT re.id, re.referred_account_id, a.name AS referred_account_name, re.status,
            coalesce(re.captured_at, re.created_at) AS used_at,
            coalesce(re.first_billed_at, s.first_billed_at) AS first_billed_at,
            re.reward_applied_at, re.rewarded_at, re.reward_granted_at, re.updated_at, re.metadata_json
       FROM referral_events re
       LEFT JOIN accounts a ON a.id = re.referred_account_id
       LEFT JOIN account_subscriptions s ON s.account_id = re.referred_account_id
      WHERE re.referral_link_id = $1
      ORDER BY coalesce(re.captured_at, re.created_at) DESC`,
    [linkId],
  );
  const d = (v: unknown) => (v ? new Date(v as string) : null);
  return {
    linkId: Number(link.id),
    code: String(link.code),
    isActive: Boolean(link.is_active),
    accountId: Number(link.account_id),
    accountName: String(link.account_name ?? ''),
    events: rows.map((r) => describeReferralEvent({
      id: Number(r.id),
      referredAccountId: Number(r.referred_account_id),
      referredAccountName: (r.referred_account_name as string | null) ?? null,
      status: String(r.status),
      usedAt: new Date(r.used_at as string),
      firstBilledAt: d(r.first_billed_at),
      rewardAppliedAt: d(r.reward_applied_at),
      rewardedAt: d(r.rewarded_at),
      rewardGrantedAt: d(r.reward_granted_at),
      updatedAt: d(r.updated_at),
      metadata: (r.metadata_json as Record<string, unknown> | null) ?? null,
    })),
  };
}

// ── Promotions Stripe (PRO-002, PRO-003) ────────────────────────────────────

export interface PromotionItem {
  id: number;
  code: string;
  uses: number;
  paidConversions: number;
  stripeUrl: string | null;
}

export async function listPromotions(sort: CodeSort, dir: ListSortDirection, page: number, pageSize: number): Promise<Page<PromotionItem>> {
  const [{ total }] = await pgClient.unsafe<{ total: number }[]>(`SELECT count(*)::int AS total FROM promo_codes`);
  const totalPages = Math.max(1, Math.ceil(Number(total) / pageSize));
  const current = Math.min(Math.max(1, page), totalPages);
  const orderColumn = sort === 'conversions' ? 'paid_conversions' : 'uses';
  const orderDir = dir === 'asc' ? 'ASC' : 'DESC';
  const rows = await pgClient.unsafe<Array<Record<string, unknown>>>(
    `SELECT pc.id, pc.code, pc.stripe_promotion_code_id,
            count(DISTINCT sc.account_id)::int AS uses,
            count(DISTINCT sc.account_id) FILTER (WHERE s.first_billed_at IS NOT NULL)::int AS paid_conversions
       FROM promo_codes pc
       LEFT JOIN signup_contexts sc ON (${PROMO_USAGE_JOIN}) AND sc.account_id IS NOT NULL
       LEFT JOIN account_subscriptions s ON s.account_id = sc.account_id
      GROUP BY pc.id
      ORDER BY ${orderColumn} ${orderDir}, pc.id ASC
      LIMIT $1 OFFSET $2`,
    [pageSize, (current - 1) * pageSize],
  );
  const items = rows.map((r) => ({
    id: Number(r.id),
    code: String(r.code),
    uses: Number(r.uses),
    paidConversions: Number(r.paid_conversions),
    stripeUrl: stripeDashboardUrl('promotion_codes', r.stripe_promotion_code_id as string | null),
  }));
  return { items, page: current, pageSize, total: Number(total), totalPages };
}

export interface PromotionAccount {
  accountId: number;
  accountName: string;
  usedAt: string;
  paid: boolean;
}

/** Comptes concernés par un code promotionnel (PRO-002). */
export async function getPromotionAccounts(promoId: number): Promise<{ code: string; stripeUrl: string | null; accounts: PromotionAccount[] } | null> {
  const [promo] = await pgClient.unsafe<Array<Record<string, unknown>>>(
    `SELECT id, code, stripe_promotion_code_id FROM promo_codes WHERE id = $1`,
    [promoId],
  );
  if (!promo) return null;
  const rows = await pgClient.unsafe<Array<Record<string, unknown>>>(
    `SELECT DISTINCT ON (sc.account_id) sc.account_id, a.name AS account_name, sc.created_at,
            (s.first_billed_at IS NOT NULL) AS paid
       FROM promo_codes pc
       JOIN signup_contexts sc ON ${PROMO_USAGE_JOIN}
       JOIN accounts a ON a.id = sc.account_id
       LEFT JOIN account_subscriptions s ON s.account_id = sc.account_id
      WHERE pc.id = $1
      ORDER BY sc.account_id, sc.created_at ASC`,
    [promoId],
  );
  return {
    code: String(promo.code),
    stripeUrl: stripeDashboardUrl('promotion_codes', promo.stripe_promotion_code_id as string | null),
    accounts: rows
      .map((r) => ({
        accountId: Number(r.account_id),
        accountName: String(r.account_name ?? ''),
        usedAt: new Date(r.created_at as string).toISOString(),
        paid: Boolean(r.paid),
      }))
      .sort((a, b) => b.usedAt.localeCompare(a.usedAt)),
  };
}
