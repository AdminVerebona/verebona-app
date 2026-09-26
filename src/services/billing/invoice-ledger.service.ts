/**
 * Registre local des factures Stripe (table `invoices`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI
 *
 * Le back-office lit `invoices` pour le CA encaissé (CDC BO DOV-001/DOV-002),
 * la synthèse « paiements échoués » (SUB-001), l'historique des paiements et
 * la fiche compte (SUB-009/SUB-010). Aucun code n'écrivait dans cette table
 * (audit BO §2.6) : tous ces écrans affichaient zéro.
 *
 * Le webhook Stripe l'alimente désormais à chaque événement de facture
 * (`invoice.finalized`, `invoice.updated`, `invoice.paid`,
 * `invoice.payment_succeeded`, `invoice.payment_failed`, `invoice.voided`,
 * `invoice.marked_uncollectible`) et au remboursement (`charge.refunded`).
 *
 * IDEMPOTENCE : clé = identifiant de facture Stripe (colonne unique). Rejouer
 * un événement réécrit la même ligne.
 *
 * ORDRE NON GARANTI : Stripe peut livrer `invoice.updated` (open) APRÈS
 * `invoice.paid`. Le statut ne régresse donc jamais : chaque statut a un rang
 * et une mise à jour de rang inférieur est ignorée (voir `STATUS_RANK`).
 *
 * STATUT LOCAL `payment_failed` : Stripe laisse une facture impayée en
 * `open`. Le BO doit pourtant identifier un paiement échoué (SUB-010) sans en
 * exposer le motif : une facture `open` dont une tentative a échoué est
 * enregistrée `payment_failed` (valeur déjà attendue par
 * `FAILED_INVOICE_STATUSES` côté BO).
 *
 * MONTANT : centimes, avant frais Stripe (DOV-002). Facture payée → montant
 * encaissé (`amount_paid`) ; sinon montant dû (`amount_due`). Les factures à
 * 0 € (aucune somme due ni encaissée) ne sont pas des paiements : ignorées.
 * Un remboursement n'altère pas `amount` (somme encaissée à la date
 * d'encaissement) : il est porté par `amount_refunded`.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type Stripe from 'stripe';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { accounts, accountSubscriptions, duoAccounts, invoices } from '@/db/schema';
import { getStripeServer } from '@/lib/stripe';
import { resolvePlanFromPriceId } from '@/lib/stripe-prices';
import { getInvoicePriceId, getInvoiceSubscriptionId } from '@/services/billing/subscription-sync.service';

// ─── Règles pures ────────────────────────────────────────────────────────────

export type LocalInvoiceStatus = 'draft' | 'open' | 'payment_failed' | 'uncollectible' | 'paid' | 'void';

/**
 * Rang de chaque statut : un statut ne peut être remplacé que par un statut
 * de rang supérieur ou égal (événements livrés dans le désordre).
 * `paid` et `void` sont terminaux.
 */
export const STATUS_RANK: Record<LocalInvoiceStatus, number> = {
  draft: 0,
  open: 1,
  payment_failed: 2,
  uncollectible: 3,
  paid: 4,
  void: 4,
};

const idOf = (v: string | { id: string } | null | undefined): string | null =>
  !v ? null : typeof v === 'string' ? v : v.id;

const toDate = (unix: number | null | undefined): Date | null =>
  typeof unix === 'number' && unix > 0 ? new Date(unix * 1000) : null;

/** Statut local d'une facture Stripe, selon l'événement reçu. */
export function localInvoiceStatus(
  invoice: Pick<Stripe.Invoice, 'status' | 'attempt_count' | 'attempted'>,
  eventType?: string,
): LocalInvoiceStatus {
  switch (invoice.status) {
    case 'paid': return 'paid';
    case 'void': return 'void';
    case 'uncollectible': return 'uncollectible';
    case 'draft': return 'draft';
    default:
      if (eventType === 'invoice.payment_failed') return 'payment_failed';
      // Une facture ouverte déjà tentée et non payée est un échec de paiement.
      if (invoice.attempted && (invoice.attempt_count ?? 0) > 0) return 'payment_failed';
      return 'open';
  }
}

