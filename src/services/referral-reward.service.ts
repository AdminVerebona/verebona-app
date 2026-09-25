/**
 * Recompense de parrainage — nouvelle formule (CDC §13).
 *
 * Regle : 1 mois offert AU PARRAIN SEUL lorsque le filleul, sur un
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
 *   - Filleul : aucun avantage. Il saisit le code pour son parrain.
 *
 * Les avantages sont cumulables : chaque attribution repousse l'echeance
 * courante d'un mois supplementaire.
 */
import { db, pgClient } from '@/db';
import { accountSubscriptions } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getStripeServer } from '@/lib/stripe';
import type Stripe from 'stripe';

/** Delai de retractation legal, en jours (vente a distance). */
export const WITHDRAWAL_PERIOD_DAYS = 14;

/** Duree de l'avantage accorde, en mois. */
export const REFERRAL_REWARD_MONTHS = 1;

export type RewardOutcome =
  | { granted: true; newPeriodEnd: Date; alreadyApplied?: boolean }
  | { granted: false; reason: 'NO_SUBSCRIPTION' | 'NO_STRIPE_SUBSCRIPTION' | 'STRIPE_ERROR' | 'CLAIMED_ELSEWHERE' };

/** Identifiant stable de LA récompense d'un événement (Stripe + base). */
export const rewardKeyFor = (eventId: number) => `referral-reward-${eventId}`;
/** Clé de métadonnée posée sur l'abonnement Stripe du parrain. */
export const rewardMetadataKey = (eventId: number) => `vb_referral_reward_${eventId}`;

/** Durée d'une prise : au-delà, une prise non finalisée est réputée abandonnée. */
export const REWARD_CLAIM_TTL_MINUTES = 15;

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
 * Échéance réelle chez Stripe : fin d'essai en cours (un mois déjà offert)
 * ou fin de la période de l'élément d'abonnement (API Basil).
 */
function stripePeriodEnd(sub: Stripe.Subscription): Date | null {
  const trial = sub.trial_end && sub.status === 'trialing' ? sub.trial_end : null;
  const item = sub.items?.data?.[0] as (Stripe.SubscriptionItem & { current_period_end?: number }) | undefined;
  const end = trial ?? item?.current_period_end ?? null;
  return end ? new Date(end * 1000) : null;
}

/**
 * Attribue la récompense d'un événement de parrainage, UNE SEULE FOIS.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * IDEMPOTENCE EXPLICITE (et non plus `rewarded_at` posé après coup)
 *
 *   1. PRISE ATOMIQUE en base (`reward_status = reward_processing`, jeton) :
 *      deux exécutions concurrentes du cron ne peuvent pas prendre le même
 *      événement. Une prise abandonnée (processus arrêté) est reprise après
 *      REWARD_CLAIM_TTL_MINUTES.
 *   2. RECONNAISSANCE CÔTÉ STRIPE : la métadonnée `vb_referral_reward_{id}`
 *      sur l'abonnement du parrain dit que CETTE récompense est déjà
 *      appliquée — un rejeu après une panne entre Stripe et la base ne
 *      reporte pas l'échéance une seconde fois.
 *   3. APPEL STRIPE avec la même métadonnée et une clé d'idempotence
 *      stable (`referral-reward-{id}`).
 *   4. FINALISATION (`reward_applied`, `rewarded_at`) conditionnée au jeton.
 * Échec Stripe : la prise est relâchée, l'événement reste à traiter.
 * ══════════════════════════════════════════════════════════════════════════
 */
