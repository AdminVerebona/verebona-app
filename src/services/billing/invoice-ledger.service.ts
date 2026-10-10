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
 *
 * OFFRE ATTRIBUÉE (CDC lookup_key V4, LK-74, LK-75, TC-55) : les prix de
 * TOUTES les lignes (pagination comprise) sont prérésolus de façon
 * asynchrone par le registre historique, puis fournis à la fonction PURE
 * `buildInvoiceRecord` (aucun appel réseau caché). Le détail ligne par
 * ligne est conservé (`line_items_json`). Convention documentée pour le
 * champ unique `plan_code` (`plan_resolution`) :
 *   - `single`      toutes les lignes reconnues portent la même offre ;
 *   - `charge_line` facture de changement d'offre : crédit sur l'ancien prix
 *                   et UNE charge positive sur le nouveau → offre de la charge ;
 *   - `multiple`    plusieurs offres facturées positivement → offre NULL ;
 *   - `unknown`     aucune ligne reconnue → offre NULL.
 * Jamais la première ligne comme preuve arbitraire. Les montants encaissés,
 * dus et remboursés restent ceux de Stripe (LK-76).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type Stripe from 'stripe';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { accounts, accountSubscriptions, duoAccounts, invoices } from '@/db/schema';
import { getStripeServer } from '@/lib/stripe';
import { getInvoiceLinePriceId, getInvoiceSubscriptionId } from '@/services/billing/subscription-sync.service';
import { resolveHistoricalPrices, type HistoricalPriceResult } from '@/services/billing/price-history.service';

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
  lineItemsJson: InvoiceLineDetail[];
  planResolution: 'single' | 'charge_line' | 'multiple' | 'unknown';
}

export type InvoiceLineDetail = {
  priceId: string | null;
  planCode: string | null;
  billingPeriod: string | null;
  amount: number;
  proration: boolean;
  periodStart: string | null;
  periodEnd: string | null;
};

/** Correspondances de prix prérésolues (prix → offre, périodicité). */
export type PriceResolutionMap = Map<string, Pick<Extract<HistoricalPriceResult, { status: 'recognized' }>, 'planCode' | 'billingPeriod'> | { status: string }>;

/** Attribution de l'offre d'une facture multiligne (pure, LK-75). */
export function attributeInvoicePlan(lines: InvoiceLineDetail[]): { line: InvoiceLineDetail | null; resolution: InvoiceRecord['planResolution'] } {
  const recognized = lines.filter((l) => l.planCode);
  if (recognized.length === 0) return { line: null, resolution: 'unknown' };
  const keys = new Set(recognized.map((l) => `${l.planCode}:${l.billingPeriod}`));
  if (keys.size === 1) return { line: recognized.find((l) => l.amount > 0) ?? recognized[0], resolution: 'single' };
  const charges = recognized.filter((l) => l.amount > 0);
  const chargeKeys = new Set(charges.map((l) => `${l.planCode}:${l.billingPeriod}`));
  if (chargeKeys.size === 1) return { line: charges.sort((a, b) => b.amount - a.amount)[0], resolution: 'charge_line' };
  return { line: null, resolution: 'multiple' };
}

/**
 * Traduit une facture Stripe en ligne locale. Pure.
 * `null` : facture sans identifiant/client, ou facture à 0 € (pas un paiement).
 */
