/**
 * Éligibilité au mois offert du parrainage, contrôlée AU MOMENT de
 * l'attribution (CDC tarification §13).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ATTENDRE 14 JOURS NE SUFFIT PAS
 *
 * Le cron vérifiait : filleul facturé, 14 jours écoulés, abonnement annuel,
 * avantage non encore attribué. Il ne vérifiait pas que le paiement du
 * filleul existait toujours : remboursé, annulé par une rétractation,
 * contesté — ou l'abonnement résilié entre-temps. Le parrain recevait un mois
 * offert sur une souscription qui n'avait finalement rien rapporté.
 *
 * Contrôles, à l'instant de l'attribution :
 *   1. rétractation exercée par le filleul (base locale) ;
 *   2. abonnement annuel toujours valide : base locale ET Stripe (actif,
 *      intervalle annuel, pas de résiliation programmée) ;
 *   3. paiement éligible (facture de première souscription) : réellement
 *      encaissé, non remboursé (même partiellement), non contesté — lu chez
 *      Stripe, au format Basil (`invoicePayments`).
 * Paiement introuvable ou Stripe injoignable : pas d'attribution, nouvelle
 * tentative au passage suivant — jamais un cadeau « par défaut ».
 * Le bénéficiaire reste le parrain seul.
 *
 * Lot 102D (règle centrale `referral-rules.ts`) :
 *   0. délai de rétractation du filleul réellement clos (calendrier légal,
 *      prorogation comprise, + marge) — avant : 14 × 24 h ;
 *   4. auto-parrainage au paiement : la carte (empreinte Stripe) ou l'adresse
 *      de facturation qui a payé l'abonnement du filleul est celle du parrain
 *      → refus définitif.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type Stripe from 'stripe';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { accountSubscriptions, withdrawalRequests } from '@/db/schema';
import { listInvoicePaidCharges, type PaidCharge } from '@/services/billing/stripe-payments';
import { addressKey, paymentSelfReferralReason, rewardEarliestAt, type SelfReferralReason } from './referral-rules';

export type IneligibilityReason =
  | 'NOT_YEARLY'
  | 'SUBSCRIPTION_NOT_ACTIVE'
  | 'SUBSCRIPTION_CANCELED'
  | 'WITHDRAWAL_EXERCISED'
  | 'PAYMENT_REFUNDED'
  | 'PAYMENT_DISPUTED'
  | 'PAYMENT_NOT_FOUND'
  | 'STRIPE_UNAVAILABLE'
  | 'WITHDRAWAL_PERIOD_RUNNING'
  | SelfReferralReason;

interface EligibilityDecision {
  eligible: boolean;
  reason?: IneligibilityReason;
  /**
   * Définitif : l'événement ne sera plus jamais éligible (rétractation,
   * remboursement, résiliation, contestation perdue). Sinon, simple report.
   */
  final?: boolean;
  detail?: string;
}

/** Statuts de rétractation qui annulent la souscription (toute demande non rejetée). */
export const WITHDRAWAL_BLOCKING = ['received', 'manual_review', 'processing', 'completed', 'failed'];
const DISPUTE_OPEN = ['warning_needs_response', 'warning_under_review', 'needs_response', 'under_review'];

interface EligibilityFacts {
  local: { billingPeriod: string | null; status: string | null; cancelAtPeriodEnd: boolean; stripeSubscriptionId: string | null } | null;
  withdrawalStatuses: string[];
  stripeSubscription: { status: string; interval: string | null; cancelAtPeriodEnd: boolean; canceledAt: number | null } | null;
  charges: PaidCharge[] | null;
  disputes: Array<{ status: string }>;
  /** Lot 102D : moyens de paiement et adresses du parrain (null : non lus). */
  referrer?: { cardFingerprints: string[]; addressKeys: string[] } | null;
}

