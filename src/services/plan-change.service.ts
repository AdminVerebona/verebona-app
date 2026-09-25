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
 * ══════════════════════════════════════════════════════════════════════════
 * MONTEE EN GAMME : IMMEDIATE, HORS DE CE MODULE
 *
 * Standard → Premium / Premium Duo et Premium → Premium Duo prennent effet
 * tout de suite, prorata encaisse par Stripe : voir
 * `services/billing/plan-upgrade.service.ts`. `scheduleChange` les refuse
 * (`UPGRADE_IS_IMMEDIATE`). Ne restent ici que les baisses de gamme et les
 * changements de periodicite d'une meme offre.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA BAISSE ETAIT FACTUREE UN CYCLE TROP TARD
 *
 * L'intention n'etait enregistree qu'en base, puis appliquee dans
 * `invoice.payment_succeeded` — c'est-a-dire APRES l'encaissement de la
 * facture de renouvellement, emise a l'ancien tarif. Le client payait donc
 * une periode de plus au prix de l'offre qu'il avait quittee.
 *
 * Le changement est desormais inscrit chez Stripe dans un echeancier
 * (`subscription_schedule`) : phase courante a l'offre actuelle jusqu'a la
 * fin de periode, puis phase a la nouvelle offre / periodicite, sans
 * prorata. Stripe bascule le prix AVANT d'emettre la facture de
 * renouvellement, qui porte donc directement le nouveau tarif.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE WEBHOOK DE PAIEMENT NE FAIT QUE SYNCHRONISER
 *
 * L'ancien repli (« echeancier impossible → bascule a la premiere facture
 * payee ») pouvait appliquer le changement sur une facture intermediaire
 * (prorata d'une montee en gamme, regularisation) ou trop tard. Il est
 * supprime :
 *   - si l'echeancier ne peut etre cree, la programmation est REFUSEE
 *     (STRIPE_SCHEDULE_FAILED) et rien n'est enregistre : l'utilisateur
 *     peut reessayer, jamais de bascule approximative ;
 *   - `applyScheduledChange` ne modifie jamais l'abonnement Stripe. Il
 *     constate, sur une facture de renouvellement (`subscription_cycle`) ou
 *     une mise a jour d'abonnement, que Stripe porte le prix cible, puis
 *     efface l'intention locale.
 *   - la date de prise d'effet enregistree est celle de la fin de phase
 *     Stripe (scheduledChangeAt), pas une estimation locale.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * L'utilisateur peut annuler un changement programme tant qu'il n'a pas
 * pris effet (§10.3) : l'echeancier est alors libere.
 */
import { db } from '@/db';
import { accountSubscriptions } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getStripeServer } from '@/lib/stripe';
import {
  resolvePriceId,
  isPlanCode,
  isBillingPeriod,
  isUpgrade,
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
  | {
      ok: false;
      reason: 'NO_SUBSCRIPTION' | 'NO_ACTIVE_PLAN' | 'INVALID_TARGET' | 'SAME_AS_CURRENT' | 'UPGRADE_IS_IMMEDIATE' | 'STRIPE_SCHEDULE_FAILED';
    };

/**
 * Inscrit le changement chez Stripe pour la fin de la periode en cours.
 *
 * Phase 1 : l'offre actuelle, a l'identique (prix, quantite, remises),
 * jusqu'a la fin de periode. Phase 2 : le nouveau prix, une periode, puis
 * l'echeancier est libere (`end_behavior: 'release'`) et l'abonnement
 * continue normalement au nouveau prix.
 */
async function scheduleOnStripe(subscriptionId: string, newPriceId: string, period: BillingPeriod): Promise<Date | null> {
  const stripe = getStripeServer();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const existing = subscription.schedule;
  const scheduleId = existing
    ? (typeof existing === 'string' ? existing : existing.id)
    : (await stripe.subscriptionSchedules.create({ from_subscription: subscriptionId })).id;

  const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
  const current = schedule.phases.find(
    (ph) => ph.start_date === schedule.current_phase?.start_date,
  ) ?? schedule.phases[0];
  if (!current) throw new Error(`Echeancier ${scheduleId} sans phase courante`);

  const item = subscription.items.data[0];
  await stripe.subscriptionSchedules.update(scheduleId, {
    end_behavior: 'release',
    proration_behavior: 'none',
    phases: [
      {
        items: current.items.map((it) => ({
          price: typeof it.price === 'string' ? it.price : it.price.id,
          quantity: it.quantity ?? 1,
        })),
        start_date: current.start_date,
        end_date: current.end_date,
        discounts: (current.discounts ?? []).map((d) => ({
          coupon: typeof d.coupon === 'string' ? d.coupon : d.coupon?.id,
          promotion_code: typeof d.promotion_code === 'string' ? d.promotion_code : d.promotion_code?.id,
        })).filter((d) => d.coupon || d.promotion_code),
        metadata: current.metadata ?? undefined,
      },
      {
        items: [{ price: newPriceId, quantity: item?.quantity ?? 1 }],
        duration: { interval: period === 'yearly' ? 'year' : 'month', interval_count: 1 },
        proration_behavior: 'none',
      },
    ],
  });

  // Date de bascule = fin de la phase courante, telle que Stripe l'applique.
  return current.end_date ? new Date(current.end_date * 1000) : null;
}

/** Libere l'echeancier Stripe eventuel : l'abonnement reste sur son prix actuel. */
async function releaseStripeSchedule(subscriptionId: string): Promise<void> {
  const stripe = getStripeServer();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const schedule = subscription.schedule;
  if (!schedule) return;
  const scheduleId = typeof schedule === 'string' ? schedule : schedule.id;
  await stripe.subscriptionSchedules.release(scheduleId);
}

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
  // Une montee en gamme est immediate (plan-upgrade.service), jamais programmee.
  if (isUpgrade(sub.planCode, params.planCode)) {
    return { ok: false, reason: 'UPGRADE_IS_IMMEDIATE' };
  }

  let effectiveAt: Date | null;
  try {
    effectiveAt = await scheduleOnStripe(
      sub.stripeSubscriptionId,
      resolvePriceId(params.planCode, params.billingPeriod),
      params.billingPeriod,
    );
  } catch (error) {
    // Pas de repli local : une bascule declenchee par « la prochaine facture
    // payee » peut tomber sur une facture intermediaire. On refuse, sans
    // rien enregistrer ; l'utilisateur peut reessayer.
    console.error('[scheduled-change] echeancier Stripe non cree :', error);
    return { ok: false, reason: 'STRIPE_SCHEDULE_FAILED' };
  }
  effectiveAt = effectiveAt ?? sub.currentPeriodEndAt ?? null;

  await db
    .update(accountSubscriptions)
    .set({
      scheduledPlanCode: params.planCode,
      scheduledBillingPeriod: params.billingPeriod,
      scheduledChangeAt: effectiveAt,
      updatedAt: now,
    })
    .where(eq(accountSubscriptions.accountId, params.accountId));

  return { ok: true, effectiveAt };
}