/** Statut retenu entre la ligne existante et l'événement reçu. */
export function mergeInvoiceStatus(existing: string | null | undefined, incoming: LocalInvoiceStatus): string {
  if (!existing) return incoming;
  const current = STATUS_RANK[existing as LocalInvoiceStatus] ?? 0;
  return STATUS_RANK[incoming] >= current ? incoming : existing;
}

export interface InvoiceRecord {
  stripeInvoiceId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  planCode: string | null;
  billingPeriod: string | null;
  billingReason: string | null;
  amount: number;
  currency: string;
  status: LocalInvoiceStatus;
  paidAt: Date | null;
  periodStartAt: Date | null;
  periodEndAt: Date | null;
  lastPaymentFailedAt: Date | null;
  invoicePdf: string | null;
  hostedInvoiceUrl: string | null;
}

/**
 * Traduit une facture Stripe en ligne locale. Pure.
 * `null` : facture sans identifiant/client, ou facture à 0 € (pas un paiement).
 */
export function buildInvoiceRecord(
  invoice: Stripe.Invoice,
  opts: { eventType?: string; now?: Date } = {},
): InvoiceRecord | null {
  const customerId = idOf(invoice.customer as string | { id: string } | null);
  if (!invoice.id || !customerId) return null;
  if ((invoice.amount_due ?? 0) === 0 && (invoice.amount_paid ?? 0) === 0 && (invoice.total ?? 0) === 0) {
    return null;
  }

  const status = localInvoiceStatus(invoice, opts.eventType);
  const priceId = getInvoicePriceId(invoice);
  const plan = resolvePlanFromPriceId(priceId);
  const line = invoice.lines?.data?.[0];
  const interval = (line as unknown as { price?: { recurring?: { interval?: string } } } | undefined)
    ?.price?.recurring?.interval;
  const billingPeriod = plan?.period ?? (interval === 'month' ? 'monthly' : interval === 'year' ? 'yearly' : null);

  return {
    stripeInvoiceId: invoice.id,
    stripeCustomerId: customerId,
    stripeSubscriptionId: getInvoiceSubscriptionId(invoice),
    stripePriceId: priceId,
    planCode: plan?.planCode ?? null,
    billingPeriod,
    billingReason: invoice.billing_reason ?? null,
    amount: status === 'paid' ? (invoice.amount_paid ?? 0) : (invoice.amount_due ?? 0),
    currency: (invoice.currency ?? 'eur').toLowerCase(),
    status,
    paidAt: status === 'paid' ? (toDate(invoice.status_transitions?.paid_at) ?? opts.now ?? new Date()) : null,
    periodStartAt: toDate(line?.period?.start),
    periodEndAt: toDate(line?.period?.end),
    // Seul l'événement d'échec date un échec (un `invoice.updated` ultérieur
    // ne doit pas déplacer cette date).
    lastPaymentFailedAt: opts.eventType === 'invoice.payment_failed' ? (opts.now ?? new Date()) : null,
    invoicePdf: invoice.invoice_pdf ?? null,
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
  };
}

// ─── Rattachement au compte ──────────────────────────────────────────────────

/**
 * Compte payeur d'une facture : par abonnement d'abord (le client Stripe peut
 * être partagé par un ancien et un nouvel abonnement), puis par client.
 */
