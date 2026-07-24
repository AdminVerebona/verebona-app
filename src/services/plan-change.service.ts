/**
 * Changement d'offre et de periodicite (CDC tarification §10).
 *
 * Regle commune : un changement ne prend jamais effet immediatement.
 *
 *   - Mensuel vers annuel : effet a la prochaine echeance mensuelle.
 *     Aucun prorata n'est applique. Le tarif annuel en vigueur est facture
 *     a l'echeance, et la periode annuelle demarre alors.
 *
 *   - Annuel vers mensuel : effet a la fin de la periode annuelle payee.
 *     Aucun remboursement au prorata n'est accorde.
 *
 * L'intention est enregistree localement, puis appliquee au renouvellement.
 * Ce choix evite de manipuler des echeanciers Stripe pour une regle simple,
 * et garde Verebona maitre de la logique commerciale (CDC §5.8).
 *
 * L'utilisateur peut annuler un changement programme tant qu'il n'a pas
 * pris effet (§10.3).
 */
import { db } from '@/db';
import { accountSubscriptions } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getStripeServer } from '@/lib/stripe';
import {
  resolvePriceId,
  isPlanCode,
  isBillingPeriod,
  type PlanCode,
  type BillingPeriod,
} from '@/lib/stripe-prices';

export interface ScheduledChange {
  planCode: string;
  billingPeriod: BillingPeriod;
  effectiveAt: Date | null;
}

export type ScheduleResult =
  | { ok: true; effectiveAt: Date | null }
  | { ok: false; reason: 'NO_SUBSCRIPTION' | 'NO_ACTIVE_PLAN' | 'INVALID_TARGET' | 'SAME_AS_CURRENT' };

/**
 * Programme un changement d'offre et/ou de periodicite pour le prochain
 * renouvellement.
 */
export async function scheduleChange(params: {
  accountId: number;
  planCode: string;
  billingPeriod: string;
  now?: Date;
}): Promise<ScheduleResult> {
  const now = params.now ?? new Date();

  if (!isPlanCode(params.planCode) || !isBillingPeriod(params.billingPeriod)) {
    return { ok: false, reason: 'INVALID_TARGET' };
  }

  const [sub] = await db
    .select({
      planCode: accountSubscriptions.planCode,
      billingPeriod: accountSubscriptions.billingPeriod,
      currentPeriodEndAt: accountSubscriptions.currentPeriodEndAt,
      stripeSubscriptionId: accountSubscriptions.stripeSubscriptionId,
    })
    .from(accountSubscriptions)
    .where(eq(accountSubscriptions.accountId, params.accountId))
    .limit(1);

  if (!sub) return { ok: false, reason: 'NO_SUBSCRIPTION' };
  if (!sub.stripeSubscriptionId) return { ok: false, reason: 'NO_ACTIVE_PLAN' };

  // Programmer ce qui est deja en cours n'a pas de sens.
  if (sub.planCode === params.planCode && sub.billingPeriod === params.billingPeriod) {
    return { ok: false, reason: 'SAME_AS_CURRENT' };
  }

  await db
    .update(accountSubscriptions)
    .set({
      scheduledPlanCode: params.planCode,
      scheduledBillingPeriod: params.billingPeriod,
      scheduledChangeAt: sub.currentPeriodEndAt ?? null,
      updatedAt: now,
    })
    .where(eq(accountSubscriptions.accountId, params.accountId));

  return { ok: true, effectiveAt: sub.currentPeriodEndAt ?? null };
}

/** Annule un changement programme avant sa prise d'effet (CDC §10.3). */
export async function cancelScheduledChange(accountId: number, now: Date = new Date()): Promise<void> {
  await db
    .update(accountSubscriptions)
    .set({
      scheduledPlanCode: null,
      scheduledBillingPeriod: null,
      scheduledChangeAt: null,
      updatedAt: now,
    })
    .where(eq(accountSubscriptions.accountId, accountId));
}

/** Changement programme en attente, pour affichage (CDC §9.1). */
export async function getScheduledChange(accountId: number): Promise<ScheduledChange | null> {
  const [row] = await db
    .select({
      planCode: accountSubscriptions.scheduledPlanCode,
      billingPeriod: accountSubscriptions.scheduledBillingPeriod,
      effectiveAt: accountSubscriptions.scheduledChangeAt,
    })
    .from(accountSubscriptions)
    .where(eq(accountSubscriptions.accountId, accountId))
    .limit(1);

  if (!row?.planCode || !row.billingPeriod) return null;
  return {
    planCode: row.planCode,
    billingPeriod: row.billingPeriod as BillingPeriod,
    effectiveAt: row.effectiveAt ?? null,
  };
}

/**
 * Applique un changement programme au moment du renouvellement.
 *
 * Appele depuis le traitement des webhooks, lorsqu'une facture est payee :
 * l'abonnement Stripe bascule sur le nouveau prix, sans prorata, et la
 * programmation locale est effacee.
 */
export async function applyScheduledChange(
  accountId: number,
  now: Date = new Date(),
): Promise<{ applied: boolean; planCode?: PlanCode; billingPeriod?: BillingPeriod }> {
  const [sub] = await db
    .select({
      scheduledPlanCode: accountSubscriptions.scheduledPlanCode,
      scheduledBillingPeriod: accountSubscriptions.scheduledBillingPeriod,
      stripeSubscriptionId: accountSubscriptions.stripeSubscriptionId,
    })
    .from(accountSubscriptions)
    .where(eq(accountSubscriptions.accountId, accountId))
    .limit(1);

  const planCode = sub?.scheduledPlanCode;
  const period = sub?.scheduledBillingPeriod;

  if (!planCode || !period || !sub?.stripeSubscriptionId) return { applied: false };
  if (!isPlanCode(planCode) || !isBillingPeriod(period)) return { applied: false };

  try {
    const stripe = getStripeServer();
    const subscription = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
    const itemId = subscription.items.data[0]?.id;
    if (!itemId) return { applied: false };

    await stripe.subscriptions.update(sub.stripeSubscriptionId, {
      items: [{ id: itemId, price: resolvePriceId(planCode, period) }],
      // Aucun prorata : le nouveau tarif s'applique a la periode qui commence.
      proration_behavior: 'none',
    });
  } catch (error) {
    console.error('[scheduled-change] echec de l\'application Stripe:', error);
    return { applied: false };
  }

  await db
    .update(accountSubscriptions)
    .set({
      planCode,
      billingPeriod: period,
      scheduledPlanCode: null,
      scheduledBillingPeriod: null,
      scheduledChangeAt: null,
      updatedAt: now,
    })
    .where(eq(accountSubscriptions.accountId, accountId));

  return { applied: true, planCode, billingPeriod: period };
}
