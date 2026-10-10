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
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CDC LOOKUP_KEY V4 (§12, LK-55 à LK-59, TC-47 à TC-54)
 *
 *   - le prix cible est résolu AU MOMENT DE LA CONFIRMATION (révision active,
 *     relue chez Stripe, révision affichée vérifiée) puis inscrit tel quel
 *     dans la phase future ET dans `scheduled_stripe_price_id` avec montant,
 *     devise, révision et échéancier : une hausse publiée ensuite ne change
 *     pas le prix accepté (TC-49) ;
 *   - la phase courante est recopiée à l'identique — prix réel même
 *     historique, quantité, remises PAR IDENTIFIANT (durée d'un coupon non
 *     relancée), taux de taxe (LK-56, TC-53) ; un échéancier étranger avec
 *     des phases futures non reconnues est refusé, jamais écrasé ;
 *   - `applyScheduledChange` compare l'item au prix cible ENREGISTRÉ, pas au
 *     prix courant du catalogue (EC-07, TC-50) ;
 *   - l'annulation n'efface l'intention locale qu'après libération confirmée
 *     de l'échéancier (ou absence vérifiée) ; sinon l'intention reste, en
 *     état `release_failed` visible (LK-59, TC-52) ;
 *   - une revalorisation planifiée est remplacée par le changement volontaire
 *     (une seule transition, RX-12).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type Stripe from 'stripe';
import { db } from '@/db';
import { accountSubscriptions } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getStripeServer } from '@/lib/stripe';
import {
  isPlanCode,
  isBillingPeriod,
  isUpgrade,
  type PlanCode,
  type BillingPeriod,
} from '@/lib/stripe-prices';
import { parseDisplayedRevision } from '@/lib/billing/plan-catalog';
import { BillingCatalogError, type PublicOffer, type ResolvedPrice } from '@/services/billing/catalog-types';
import { assertDisplayedRevision, resolveCurrentPrice } from '@/services/billing/price-catalog.service';
import { resolveHistoricalPrice } from '@/services/billing/price-history.service';
import { recordPriceOperation } from '@/services/billing/price-operations.service';
import { isRevaluationSchedule, supersedeRevaluation } from '@/services/billing/price-revaluation.service';

export interface ScheduledChange {
  planCode: string;
  billingPeriod: BillingPeriod;
  effectiveAt: Date | null;
  /** Montant accepté à la programmation (centimes), `null` pour une programmation antérieure non rapprochée. */
  unitAmountCents: number | null;
  currency: string | null;
  /** `release_failed` | `blocked` : état anormal visible (LK-58, LK-59). */
  state: string | null;
}

export type ScheduleResult =
  | { ok: true; effectiveAt: Date | null; unitAmountCents?: number }
  | {
      ok: false;
      reason: 'NO_SUBSCRIPTION' | 'NO_ACTIVE_PLAN' | 'INVALID_TARGET' | 'SAME_AS_CURRENT' | 'UPGRADE_IS_IMMEDIATE' | 'STRIPE_SCHEDULE_FAILED' | 'FOREIGN_SCHEDULE'
        | BillingCatalogError['code'];
      offer?: PublicOffer;
    };

const idOf = (v: string | { id: string } | null | undefined): string | null => (!v ? null : typeof v === 'string' ? v : v.id);

/**
 * Phases « courante à l'identique, puis nouveau prix » (pur). Remises
 * reportées par identifiant de remise ; taux de taxe conservés (TC-53).
 */