export function buildInvoiceRecord(
  invoice: Stripe.Invoice,
  opts: { eventType?: string; now?: Date; prices?: PriceResolutionMap; lines?: Stripe.InvoiceLineItem[] } = {},
): InvoiceRecord | null {
  const customerId = idOf(invoice.customer as string | { id: string } | null);
  if (!invoice.id || !customerId) return null;
  if ((invoice.amount_due ?? 0) === 0 && (invoice.amount_paid ?? 0) === 0 && (invoice.total ?? 0) === 0) {
    return null;
  }

  const status = localInvoiceStatus(invoice, opts.eventType);
  const rawLines = opts.lines ?? invoice.lines?.data ?? [];
  const details: InvoiceLineDetail[] = rawLines.map((line) => {
    const priceId = getInvoiceLinePriceId(line);
    const resolved = priceId ? opts.prices?.get(priceId) : undefined;
    const ok = resolved && 'planCode' in resolved ? resolved : null;
    return {
      priceId,
      planCode: ok?.planCode ?? null,
      billingPeriod: ok?.billingPeriod ?? null,
      amount: line.amount ?? 0,
      proration: Boolean((line as unknown as { parent?: { subscription_item_details?: { proration?: boolean } } }).parent?.subscription_item_details?.proration
        ?? (line as unknown as { proration?: boolean }).proration),
      periodStart: toDate(line.period?.start)?.toISOString() ?? null,
      periodEnd: toDate(line.period?.end)?.toISOString() ?? null,
    };
  });
  const { line: attributed, resolution } = attributeInvoicePlan(details);
  const periodLine = attributed ?? details[0] ?? null;
  // Périodicité d'une facture à UNE ligne non rapprochée : cadence de sa ligne
  // (information de période, jamais une attribution d'offre).
  const singleInterval = rawLines.length === 1
    ? (rawLines[0] as unknown as { price?: { recurring?: { interval?: string } } }).price?.recurring?.interval
    : undefined;

  return {
    stripeInvoiceId: invoice.id,
    stripeCustomerId: customerId,
    stripeSubscriptionId: getInvoiceSubscriptionId(invoice),
    stripePriceId: attributed?.priceId ?? (details.length === 1 ? details[0].priceId : null),
    planCode: attributed?.planCode ?? null,
    billingPeriod: attributed?.billingPeriod ?? (singleInterval === 'month' ? 'monthly' : singleInterval === 'year' ? 'yearly' : null),
    billingReason: invoice.billing_reason ?? null,
    amount: status === 'paid' ? (invoice.amount_paid ?? 0) : (invoice.amount_due ?? 0),
    currency: (invoice.currency ?? 'eur').toLowerCase(),
    status,
    paidAt: status === 'paid' ? (toDate(invoice.status_transitions?.paid_at) ?? opts.now ?? new Date()) : null,
    periodStartAt: periodLine?.periodStart ? new Date(periodLine.periodStart) : null,
    periodEndAt: periodLine?.periodEnd ? new Date(periodLine.periodEnd) : null,
    // Seul l'événement d'échec date un échec (un `invoice.updated` ultérieur
    // ne doit pas déplacer cette date).
    lastPaymentFailedAt: opts.eventType === 'invoice.payment_failed' ? (opts.now ?? new Date()) : null,
    invoicePdf: invoice.invoice_pdf ?? null,
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    lineItemsJson: details,
    planResolution: resolution,
  };
}

/** Toutes les lignes d'une facture, pagination comprise (LK-75). */
export async function collectInvoiceLines(
  invoice: Stripe.Invoice,
  stripe?: Pick<Stripe, 'invoices'>,
): Promise<Stripe.InvoiceLineItem[]> {
  const first = invoice.lines?.data ?? [];
  if (!invoice.lines?.has_more || !invoice.id) return first;
  const client = stripe ?? getStripeServer();
  const all: Stripe.InvoiceLineItem[] = [];
  for await (const line of client.invoices.listLineItems(invoice.id, { limit: 100 })) all.push(line);
  return all;
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
  opts: { eventType?: string; now?: Date; stripe?: Pick<Stripe, 'invoices'> } = {},
): Promise<InvoiceLedgerOutcome> {
  const now = opts.now ?? new Date();
  // Prérésolution asynchrone des prix de toutes les lignes (LK-74).
  const lines = await collectInvoiceLines(invoice, opts.stripe);
  const prices = await resolveHistoricalPrices(lines.map((l) => getInvoiceLinePriceId(l)), { source: 'invoice' });
  const record = buildInvoiceRecord(invoice, { eventType: opts.eventType, now, prices, lines });
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
        lineItemsJson: sql`COALESCE(excluded.line_items_json, invoices.line_items_json)`,
        planResolution: sql`COALESCE(excluded.plan_resolution, invoices.plan_resolution)`,
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
