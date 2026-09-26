/**
 * Abonnements & paiements — CDC Back-Office V1 §7 (SUB-001 à SUB-015).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * VUE DE DIAGNOSTIC, SANS MUTATION
 *
 * Stripe reste le système de gestion des opérations financières. Cet écran ne
 * fait que lire `account_subscriptions` (synchronisé par webhooks), `accounts`
 * et `invoices`, et propose « Ouvrir dans Stripe » (SUB-011). Aucune
 * résiliation, suspension, remboursement ni prolongation d'essai (§7.4) ; le
 * changement exceptionnel d'offre se fait depuis la fiche Compte (SUB-014).
 *
 * Ni MRR (SUB-002), ni montant du prochain renouvellement (SUB-004), ni moyen
 * de paiement (SUB-005), ni identifiant Stripe (SUB-012), ni facture (SUB-013).
 *
 * La dérivation des statuts est PURE et testée ; tri et pagination se font sur
 * la vue dérivée, pour que le tri « statut de paiement » (SUB-007) porte sur
 * exactement ce qui est affiché.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { stripeDashboardUrl } from '@/lib/stripe-links';
import { planAtDate } from '@/lib/admin/plan-at-date';

// ── Statuts ─────────────────────────────────────────────────────────────────

export type SubscriptionDisplayStatus =
  | 'trialing'
  | 'trial_expired'
  | 'active'
  | 'past_due'
  | 'readonly'
  | 'canceled';

export const SUBSCRIPTION_STATUS_LABELS: Record<SubscriptionDisplayStatus, string> = {
  trialing: 'Essai en cours',
  trial_expired: 'Essai terminé',
  active: 'Actif',
  past_due: 'Impayé',
  readonly: 'Lecture seule',
  canceled: 'Terminé',
};

export type PaymentStatus = 'failed' | 'up_to_date' | 'none';

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  failed: 'Paiement échoué',
  up_to_date: 'À jour',
  none: 'Aucun paiement',
};

/** Statuts du compte (webhooks) qui signalent un paiement en échec. */
export const FAILED_ACCOUNT_STATUSES = ['PAST_DUE', 'PAST_DUE_GRACE', 'UNPAID_RECOVERY'] as const;
/** Statuts de facture (Stripe) qui signalent un paiement en échec. */
export const FAILED_INVOICE_STATUSES = ['uncollectible', 'payment_failed', 'failed'] as const;

export interface SubscriptionSourceRow {
  accountId: number;
  accountName: string;
  ownerEmail: string | null;
  planCode: string;
  planLabel: string | null;
  /** `account_subscriptions.status` : trialing | active | past_due | readonly | canceled. */
  status: string;
  billingPeriod: string | null;
  cancelAtPeriodEnd: boolean;
  trialEndsAt: Date | null;
  currentPeriodEndAt: Date | null;
  firstBilledAt: Date | null;
  /** `accounts.subscription_status` (PAST_DUE_GRACE…). */
  accountSubscriptionStatus: string | null;
  /** Statut de la facture la plus récente du compte, si connue. */
  lastInvoiceStatus: string | null;
  stripeSubscriptionId: string | null;
}

/** Statut d'abonnement affiché (SUB-003). */
export function deriveSubscriptionStatus(row: SubscriptionSourceRow, now: Date = new Date()): SubscriptionDisplayStatus {
  switch (row.status) {
    case 'trialing':
      // Même règle que les droits (entitlements) : essai échu sans facturation.
      return !row.firstBilledAt && row.trialEndsAt && row.trialEndsAt.getTime() <= now.getTime()
        ? 'trial_expired'
        : 'trialing';
    case 'active':
      return 'active';
    case 'past_due':
      return 'past_due';
    case 'readonly':
      return 'readonly';
    default:
      return 'canceled';
  }
}

/**
 * Statut de paiement pertinent (SUB-003, SUB-010) : un échec est identifié
 * comme tel, sans motif technique.
 */