export function buildChangePhases(
  current: Stripe.SubscriptionSchedule.Phase,
  newPriceId: string,
  period: BillingPeriod,
  quantity: number,
): Stripe.SubscriptionScheduleUpdateParams.Phase[] {
  const discounts = (current.discounts ?? []).map((d) => {
    const discount = idOf(d.discount as string | { id: string } | null);
    if (discount) return { discount };
    const coupon = idOf(d.coupon as string | { id: string } | null);
    const promotion = idOf(d.promotion_code as string | { id: string } | null);
    return coupon ? { coupon } : promotion ? { promotion_code: promotion } : null;
  }).filter((x): x is NonNullable<typeof x> => x !== null);
  const defaultTaxRates = (current.default_tax_rates ?? []).map((t) => idOf(t as string | { id: string })!).filter(Boolean);
  return [
    {
      items: current.items.map((it) => ({
        price: idOf(it.price as string | { id: string })!,
        quantity: it.quantity ?? 1,
        ...(it.tax_rates?.length ? { tax_rates: it.tax_rates.map((t) => idOf(t as string | { id: string })!) } : {}),
      })),
      start_date: current.start_date,
      end_date: current.end_date,
      ...(discounts.length ? { discounts } : {}),
      ...(defaultTaxRates.length ? { default_tax_rates: defaultTaxRates } : {}),
      metadata: current.metadata ?? undefined,
    },
    {
      items: [{ price: newPriceId, quantity }],
      duration: { interval: period === 'yearly' ? 'year' : 'month', interval_count: 1 },
      ...(defaultTaxRates.length ? { default_tax_rates: defaultTaxRates } : {}),
      proration_behavior: 'none',
    },
  ];
}

/**
 * Inscrit le changement chez Stripe pour la fin de la periode en cours.
 * Rend la date de bascule et l'identifiant de l'échéancier.
 */
async function scheduleOnStripe(
  subscriptionId: string,
  newPriceId: string,
  period: BillingPeriod,
  opts: { userChangeAlreadyScheduled: boolean },
): Promise<{ effectiveAt: Date | null; scheduleId: string } | { foreign: true }> {
  const stripe = getStripeServer();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const existing = idOf(subscription.schedule as string | { id: string } | null);
  const scheduleId = existing ?? (await stripe.subscriptionSchedules.create({ from_subscription: subscriptionId })).id;

  const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
  const current = schedule.phases.find(
    (ph) => ph.start_date === schedule.current_phase?.start_date,
  ) ?? schedule.phases[0];
  if (!current) throw new Error(`Echeancier ${scheduleId} sans phase courante`);
  // Échéancier étranger avec des phases futures non reconnues : on refuse
  // plutôt que d'écraser (LK-56). Le nôtre (changement déjà programmé par
  // l'utilisateur) peut être remplacé.
  if (existing && schedule.phases.length > 1 && !opts.userChangeAlreadyScheduled && !isRevaluationSchedule(schedule)) {
    return { foreign: true };
  }

  const item = subscription.items.data.find((i) => idOf(i.price as unknown as string | { id: string }) === idOf(current.items[0]?.price as string | { id: string })) ?? subscription.items.data[0];
  await stripe.subscriptionSchedules.update(scheduleId, {
    end_behavior: 'release',
    proration_behavior: 'none',
    phases: buildChangePhases(current, newPriceId, period, item?.quantity ?? 1),
  });

  // Date de bascule = fin de la phase courante, telle que Stripe l'applique.
  return { effectiveAt: current.end_date ? new Date(current.end_date * 1000) : null, scheduleId };
}

/**
 * Libère l'échéancier Stripe éventuel : l'abonnement reste sur son prix
 * actuel. Rend `released` / `absent` (absence vérifiée) ; lève sinon.
 */
async function releaseStripeSchedule(subscriptionId: string): Promise<'released' | 'absent'> {
  const stripe = getStripeServer();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const scheduleId = idOf(subscription.schedule as string | { id: string } | null);
  if (!scheduleId) return 'absent';
  const released = await stripe.subscriptionSchedules.release(scheduleId);
  if (released && released.status && !['released', 'canceled', 'completed'].includes(released.status)) {
    throw new Error(`Échéancier ${scheduleId} non libéré (${released.status})`);
  }
  return 'released';
}

/**
 * Programme un changement d'offre et/ou de periodicite pour le prochain
 * renouvellement.
 */
