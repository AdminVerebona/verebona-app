/**
 * Attribution de l'avantage de parrainage (CDC tarification §13) : un mois
 * offert AU PARRAIN SEUL, lorsque le filleul — nouveau compte — a souscrit un
 * abonnement ANNUEL, que son premier paiement annuel est encaissé et que son
 * délai de rétractation est clos (règle centrale `referral-rules.ts`, lot
 * 102D : calendrier légal avec prorogation, + marge).
 *
 * Lot 102D :
 *   · passage préalable : tout parrainage non récompensé dont le filleul a
 *     exercé sa rétractation est ANNULÉ tout de suite (motif conservé),
 *     sans attendre la fin du délai ;
 *   · la notification « récompense créditée » part ICI, après l'attribution
 *     effective — plus au premier paiement du filleul.
 *
 * Traitement partagé par GET /api/cron/referral-rewards et la tâche planifiée
 * interne `referral-rewards` (lot 25).
 *
 * L'avantage prend la forme d'un report d'un mois de la prochaine échéance.
 *
 * Idempotence : le statut de l'événement passe à `reward_granted`, ce qui
 * l'exclut des exécutions suivantes ; la prise est atomique
 * (`applyReferralRewardOnce`) — deux passages simultanés n'accordent jamais
 * deux fois le même avantage.
 */
import type Stripe from 'stripe';
import { and, eq, isNull, isNotNull, lte, ne } from 'drizzle-orm';
import { db, pgClient } from '@/db';
import { accounts, referralEvents } from '@/db/schema';
import { applyReferralRewardOnce } from '@/services/referral-reward.service';
import { checkReferralEligibility, WITHDRAWAL_BLOCKING } from '@/services/referral/referral-eligibility.service';
import { rewardPrefilterCutoff } from '@/services/referral/referral-rules';
import { getStripeServer } from '@/lib/stripe';
import { emit } from '@/lib/notifications';
import { NOTIFICATION_TYPES } from '@/types/notifications';
import { autoResolveAnomaly, referralRewardFingerprint, reportReferralRewardFailure } from '@/services/admin/anomaly.service';

interface ReferralRewardsResult {
  /** Lot 102D : parrainages annulés par une rétractation du filleul. */
  canceledByWithdrawal: number;
  examined: number;
  granted: number;
  skipped: number;
  ineligible: number;
  errors: number;
}

/**
 * Annule (idempotent) les parrainages non récompensés dont le filleul a
 * exercé sa rétractation (toute demande non rejetée).
 */
export async function cancelReferralsAfterWithdrawal(now: Date = new Date()): Promise<number> {
  const rows = (await pgClient.unsafe(
    `UPDATE referral_events re
        SET status = 'canceled',
            metadata_json = COALESCE(re.metadata_json, '{}'::jsonb)
              || jsonb_build_object('rewardIneligibility', jsonb_build_object('reason', 'WITHDRAWAL_EXERCISED', 'detail', NULL, 'at', $1::text)),
            updated_at = now()
      WHERE re.rewarded_at IS NULL AND re.status <> 'canceled'
        AND COALESCE(re.reward_status, '') <> 'reward_processing'
        AND EXISTS (SELECT 1 FROM withdrawal_requests w
                     WHERE w.account_id = re.referred_account_id AND w.status = ANY($2::text[]))
      RETURNING re.id`,
    [now.toISOString(), WITHDRAWAL_BLOCKING] as never[],
  )) as unknown as Array<{ id: number }>;
  return rows.length;
}

/** Notification au parrain, APRÈS l'attribution effective (lot 102D). */
async function notifyReferrer(event: { id: number; referrerAccountId: number; referredAccountId: number }): Promise<void> {
  try {
    const [referrer] = await db
      .select({ ownerUserId: accounts.ownerUserId })
      .from(accounts)
      .where(eq(accounts.id, event.referrerAccountId))
      .limit(1);
    if (!referrer?.ownerUserId) return;
    await emit({
      type: NOTIFICATION_TYPES.REFERRAL_REWARD_GRANTED,
      recipientUserIds: [referrer.ownerUserId],
      entityType: 'referral_event',
      entityId: event.id,
      payload: { referralEventId: event.id, referredAccountId: event.referredAccountId },
      dedupeKey: `account:referral-reward-granted:${event.id}`,
    });
  } catch (err) {
    console.error('[referral-rewards] notification au parrain non émise:', (err as Error)?.message ?? err);
  }
}