/** Contrôles sur la seule base locale ; `null` si rien ne s'oppose encore. */
function decideLocally(f: Pick<EligibilityFacts, 'local' | 'withdrawalStatuses'>): EligibilityDecision | null {
  if (f.withdrawalStatuses.some((s) => WITHDRAWAL_BLOCKING.includes(s))) {
    return { eligible: false, reason: 'WITHDRAWAL_EXERCISED', final: true };
  }
  if (!f.local || f.local.billingPeriod !== 'yearly') {
    return { eligible: false, reason: 'NOT_YEARLY', final: false };
  }
  if (f.local.status === 'canceled' || f.local.cancelAtPeriodEnd) {
    return { eligible: false, reason: 'SUBSCRIPTION_CANCELED', final: true };
  }
  return null;
}

/** Décision pure, sur des faits déjà réunis. */
function decideEligibility(f: EligibilityFacts): EligibilityDecision {
  const locally = decideLocally(f);
  if (locally) return locally;
  const s = f.stripeSubscription;
  if (!s) return { eligible: false, reason: 'STRIPE_UNAVAILABLE', final: false };
  if (s.status === 'canceled' || s.canceledAt || s.cancelAtPeriodEnd) {
    return { eligible: false, reason: 'SUBSCRIPTION_CANCELED', final: true };
  }
  if (s.status !== 'active') return { eligible: false, reason: 'SUBSCRIPTION_NOT_ACTIVE', final: false, detail: s.status };
  if (s.interval !== 'year') return { eligible: false, reason: 'NOT_YEARLY', final: false };

  if (!f.charges || f.charges.length === 0) {
    return { eligible: false, reason: 'PAYMENT_NOT_FOUND', final: false };
  }
  if (f.charges.some((c) => c.amountRefunded > 0)) {
    return { eligible: false, reason: 'PAYMENT_REFUNDED', final: true };
  }
  if (f.disputes.some((d) => d.status === 'lost')) {
    return { eligible: false, reason: 'PAYMENT_DISPUTED', final: true };
  }
  if (f.disputes.some((d) => DISPUTE_OPEN.includes(d.status)) || (f.charges.some((c) => c.disputed) && f.disputes.length === 0)) {
    // Contestation en cours : pas de cadeau tant qu'elle n'est pas close.
    return { eligible: false, reason: 'PAYMENT_DISPUTED', final: false };
  }
  if (f.referrer) {
    const self = paymentSelfReferralReason({
      referredCardFingerprints: f.charges.map((c) => c.cardFingerprint ?? null),
      referredAddressKeys: f.charges.map((c) => addressKey(c.billingAddress)),
      referrerCardFingerprints: f.referrer.cardFingerprints,
      referrerAddressKeys: f.referrer.addressKeys,
    });
    if (self) return { eligible: false, reason: self, final: true };
  }
  return { eligible: true };
}

type StripeLike = Pick<Stripe, 'subscriptions' | 'invoicePayments' | 'charges' | 'paymentIntents' | 'disputes' | 'invoices'>
  & Partial<Pick<Stripe, 'paymentMethods' | 'customers'>>;

/**
 * Cartes (empreintes) et adresses de facturation du PARRAIN, lues chez
 * Stripe (client du compte parrain). `null` si le parrain n'a pas de client
 * Stripe ou si le client fourni ne sait pas les lire.
 */
async function referrerPaymentIdentity(
  stripe: StripeLike, referrerAccountId: number,
): Promise<{ cardFingerprints: string[]; addressKeys: string[] } | null> {
  if (!stripe.paymentMethods || !stripe.customers) return null;
  const [row] = await db
    .select({ customerId: accountSubscriptions.stripeCustomerId })
    .from(accountSubscriptions)
    .where(eq(accountSubscriptions.accountId, referrerAccountId))
    .limit(1);
  const customerId = row?.customerId ?? null;
  if (!customerId) return null;
  const out = { cardFingerprints: [] as string[], addressKeys: [] as string[] };
  const methods = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 100 });
  for (const m of methods.data) {
    if (m.card?.fingerprint) out.cardFingerprints.push(m.card.fingerprint);
    const k = addressKey(m.billing_details?.address ?? null);
    if (k) out.addressKeys.push(k);
  }
  const customer = await stripe.customers.retrieve(customerId);
  if (!('deleted' in customer && customer.deleted)) {
    const k = addressKey((customer as Stripe.Customer).address ?? null);
    if (k) out.addressKeys.push(k);
  }
  return out;
}