export function derivePaymentStatus(row: SubscriptionSourceRow): PaymentStatus {
  const accountStatus = (row.accountSubscriptionStatus ?? '').toUpperCase();
  const invoiceStatus = (row.lastInvoiceStatus ?? '').toLowerCase();
  if (
    row.status === 'past_due' ||
    (FAILED_ACCOUNT_STATUSES as readonly string[]).includes(accountStatus) ||
    (FAILED_INVOICE_STATUSES as readonly string[]).includes(invoiceStatus)
  ) {
    return 'failed';
  }
  if (invoiceStatus === 'paid' || row.firstBilledAt) return 'up_to_date';
  return 'none';
}

const LIVE_STATUSES: SubscriptionDisplayStatus[] = ['trialing', 'active', 'past_due'];

/** Prochain renouvellement, s'il n'y a pas de fin programmée. */
export function nextRenewalAt(row: SubscriptionSourceRow, now: Date = new Date()): Date | null {
  const status = deriveSubscriptionStatus(row, now);
  if (row.cancelAtPeriodEnd || !LIVE_STATUSES.includes(status)) return null;
  return status === 'trialing' ? row.trialEndsAt : row.currentPeriodEndAt;
}

/** Date de fin effective programmée (résiliation en fin de période). */
export function scheduledEndAt(row: SubscriptionSourceRow, now: Date = new Date()): Date | null {
  const status = deriveSubscriptionStatus(row, now);
  if (!row.cancelAtPeriodEnd || !LIVE_STATUSES.includes(status)) return null;
  return status === 'trialing' ? row.trialEndsAt ?? row.currentPeriodEndAt : row.currentPeriodEndAt ?? row.trialEndsAt;
}

// ── Synthèse (SUB-001) ──────────────────────────────────────────────────────

export interface SubscriptionSummary {
  active: number;
  trials: number;
  scheduledEnds: number;
  failedPayments: number;
}

export function buildSubscriptionSummary(rows: SubscriptionSourceRow[], now: Date = new Date()): SubscriptionSummary {
  const summary: SubscriptionSummary = { active: 0, trials: 0, scheduledEnds: 0, failedPayments: 0 };
  for (const row of rows) {
    const status = deriveSubscriptionStatus(row, now);
    if (status === 'active' || status === 'past_due') summary.active++;
    if (status === 'trialing') summary.trials++;
    if (scheduledEndAt(row, now)) summary.scheduledEnds++;
    if (derivePaymentStatus(row) === 'failed') summary.failedPayments++;
  }
  return summary;
}

// ── Liste (SUB-003, SUB-007, SUB-008) ───────────────────────────────────────

export interface SubscriptionListItem {
  accountId: number;
  accountName: string;
  ownerEmail: string | null;
  planCode: string;
  planLabel: string;
  status: SubscriptionDisplayStatus;
  statusLabel: string;
  billingPeriod: string | null;
  paymentStatus: PaymentStatus;
  paymentStatusLabel: string;
  nextRenewalAt: string | null;
  scheduledEndAt: string | null;
  /** SUB-011 / SUB-012 : lien seul, jamais l'identifiant. */
  stripeUrl: string | null;
}

export const SUBSCRIPTION_SORTS = ['plan', 'status', 'period', 'payment', 'renewal', 'end'] as const;
export type SubscriptionSort = typeof SUBSCRIPTION_SORTS[number];
export type SortDirection = 'asc' | 'desc';

export function parseSubscriptionSort(value: string | null): SubscriptionSort {
  return (SUBSCRIPTION_SORTS as readonly string[]).includes(value ?? '') ? (value as SubscriptionSort) : 'renewal';
}

export function toListItem(row: SubscriptionSourceRow, now: Date = new Date()): SubscriptionListItem {
  const status = deriveSubscriptionStatus(row, now);
  const paymentStatus = derivePaymentStatus(row);
  const renewal = nextRenewalAt(row, now);
  const end = scheduledEndAt(row, now);
  return {
    accountId: row.accountId,
    accountName: row.accountName,
    ownerEmail: row.ownerEmail,
    planCode: row.planCode,
    planLabel: row.planLabel ?? row.planCode,
    status,
    statusLabel: SUBSCRIPTION_STATUS_LABELS[status],
    billingPeriod: row.billingPeriod,
    paymentStatus,
    paymentStatusLabel: PAYMENT_STATUS_LABELS[paymentStatus],
    nextRenewalAt: renewal ? renewal.toISOString() : null,
    scheduledEndAt: end ? end.toISOString() : null,
    stripeUrl: stripeDashboardUrl('subscriptions', row.stripeSubscriptionId),
  };
}