export async function runReferralRewards(
  now: Date = new Date(),
  deps: { stripe?: Pick<Stripe, 'subscriptions' | 'invoicePayments' | 'charges' | 'paymentIntents' | 'disputes' | 'invoices' | 'paymentMethods' | 'customers'> } = {},
): Promise<ReferralRewardsResult> {
  // Présélection SQL large (14 jours) ; la date exacte (calendrier légal,
  // prorogation, marge) est contrôlée événement par événement.
  const cutoff = rewardPrefilterCutoff(now);
  const result: ReferralRewardsResult = { canceledByWithdrawal: 0, examined: 0, granted: 0, skipped: 0, ineligible: 0, errors: 0 };
  const stripe = () => deps.stripe ?? getStripeServer();

  result.canceledByWithdrawal = await cancelReferralsAfterWithdrawal(now);

  // Événements facturés, délai de rétractation écoulé, avantage non encore accordé.
  const pending = await db
    .select({
      id: referralEvents.id,
      referrerAccountId: referralEvents.referrerAccountId,
      referredAccountId: referralEvents.referredAccountId,
      firstBilledAt: referralEvents.firstBilledAt,
      contractConcludedAt: referralEvents.contractConcludedAt,
      stripeInvoiceId: referralEvents.stripeInvoiceId,
      stripeSubscriptionId: referralEvents.stripeSubscriptionId,
      metadataJson: referralEvents.metadataJson,
    })
    .from(referralEvents)
    .where(
      and(
        isNotNull(referralEvents.firstBilledAt),
        lte(referralEvents.firstBilledAt, cutoff),
        isNull(referralEvents.rewardedAt),
        // Événements définitivement inéligibles (remboursement, rétractation…) exclus.
        ne(referralEvents.status, 'canceled'),
      ),
    );

  result.examined = pending.length;

  for (const event of pending) {
    try {
      // ══════════════════════════════════════════════════════════════
      // ÉLIGIBILITÉ CONTRÔLÉE À L'INSTANT DE L'ATTRIBUTION
      //
      // Annuel toujours valide (base + Stripe), aucune rétractation,
      // paiement du filleul encaissé, non remboursé, non contesté.
      // Inéligibilité définitive → événement clos (« canceled », motif
      // conservé) ; incertitude (Stripe injoignable, contestation en
      // cours) → simple report au passage suivant.
      // ══════════════════════════════════════════════════════════════
      const eligibility = await checkReferralEligibility(stripe() as never, {
        referredAccountId: event.referredAccountId,
        stripeInvoiceId: event.stripeInvoiceId,
        stripeSubscriptionId: event.stripeSubscriptionId,
        referrerAccountId: event.referrerAccountId,
        firstBilledAt: event.firstBilledAt,
        contractConcludedAt: event.contractConcludedAt,
      }, now);
      if (!eligibility.eligible) {
        if (eligibility.final) {
          await db
            .update(referralEvents)
            .set({
              status: 'canceled',
              metadataJson: {
                ...(event.metadataJson ?? {}),
                rewardIneligibility: { reason: eligibility.reason, detail: eligibility.detail ?? null, at: now.toISOString() },
              },
              updatedAt: now,
            })
            .where(eq(referralEvents.id, event.id));
          result.ineligible++;
        } else {
          // Lot 102D : motif d'attente visible dans le BO (« Motif »).
          await db
            .update(referralEvents)
            .set({
              metadataJson: {
                ...(event.metadataJson ?? {}),
                rewardPending: { reason: eligibility.reason, at: now.toISOString() },
              },
              updatedAt: now,
            })
            .where(eq(referralEvents.id, event.id));
          result.skipped++;
        }
        console.info(
          `[referral-rewards] événement ${event.id} non attribué : ${eligibility.reason}` +
          `${eligibility.final ? ' (définitif)' : ' (report)'}`,
        );
        continue;
      }

      // ══════════════════════════════════════════════════════════════
      // L'AVANTAGE VA AU PARRAIN SEUL
      //
      // Le filleul ne reçoit rien : c'est la règle commerciale retenue.
      // Le déclencheur reste inchangé : l'avantage est acquis quand le
      // FILLEUL souscrit un abonnement annuel.
      // ══════════════════════════════════════════════════════════════
      // Une seule attribution par événement : prise atomique, reconnaissance
      // côté Stripe, finalisation conditionnée (applyReferralRewardOnce).
      const referrer = await applyReferralRewardOnce(
        { id: event.id, referrerAccountId: event.referrerAccountId },
        now,
        deps.stripe ? { stripe: deps.stripe } : {},
      );

      if (!referrer.granted) {
        result.skipped++;
        continue;
      }

      result.granted++;
      // Notification idempotente (clé de déduplication par événement).
      await notifyReferrer(event);
      await autoResolveAnomaly(referralRewardFingerprint(event.id), { origin: 'referral_reward_cron' });
      console.info(
        `[referral-rewards] avantage accordé au parrain — événement ${event.id}, ` +
        `compte ${event.referrerAccountId}`,
      );
    } catch (error) {
      result.errors++;
      console.error(`[referral-rewards] échec sur l'événement ${event.id}:`, error);
      await reportReferralRewardFailure(event, cutoff, error); // SUP-009 : après plusieurs passages
    }
  }

  return result;
}