export async function resolveInvoiceAccount(
  customerId: string,
  subscriptionId: string | null,
): Promise<{ accountId: number; ownerUserId: number } | null> {
  const byId = async (accountId: number | null | undefined) => {
    if (!accountId) return null;
    const [a] = await db
      .select({ accountId: accounts.id, ownerUserId: accounts.ownerUserId })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    return a ?? null;
  };

  if (subscriptionId) {
    const [sub] = await db
      .select({ accountId: accountSubscriptions.accountId })
      .from(accountSubscriptions)
      .where(eq(accountSubscriptions.stripeSubscriptionId, subscriptionId))
      .limit(1);
    const fromSub = await byId(sub?.accountId);
    if (fromSub) return fromSub;

    const [legacy] = await db
      .select({ accountId: accounts.id, ownerUserId: accounts.ownerUserId })
      .from(accounts)
      .where(eq(accounts.stripeSubscriptionId, subscriptionId))
      .limit(1);
    if (legacy) return legacy;

    // Abonnement Duo : le compte payeur est celui du titulaire de facturation.
    const [duo] = await db
      .select({ id: duoAccounts.id, ownerUserId: duoAccounts.billingOwnerUserId })
      .from(duoAccounts)
      .where(eq(duoAccounts.stripeSubscriptionId, subscriptionId))
      .limit(1);
    if (duo) {
      const [linked] = await db
        .select({ accountId: accounts.id, ownerUserId: accounts.ownerUserId })
        .from(accounts)
        .where(eq(accounts.duoAccountId, duo.id))
        .limit(1);
      if (linked) return linked;
      const [owned] = await db
        .select({ accountId: accounts.id, ownerUserId: accounts.ownerUserId })
        .from(accounts)
        .where(eq(accounts.ownerUserId, duo.ownerUserId))
        .limit(1);
      if (owned) return owned;
    }
  }

  const [byCustomer] = await db
    .select({ accountId: accounts.id, ownerUserId: accounts.ownerUserId })
    .from(accounts)
    .where(eq(accounts.stripeCustomerId, customerId))
    .limit(1);
  if (byCustomer) return byCustomer;

  const [subByCustomer] = await db
    .select({ accountId: accountSubscriptions.accountId })
    .from(accountSubscriptions)
    .where(eq(accountSubscriptions.stripeCustomerId, customerId))
    .limit(1);
  return byId(subByCustomer?.accountId);
}

// ─── Écriture ────────────────────────────────────────────────────────────────

/** Rang SQL d'un statut (miroir de `STATUS_RANK`). */
const rankSql = (column: string) => sql.raw(
  `(CASE ${column} WHEN 'draft' THEN 0 WHEN 'open' THEN 1 WHEN 'payment_failed' THEN 2 ` +
  `WHEN 'uncollectible' THEN 3 WHEN 'paid' THEN 4 WHEN 'void' THEN 4 ELSE 0 END)`,
);

export type InvoiceLedgerOutcome =
  | { recorded: true; accountId: number; status: LocalInvoiceStatus }
  | { recorded: false; reason: 'NOT_APPLICABLE' | 'ACCOUNT_NOT_FOUND' };

/**
 * Enregistre (ou met à jour) une facture Stripe. Idempotent.
 * Ne lève que sur une erreur de base : le webhook est alors rejoué par Stripe.
 */