/** Réunit les faits (base + Stripe) puis décide. */
export async function checkReferralEligibility(
  stripe: StripeLike,
  event: {
    referredAccountId: number;
    stripeInvoiceId: string | null;
    stripeSubscriptionId?: string | null;
    /** Lot 102D : parrain (contrôle d'auto-parrainage au paiement). */
    referrerAccountId?: number;
    /** Lot 102D : premier paiement annuel du filleul (délai de rétractation). */
    firstBilledAt?: Date | null;
    contractConcludedAt?: Date | null;
  },
  now: Date = new Date(),
): Promise<EligibilityDecision> {
  // 0. Délai de rétractation du filleul : calendrier légal + marge (pur).
  if (event.firstBilledAt !== undefined) {
    const earliest = rewardEarliestAt({ firstBilledAt: event.firstBilledAt, contractConcludedAt: event.contractConcludedAt ?? null });
    if (!earliest) return { eligible: false, reason: 'PAYMENT_NOT_FOUND', final: false };
    if (now.getTime() < earliest.getTime()) {
      return { eligible: false, reason: 'WITHDRAWAL_PERIOD_RUNNING', final: false, detail: earliest.toISOString() };
    }
  }

  const [local] = await db
    .select({
      billingPeriod: accountSubscriptions.billingPeriod,
      status: accountSubscriptions.status,
      cancelAtPeriodEnd: accountSubscriptions.cancelAtPeriodEnd,
      stripeSubscriptionId: accountSubscriptions.stripeSubscriptionId,
    })
    .from(accountSubscriptions)
    .where(eq(accountSubscriptions.accountId, event.referredAccountId))
    .limit(1);

  const withdrawals = await db
    .select({ status: withdrawalRequests.status })
    .from(withdrawalRequests)
    .where(and(eq(withdrawalRequests.accountId, event.referredAccountId), inArray(withdrawalRequests.status, WITHDRAWAL_BLOCKING)));

  const facts: EligibilityFacts = {
    local: local ?? null,
    withdrawalStatuses: withdrawals.map((w) => w.status),
    stripeSubscription: null,
    charges: null,
    disputes: [],
  };

  // Refus certains sans appel Stripe.
  const locally = decideLocally(facts);
  if (locally) return locally;

  const subId = event.stripeSubscriptionId ?? local?.stripeSubscriptionId ?? null;
  try {
    if (subId) {
      const sub = await stripe.subscriptions.retrieve(subId);
      const item = sub.items.data[0];
      facts.stripeSubscription = {
        status: sub.status,
        interval: item?.price?.recurring?.interval ?? null,
        cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end) || Boolean(sub.cancel_at),
        canceledAt: sub.canceled_at ?? null,
      };
    }
    // Paiement éligible : la facture de première souscription enregistrée à
    // la première facturation ; à défaut, la première facture payée de
    // l'abonnement.
    let invoiceId = event.stripeInvoiceId;
    if (!invoiceId && subId) {
      const invoices = await stripe.invoices.list({ subscription: subId, status: 'paid', limit: 100 });
      const first = [...invoices.data].sort((a, b) => a.created - b.created)[0];
      invoiceId = first?.id ?? null;
    }
    if (invoiceId) {
      facts.charges = await listInvoicePaidCharges(stripe, invoiceId);
      for (const c of facts.charges) {
        if (!c.disputed) continue;
        const list = await stripe.disputes.list({ charge: c.chargeId, limit: 10 });
        facts.disputes.push(...list.data.map((d) => ({ status: d.status })));
      }
    }
    if (event.referrerAccountId !== undefined) {
      facts.referrer = await referrerPaymentIdentity(stripe, event.referrerAccountId);
    }
  } catch (e) {
    return { eligible: false, reason: 'STRIPE_UNAVAILABLE', final: false, detail: (e as Error).message };
  }

  return decideEligibility(facts);
}
