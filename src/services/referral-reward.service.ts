/**
 * Recompense de parrainage — nouvelle formule (CDC §13).
 *
 * Regle : 1 mois offert au parrain ET au filleul lorsque le filleul, sur un
 * NOUVEAU compte, souscrit un abonnement ANNUEL.
 *
 * L'avantage est attribue apres le delai de retractation (14 jours), afin de
 * ne pas offrir un mois sur une souscription annulee.
 *
 * Mise en oeuvre Stripe : on repousse la prochaine echeance d'un mois via
 * `trial_end` sur l'abonnement en cours. Stripe ne facture rien jusqu'a cette
 * date : c'est l'equivalent exact d'« un mois offert », sans toucher au prix
 * ni creer de coupon.
 *
 *   - Filleul annuel  : premiere periode prolongee d'un mois.
 *   - Parrain annuel  : prochaine echeance repoussee d'un mois.
 *   - Parrain mensuel : prochaine mensualite offerte (13e mois offert).
 *
 * Les avantages sont cumulables : chaque attribution repousse l'echeance
 * courante d'un mois supplementaire.
 */
import { db } from '@/db';
import { accountSubscriptions } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getStripeServer } from '@/lib/stripe';

/** Delai de retractation legal, en jours (vente a distance). */
export const WITHDRAWAL_PERIOD_DAYS = 14;

/** Duree de l'avantage accorde, en mois. */
export const REFERRAL_REWARD_MONTHS = 1;

export type RewardOutcome =
  | { granted: true; newPeriodEnd: Date }
  | { granted: false; reason: 'NO_SUBSCRIPTION' | 'NO_STRIPE_SUBSCRIPTION' | 'STRIPE_ERROR' };

/**
 * Ajoute des mois a une date en gerant les fins de mois.
 * Le 31 janvier + 1 mois donne le 28/29 fevrier, jamais le 3 mars.
 */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const targetDay = result.getUTCDate();
  result.setUTCMonth(result.getUTCMonth() + months);
  // Si le jour a debordé sur le mois suivant, on recule au dernier jour du mois voulu.
  if (result.getUTCDate() < targetDay) {
    result.setUTCDate(0);
  }
  return result;
}

/** Date a partir de laquelle l'avantage peut etre attribue (CDC §13). */
export function withdrawalDeadline(firstBilledAt: Date): Date {
  return new Date(firstBilledAt.getTime() + WITHDRAWAL_PERIOD_DAYS * 24 * 60 * 60 * 1000);
}

/** Le delai de retractation est-il ecoule ? */
export function isWithdrawalPeriodOver(firstBilledAt: Date, now: Date = new Date()): boolean {
  return now.getTime() >= withdrawalDeadline(firstBilledAt).getTime();
}

/**
 * Repousse d'un mois la prochaine echeance d'un compte.
 *
 * Idempotence : l'appelant doit s'assurer de ne declencher l'attribution
 * qu'une fois par evenement de parrainage (statut `reward_granted`).
 */
export async function postponeNextBillingByOneMonth(
  accountId: number,
  now: Date = new Date(),
): Promise<RewardOutcome> {
  const [sub] = await db
    .select({
      stripeSubscriptionId: accountSubscriptions.stripeSubscriptionId,
      currentPeriodEndAt: accountSubscriptions.currentPeriodEndAt,
    })
    .from(accountSubscriptions)
    .where(eq(accountSubscriptions.accountId, accountId))
    .limit(1);

  if (!sub) return { granted: false, reason: 'NO_SUBSCRIPTION' };
  if (!sub.stripeSubscriptionId) return { granted: false, reason: 'NO_STRIPE_SUBSCRIPTION' };

  // Point de depart : l'echeance connue, ou maintenant si elle est deja passee.
  const base =
    sub.currentPeriodEndAt && sub.currentPeriodEndAt.getTime() > now.getTime()
      ? sub.currentPeriodEndAt
      : now;

  const newPeriodEnd = addMonths(base, REFERRAL_REWARD_MONTHS);

  try {
    const stripe = getStripeServer();
    await stripe.subscriptions.update(sub.stripeSubscriptionId, {
      // Rien n'est facture jusqu'a cette date : le mois est offert.
      trial_end: Math.floor(newPeriodEnd.getTime() / 1000),
      proration_behavior: 'none',
      metadata: { referral_reward_applied_at: now.toISOString() },
    });
  } catch (error) {
    console.error('[referral] echec du report d\'echeance Stripe:', error);
    return { granted: false, reason: 'STRIPE_ERROR' };
  }

  // La date locale sera confirmee par le webhook customer.subscription.updated ;
  // on l'ecrit tout de suite pour que l'UI soit juste immediatement.
  await db
    .update(accountSubscriptions)
    .set({ currentPeriodEndAt: newPeriodEnd, updatedAt: now })
    .where(eq(accountSubscriptions.accountId, accountId));

  return { granted: true, newPeriodEnd };
}

/**
 * Le filleul remplit-il les conditions ? (CDC §13)
 * Nouveau compte + abonnement ANNUEL.
 */
export function isEligibleReferredSubscription(params: {
  billingPeriod: string | null;
  isNewAccount: boolean;
}): boolean {
  return params.isNewAccount && params.billingPeriod === 'yearly';
}