/** Ordre de tri métier : ce qui demande de l'attention d'abord. */
const PAYMENT_RANK: Record<PaymentStatus, number> = { failed: 0, up_to_date: 1, none: 2 };
const STATUS_RANK: Record<SubscriptionDisplayStatus, number> = {
  past_due: 0, trialing: 1, active: 2, trial_expired: 3, readonly: 4, canceled: 5,
};

function sortValue(item: SubscriptionListItem, sort: SubscriptionSort): string | number | null {
  switch (sort) {
    case 'plan': return item.planLabel.toLowerCase();
    case 'status': return STATUS_RANK[item.status];
    case 'period': return item.billingPeriod;
    case 'payment': return PAYMENT_RANK[item.paymentStatus];
    case 'renewal': return item.nextRenewalAt ? Date.parse(item.nextRenewalAt) : null;
    case 'end': return item.scheduledEndAt ? Date.parse(item.scheduledEndAt) : null;
  }
}

/** Tri stable ; les valeurs absentes toujours en fin de liste. */
export function sortSubscriptions(
  items: SubscriptionListItem[],
  sort: SubscriptionSort,
  direction: SortDirection,
): SubscriptionListItem[] {
  const factor = direction === 'desc' ? -1 : 1;
  return items
    .map((item, index) => ({ item, index, value: sortValue(item, sort) }))
    .sort((a, b) => {
      if (a.value === null && b.value === null) return a.index - b.index;
      if (a.value === null) return 1;
      if (b.value === null) return -1;
      const cmp = typeof a.value === 'number' && typeof b.value === 'number'
        ? a.value - b.value
        : String(a.value).localeCompare(String(b.value), 'fr');
      return cmp !== 0 ? cmp * factor : a.item.accountName.localeCompare(b.item.accountName, 'fr') || a.index - b.index;
    })
    .map((x) => x.item);
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export function paginate<T>(items: T[], page: number, pageSize: number): Page<T> {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), totalPages);
  return {
    items: items.slice((current - 1) * pageSize, current * pageSize),
    page: current,
    pageSize,
    total,
    totalPages,
  };
}

// ── Lectures ────────────────────────────────────────────────────────────────

export async function loadSubscriptionRows(): Promise<SubscriptionSourceRow[]> {
  const rows = await pgClient.unsafe<Array<Record<string, unknown>>>(
    `SELECT s.account_id, a.name AS account_name, u.email AS owner_email,
            s.plan_code, p.label AS plan_label, s.status, s.billing_period,
            s.cancel_at_period_end, s.trial_ends_at, s.current_period_end_at,
            s.first_billed_at, a.subscription_status AS account_subscription_status,
            s.stripe_subscription_id,
            (SELECT i.status FROM invoices i
              WHERE i.account_id = s.account_id
              ORDER BY i.created_at DESC LIMIT 1) AS last_invoice_status
       FROM account_subscriptions s
       JOIN accounts a ON a.id = s.account_id
       LEFT JOIN users u ON u.id = a.owner_user_id
       LEFT JOIN subscription_plans p ON p.code = s.plan_code`,
  );
  const date = (v: unknown) => (v ? new Date(v as string) : null);
  return rows.map((r) => ({
    accountId: Number(r.account_id),
    accountName: String(r.account_name ?? ''),
    ownerEmail: (r.owner_email as string | null) ?? null,
    planCode: String(r.plan_code),
    planLabel: (r.plan_label as string | null) ?? null,
    status: String(r.status),
    billingPeriod: (r.billing_period as string | null) ?? null,
    cancelAtPeriodEnd: Boolean(r.cancel_at_period_end),
    trialEndsAt: date(r.trial_ends_at),
    currentPeriodEndAt: date(r.current_period_end_at),
    firstBilledAt: date(r.first_billed_at),
    accountSubscriptionStatus: (r.account_subscription_status as string | null) ?? null,
    lastInvoiceStatus: (r.last_invoice_status as string | null) ?? null,
    stripeSubscriptionId: (r.stripe_subscription_id as string | null) ?? null,
  }));
}