export async function applyReferralRewardOnce(
  event: { id: number; referrerAccountId: number },
  now: Date = new Date(),
  deps: { stripe?: Pick<Stripe, 'subscriptions'> } = {},
): Promise<RewardOutcome> {
  const key = rewardKeyFor(event.id);

  // 1. Prise exclusive.
  const claimed = (await pgClient.unsafe(
    `UPDATE referral_events
        SET reward_status = 'reward_processing', reward_key = $2,
            reward_claim_token = gen_random_uuid(), reward_claimed_at = now(), updated_at = now()
      WHERE id = $1 AND rewarded_at IS NULL
        AND (reward_status IS NULL
             OR (reward_status = 'reward_processing'
                 AND reward_claimed_at < now() - ($3 || ' minutes')::interval))
      RETURNING reward_claim_token`,
    [event.id, key, String(REWARD_CLAIM_TTL_MINUTES)] as never[],
  )) as unknown as Array<{ reward_claim_token: string }>;
  const token = claimed[0]?.reward_claim_token;
  if (!token) return { granted: false, reason: 'CLAIMED_ELSEWHERE' };

  const release = () => pgClient.unsafe(
    `UPDATE referral_events SET reward_status = NULL, reward_claim_token = NULL, updated_at = now()
      WHERE id = $1 AND reward_claim_token = $2`,
    [event.id, token] as never[],
  );

  const [sub] = await db
    .select({ stripeSubscriptionId: accountSubscriptions.stripeSubscriptionId })
    .from(accountSubscriptions)
    .where(eq(accountSubscriptions.accountId, event.referrerAccountId))
    .limit(1);
  if (!sub) { await release(); return { granted: false, reason: 'NO_SUBSCRIPTION' }; }
  if (!sub.stripeSubscriptionId) { await release(); return { granted: false, reason: 'NO_STRIPE_SUBSCRIPTION' }; }

  let newPeriodEnd: Date;
  let alreadyApplied = false;
  try {
    const stripe = deps.stripe ?? getStripeServer();
    const current = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
    const mark = current.metadata?.[rewardMetadataKey(event.id)];

    if (mark) {
      // 2. Déjà appliquée chez Stripe (rejeu après panne) : on constate.
      alreadyApplied = true;
      const recorded = Date.parse(mark.split('|')[1] ?? '');
      newPeriodEnd = Number.isFinite(recorded) ? new Date(recorded) : (stripePeriodEnd(current) ?? now);
    } else {
      // 3. Report d'un mois depuis l'échéance réelle chez Stripe.
      const end = stripePeriodEnd(current);
      const base = end && end.getTime() > now.getTime() ? end : now;
      newPeriodEnd = addMonths(base, REFERRAL_REWARD_MONTHS);
      await stripe.subscriptions.update(
        sub.stripeSubscriptionId,
        {
          // Rien n'est facture jusqu'a cette date : le mois est offert.
          trial_end: Math.floor(newPeriodEnd.getTime() / 1000),
          proration_behavior: 'none',
          metadata: {
            referral_reward_applied_at: now.toISOString(),
            [rewardMetadataKey(event.id)]: `${now.toISOString()}|${newPeriodEnd.toISOString()}`,
          },
        },
        { idempotencyKey: key },
      );
    }
  } catch (error) {
    console.error('[referral] echec du report d\'echeance Stripe:', error);
    await release();
    return { granted: false, reason: 'STRIPE_ERROR' };
  }

  // 4. Finalisation, conditionnée à la prise.
  await pgClient.unsafe(
    `UPDATE referral_events
        SET reward_status = 'reward_applied', status = 'reward_granted',
            rewarded_at = $3, reward_applied_at = $3, reward_period_end = $4, updated_at = now()
      WHERE id = $1 AND reward_claim_token = $2`,
    [event.id, token, now.toISOString(), newPeriodEnd.toISOString()] as never[],
  );

  // La date locale sera confirmée par le webhook customer.subscription.updated ;
  // écrite tout de suite pour que l'UI soit juste immédiatement.
  await db
    .update(accountSubscriptions)
    .set({ currentPeriodEndAt: newPeriodEnd, updatedAt: now })
    .where(eq(accountSubscriptions.accountId, event.referrerAccountId));

  return { granted: true, newPeriodEnd, alreadyApplied };
}

/**
 * @deprecated Sans idempotence : ne pas appeler pour un événement de
 * parrainage — utiliser `applyReferralRewardOnce`. Conservé pour les usages
 * d'administration ponctuels.
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

  const base =
    sub.currentPeriodEndAt && sub.currentPeriodEndAt.getTime() > now.getTime()
      ? sub.currentPeriodEndAt
      : now;
  const newPeriodEnd = addMonths(base, REFERRAL_REWARD_MONTHS);

  try {
    await getStripeServer().subscriptions.update(sub.stripeSubscriptionId, {
      trial_end: Math.floor(newPeriodEnd.getTime() / 1000),
      proration_behavior: 'none',
      metadata: { referral_reward_applied_at: now.toISOString() },
    });
  } catch (error) {
    console.error('[referral] echec du report d\'echeance Stripe:', error);
    return { granted: false, reason: 'STRIPE_ERROR' };
  }

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