export async function recordStripeInvoice(
  invoice: Stripe.Invoice,
  opts: { eventType?: string; now?: Date } = {},
): Promise<InvoiceLedgerOutcome> {
  const now = opts.now ?? new Date();
  const record = buildInvoiceRecord(invoice, { ...opts, now });
  if (!record) return { recorded: false, reason: 'NOT_APPLICABLE' };

  const owner = await resolveInvoiceAccount(record.stripeCustomerId, record.stripeSubscriptionId);
  if (!owner) {
    console.warn(`[invoice-ledger] facture ${record.stripeInvoiceId} : aucun compte pour ${record.stripeCustomerId}`);
    return { recorded: false, reason: 'ACCOUNT_NOT_FOUND' };
  }

  const newer = sql`${rankSql('excluded.status')} >= ${rankSql('invoices.status')}`;
  await db
    .insert(invoices)
    .values({
      accountId: owner.accountId,
      userId: owner.ownerUserId,
      ...record,
      createdAt: toDate(invoice.created) ?? now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: invoices.stripeInvoiceId,
      set: {
        status: sql`CASE WHEN ${newer} THEN excluded.status ELSE invoices.status END`,
        amount: sql`CASE WHEN ${newer} THEN excluded.amount ELSE invoices.amount END`,
        paidAt: sql`COALESCE(invoices.paid_at, excluded.paid_at)`,
        lastPaymentFailedAt: sql`GREATEST(invoices.last_payment_failed_at, excluded.last_payment_failed_at)`,
        stripeSubscriptionId: sql`COALESCE(excluded.stripe_subscription_id, invoices.stripe_subscription_id)`,
        stripePriceId: sql`COALESCE(excluded.stripe_price_id, invoices.stripe_price_id)`,
        planCode: sql`COALESCE(excluded.plan_code, invoices.plan_code)`,
        billingPeriod: sql`COALESCE(excluded.billing_period, invoices.billing_period)`,
        billingReason: sql`COALESCE(excluded.billing_reason, invoices.billing_reason)`,
        periodStartAt: sql`COALESCE(excluded.period_start_at, invoices.period_start_at)`,
        periodEndAt: sql`COALESCE(excluded.period_end_at, invoices.period_end_at)`,
        invoicePdf: sql`COALESCE(excluded.invoice_pdf, invoices.invoice_pdf)`,
        hostedInvoiceUrl: sql`COALESCE(excluded.hosted_invoice_url, invoices.hosted_invoice_url)`,
        updatedAt: now,
      },
    });

  return { recorded: true, accountId: owner.accountId, status: record.status };
}

/**
 * `charge.refunded` : reporte le montant remboursé sur la facture réglée par
 * cette charge. En API Basil, une charge ne porte plus sa facture : elle est
 * retrouvée par le règlement (`invoicePayments`) de son PaymentIntent.
 * Facture inconnue localement : rien à faire (elle sera créée avec
 * `amount_refunded` = 0 par le rattrapage, montant encaissé exact).
 */
export async function recordChargeRefund(
  charge: Pick<Stripe.Charge, 'id' | 'payment_intent' | 'amount_refunded'>,
  stripe: Pick<Stripe, 'invoicePayments'> = getStripeServer(),
): Promise<{ updated: boolean; invoiceId: string | null }> {
  const pi = idOf(charge.payment_intent as string | { id: string } | null);
  if (!pi) return { updated: false, invoiceId: null };

  const list = await stripe.invoicePayments.list({
    payment: { type: 'payment_intent', payment_intent: pi },
    limit: 1,
  });
  const invoiceId = idOf(list.data[0]?.invoice as string | { id: string } | null | undefined);
  if (!invoiceId) return { updated: false, invoiceId: null };

  const rows = await db
    .update(invoices)
    .set({ amountRefunded: charge.amount_refunded ?? 0, updatedAt: new Date() })
    .where(eq(invoices.stripeInvoiceId, invoiceId))
    .returning({ id: invoices.id });
  return { updated: rows.length > 0, invoiceId };
}

/**
 * Rattrapage : reprend depuis Stripe toutes les factures d'un client.
 * Idempotent (même écriture que le webhook). Utilisé par
 * `scripts/backfill-invoices.ts`.
 */
export async function backfillInvoicesForCustomer(
  customerId: string,
  stripe: Pick<Stripe, 'invoices'> = getStripeServer(),
): Promise<{ seen: number; recorded: number }> {
  let seen = 0;
  let recorded = 0;
  for await (const invoice of stripe.invoices.list({ customer: customerId, limit: 100 })) {
    seen += 1;
    const out = await recordStripeInvoice(invoice, { eventType: 'backfill' });
    if (out.recorded) recorded += 1;
  }
  return { seen, recorded };
}