export async function scheduleChange(params: {
  accountId: number;
  planCode: string;
  billingPeriod: string;
  /** Révision du prix affiché (LK-34). */
  displayedPriceRevision?: unknown;
  userId?: number | null;
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
      scheduledPlanCode: accountSubscriptions.scheduledPlanCode,
      stripePriceId: accountSubscriptions.stripePriceId,
      contractUnitAmountCents: accountSubscriptions.contractUnitAmountCents,
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

  // ── Prix cible résolu à la confirmation (LK-55) ──
  let target: ResolvedPrice;
  try {
    target = await resolveCurrentPrice(params.planCode, params.billingPeriod, { forPayment: true });
    assertDisplayedRevision(target, parseDisplayedRevision(params.displayedPriceRevision));
  } catch (error) {
    if (error instanceof BillingCatalogError) return { ok: false, reason: error.code, offer: error.offer };
    throw error;
  }

  let placed: { effectiveAt: Date | null; scheduleId: string };
  try {
    // Une revalorisation planifiée devient obsolète : libérée d'abord, pour
    // qu'il n'y ait jamais deux transitions concurrentes (RX-12).
    await supersedeRevaluation(sub.stripeSubscriptionId, 'SUPERSEDED_BY_USER_CHANGE');
    const r = await scheduleOnStripe(sub.stripeSubscriptionId, target.priceId, params.billingPeriod, {
      userChangeAlreadyScheduled: Boolean(sub.scheduledPlanCode),
    });
    if ('foreign' in r) return { ok: false, reason: 'FOREIGN_SCHEDULE' };
    placed = r;
  } catch (error) {
    // Pas de repli local : une bascule declenchee par « la prochaine facture
    // payee » peut tomber sur une facture intermediaire. On refuse, sans
    // rien enregistrer ; l'utilisateur peut reessayer.
    console.error('[scheduled-change] echeancier Stripe non cree :', error);
    return { ok: false, reason: 'STRIPE_SCHEDULE_FAILED' };
  }
  const effectiveAt = placed.effectiveAt ?? sub.currentPeriodEndAt ?? null;

  await db
    .update(accountSubscriptions)
    .set({
      scheduledPlanCode: params.planCode,
      scheduledBillingPeriod: params.billingPeriod,
      scheduledChangeAt: effectiveAt,
      scheduledStripePriceId: target.priceId,
      scheduledPriceRevision: target.priceRevision,
      scheduledUnitAmountCents: target.unitAmountCents,
      scheduledCurrency: target.currency,
      scheduledScheduleId: placed.scheduleId,
      scheduledChangeState: null,
      updatedAt: now,
    })
    .where(eq(accountSubscriptions.accountId, params.accountId));

  await recordPriceOperation({
    kind: 'schedule', accountId: params.accountId, userId: params.userId ?? null, price: target,
    previousPriceId: sub.stripePriceId ?? null, previousAmountCents: sub.contractUnitAmountCents ?? null,
    initiator: params.userId ? `user:${params.userId}` : 'user', stripeReference: placed.scheduleId,
  });

  return { ok: true, effectiveAt, unitAmountCents: target.unitAmountCents };
}

export type CancelScheduledResult = { ok: true; released: 'released' | 'absent' | 'none' } | { ok: false; reason: 'RELEASE_FAILED' };

/** Annule un changement programme avant sa prise d'effet (CDC §10.3, LK-59). */
export async function cancelScheduledChange(accountId: number, now: Date = new Date()): Promise<CancelScheduledResult> {
  const [sub] = await db
    .select({ stripeSubscriptionId: accountSubscriptions.stripeSubscriptionId })
    .from(accountSubscriptions)
    .where(eq(accountSubscriptions.accountId, accountId))
    .limit(1);
  let released: 'released' | 'absent' | 'none' = 'none';
  if (sub?.stripeSubscriptionId) {
    try {
      released = await releaseStripeSchedule(sub.stripeSubscriptionId);
    } catch (error) {
      // L'intention est CONSERVÉE : l'utilisateur ne doit pas croire son
      // changement annulé alors qu'il serait facturé (LK-59).
      console.error('[scheduled-change] liberation de l\'echeancier Stripe :', error);
      await db
        .update(accountSubscriptions)
        .set({ scheduledChangeState: 'release_failed', updatedAt: now })
        .where(eq(accountSubscriptions.accountId, accountId));
      return { ok: false, reason: 'RELEASE_FAILED' };
    }
  }
  await db
    .update(accountSubscriptions)
    .set({
      scheduledPlanCode: null,
      scheduledBillingPeriod: null,
      scheduledChangeAt: null,
      scheduledStripePriceId: null,
      scheduledPriceRevision: null,
      scheduledUnitAmountCents: null,
      scheduledCurrency: null,
      scheduledScheduleId: null,
      scheduledChangeState: null,
      updatedAt: now,
    })
    .where(eq(accountSubscriptions.accountId, accountId));
  return { ok: true, released };
}

/** Changement programme en attente, pour affichage (CDC §9.1, LK-36). */
export async function getScheduledChange(accountId: number): Promise<ScheduledChange | null> {
  const [row] = await db
    .select({
      planCode: accountSubscriptions.scheduledPlanCode,
      billingPeriod: accountSubscriptions.scheduledBillingPeriod,
      effectiveAt: accountSubscriptions.scheduledChangeAt,
      unitAmountCents: accountSubscriptions.scheduledUnitAmountCents,
      currency: accountSubscriptions.scheduledCurrency,
      state: accountSubscriptions.scheduledChangeState,
    })
    .from(accountSubscriptions)
    .where(eq(accountSubscriptions.accountId, accountId))
    .limit(1);

  if (!row?.planCode || !row.billingPeriod) return null;
  return {
    planCode: row.planCode,
    billingPeriod: row.billingPeriod as BillingPeriod,
    effectiveAt: row.effectiveAt ?? null,
    unitAmountCents: row.unitAmountCents ?? null,
    currency: row.currency ?? null,
    state: row.state ?? null,
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
 * prix avant la facture de renouvellement. On constate la bascule — item
 * portant le prix cible ENREGISTRÉ (EC-07) — et on efface l'intention.
 *
 * Une facture qui n'est pas un renouvellement (`subscription_cycle`) —
 * prorata, regularisation, facture manuelle — ne consomme jamais le
 * changement, meme si elle est payee apres la date prevue (TC-54).
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
      scheduledStripePriceId: accountSubscriptions.scheduledStripePriceId,
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
    const switched = await isOnScheduledTarget(subscription, { priceId: sub.scheduledStripePriceId ?? null, planCode, period });

    if (!switched) {
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
      scheduledStripePriceId: null,
      scheduledPriceRevision: null,
      scheduledUnitAmountCents: null,
      scheduledCurrency: null,
      scheduledScheduleId: null,
      scheduledChangeState: null,
      updatedAt: now,
    })
    .where(eq(accountSubscriptions.accountId, accountId));

  return { applied: true, planCode, billingPeriod: period };
}

/**
 * L'abonnement porte-t-il la cible programmée ? Prix ENREGISTRÉ s'il est
 * connu (cas nominal) ; pour une programmation antérieure pas encore
 * rapprochée par la reprise : offre et périodicité RECONNUES de l'item —
 * jamais l'égalité avec le prix public du jour (TC-50).
 */
export async function isOnScheduledTarget(
  subscription: Pick<Stripe.Subscription, 'items'>,
  target: { priceId: string | null; planCode: PlanCode; period: BillingPeriod },
): Promise<boolean> {
  const priceIds = subscription.items.data.map((i) => i.price?.id).filter(Boolean) as string[];
  if (target.priceId) return priceIds.includes(target.priceId);
  for (const id of priceIds) {
    const r = await resolveHistoricalPrice(id, { source: 'scheduled-change' });
    if (r.status === 'recognized' && r.planCode === target.planCode && r.billingPeriod === target.period) return true;
  }
  return false;
}