export async function getSubscriptionsOverview(params: {
  sort: SubscriptionSort;
  direction: SortDirection;
  page: number;
  pageSize: number;
  now?: Date;
}): Promise<{ summary: SubscriptionSummary; list: Page<SubscriptionListItem> }> {
  const now = params.now ?? new Date();
  const rows = await loadSubscriptionRows();
  const items = sortSubscriptions(rows.map((r) => toListItem(r, now)), params.sort, params.direction);
  return { summary: buildSubscriptionSummary(rows, now), list: paginate(items, params.page, params.pageSize) };
}

// ── Historique des paiements (SUB-009 à SUB-013) ────────────────────────────

export type PaymentDisplayStatus = 'paid' | 'failed' | 'pending' | 'void';

export const PAYMENT_DISPLAY_LABELS: Record<PaymentDisplayStatus, string> = {
  paid: 'Payé',
  failed: 'Échec',
  pending: 'En attente',
  void: 'Annulé',
};

/** Statut de facture Stripe → statut affiché ; jamais le motif (SUB-010). */
export function derivePaymentDisplayStatus(invoiceStatus: string): PaymentDisplayStatus {
  const s = invoiceStatus.toLowerCase();
  if (s === 'paid') return 'paid';
  if ((FAILED_INVOICE_STATUSES as readonly string[]).includes(s)) return 'failed';
  if (s === 'void') return 'void';
  return 'pending';
}

export interface PaymentListItem {
  id: number;
  date: string;
  amountCents: number;
  currency: string;
  status: PaymentDisplayStatus;
  statusLabel: string;
  accountId: number;
  accountName: string;
  plan: string;
  stripeUrl: string | null;
}

export async function getPaymentsPage(page: number, pageSize: number): Promise<Page<PaymentListItem>> {
  const [{ total }] = await pgClient.unsafe<{ total: number }[]>(`SELECT count(*)::int AS total FROM invoices`);
  const totalPages = Math.max(1, Math.ceil(Number(total) / pageSize));
  const current = Math.min(Math.max(1, page), totalPages);
  const rows = await pgClient.unsafe<Array<Record<string, unknown>>>(
    `SELECT i.id, i.stripe_invoice_id, i.amount, i.currency, i.status, i.paid_at, i.created_at,
            i.account_id, a.name AS account_name, a.plan_type
       FROM invoices i
       JOIN accounts a ON a.id = i.account_id
      ORDER BY coalesce(i.paid_at, i.created_at) DESC, i.id DESC
      LIMIT $1 OFFSET $2`,
    [pageSize, (current - 1) * pageSize],
  );

  const accountIds = [...new Set(rows.map((r) => Number(r.account_id)))];
  const history = accountIds.length
    ? await pgClient.unsafe<Array<{ account_id: number; created_at: Date; old_tier: string | null; new_tier: string }>>(
        `SELECT account_id, created_at, old_tier, new_tier FROM subscription_history
          WHERE account_id = ANY($1::int[]) ORDER BY created_at ASC`,
        [accountIds],
      )
    : [];
  const byAccount = new Map<number, Array<{ createdAt: Date; oldTier: string | null; newTier: string }>>();
  for (const h of history) {
    const list = byAccount.get(Number(h.account_id)) ?? [];
    list.push({ createdAt: new Date(h.created_at), oldTier: h.old_tier, newTier: h.new_tier });
    byAccount.set(Number(h.account_id), list);
  }

  const items = rows.map((r) => {
    const date = new Date((r.paid_at ?? r.created_at) as string);
    const status = derivePaymentDisplayStatus(String(r.status));
    return {
      id: Number(r.id),
      date: date.toISOString(),
      amountCents: Number(r.amount),
      currency: String(r.currency),
      status,
      statusLabel: PAYMENT_DISPLAY_LABELS[status],
      accountId: Number(r.account_id),
      accountName: String(r.account_name ?? ''),
      plan: planAtDate(byAccount.get(Number(r.account_id)) ?? [], date, String(r.plan_type)),
      stripeUrl: stripeDashboardUrl('invoices', r.stripe_invoice_id as string | null),
    };
  });
  return { items, page: current, pageSize, total: Number(total), totalPages };
}