/** Annule un changement programme avant sa prise d'effet (CDC §10.3). */
export async function cancelScheduledChange(accountId: number, now: Date = new Date()): Promise<void> {
  const [sub] = await db
    .select({ stripeSubscriptionId: accountSubscriptions.stripeSubscriptionId })
    .from(accountSubscriptions)
    .where(eq(accountSubscriptions.accountId, accountId))
    .limit(1);
  if (sub?.stripeSubscriptionId) {
    await releaseStripeSchedule(sub.stripeSubscriptionId).catch((error) =>
      console.error('[scheduled-change] liberation de l\'echeancier Stripe :', error),
    );
  }
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

/** Contexte de l'appel : une facture (webhook de paiement) ou une mise a jour d'abonnement. */
export interface ScheduledChangeTrigger {
  /** `invoice.billing_reason` quand l'appel vient d'une facture payee. */
  invoiceBillingReason?: string | null;
}

/**
 * Synchronise un changement programme apres sa prise d'effet chez Stripe.
 *
 * Ne modifie JAMAIS l'abonnement Stripe : l'echeancier a deja bascule le
 * prix avant la facture de renouvellement. On constate la bascule et on
 * efface l'intention locale.
 *
 * Une facture qui n'est pas un renouvellement (`subscription_cycle`) —
 * prorata, regularisation, facture manuelle — ne consomme jamais le
 * changement, meme si elle est payee apres la date prevue.
 */
export async function applyScheduledChange(
  accountId: number,
  now: Date = new Date(),
  trigger: ScheduledChangeTrigger = {},
): Promise<{ applied: boolean; planCode?: PlanCode; billingPeriod?: BillingPeriod; reason?: string }> {
  if (trigger.invoiceBillingReason !== undefined && trigger.invoiceBillingReason !== 'subscription_cycle') {
    return { applied: false, reason: 'NOT_A_RENEWAL_INVOICE' };
  }

  const [sub] = await db
    .select({
      scheduledPlanCode: accountSubscriptions.scheduledPlanCode,
      scheduledBillingPeriod: accountSubscriptions.scheduledBillingPeriod,
      scheduledChangeAt: accountSubscriptions.scheduledChangeAt,
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
    const item = subscription.items.data[0];
    if (!item) return { applied: false };
    const targetPrice = resolvePriceId(planCode, period);

    if (item.price.id !== targetPrice) {
      // Stripe n'a pas (encore) bascule. Tant que la date n'est pas passee,
      // rien d'anormal. Au-dela, sans echeancier, la programmation a ete
      // perdue cote Stripe (echeancier libere ailleurs) : on le signale, on
      // ne bascule pas a la main (ce serait une facturation hors cycle).
      const echu = sub.scheduledChangeAt ? sub.scheduledChangeAt.getTime() <= now.getTime() : false;
      if (echu && !subscription.schedule) {
        console.error(
          `[scheduled-change] compte ${accountId} : changement vers ${planCode}/${period} prevu le ` +
          `${sub.scheduledChangeAt?.toISOString()} non applique par Stripe (echeancier absent).`,
        );
        return { applied: false, reason: 'STRIPE_SCHEDULE_MISSING' };
      }
      return { applied: false, reason: 'NOT_YET_SWITCHED' };
    }
  } catch (error) {
    console.error('[scheduled-change] lecture Stripe impossible :', error);
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
