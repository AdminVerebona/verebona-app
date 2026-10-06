/**
 * Attribution de l'avantage de parrainage (CDC tarification §13) : un mois
 * offert AU PARRAIN SEUL, lorsque le filleul — nouveau compte — a souscrit un
 * abonnement ANNUEL et que le délai de rétractation de 14 jours est écoulé.
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
import { and, eq, isNull, isNotNull, lte, ne } from 'drizzle-orm';
import { db } from '@/db';
import { referralEvents } from '@/db/schema';
import { applyReferralRewardOnce, WITHDRAWAL_PERIOD_DAYS } from '@/services/referral-reward.service';
import { checkReferralEligibility } from '@/services/referral/referral-eligibility.service';
import { getStripeServer } from '@/lib/stripe';
import { autoResolveAnomaly, referralRewardFingerprint, reportReferralRewardFailure } from '@/services/admin/anomaly.service';

export interface ReferralRewardsResult {
  examined: number;
  granted: number;
  skipped: number;
  ineligible: number;
  errors: number;
}

export async function runReferralRewards(now: Date = new Date()): Promise<ReferralRewardsResult> {
  const cutoff = new Date(now.getTime() - WITHDRAWAL_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  const result: ReferralRewardsResult = { examined: 0, granted: 0, skipped: 0, ineligible: 0, errors: 0 };

  // Événements facturés, délai de rétractation écoulé, avantage non encore accordé.
  const pending = await db
    .select({
      id: referralEvents.id,
      referrerAccountId: referralEvents.referrerAccountId,
      referredAccountId: referralEvents.referredAccountId,
      firstBilledAt: referralEvents.firstBilledAt,
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
      const eligibility = await checkReferralEligibility(getStripeServer(), {
        referredAccountId: event.referredAccountId,
        stripeInvoiceId: event.stripeInvoiceId,
        stripeSubscriptionId: event.stripeSubscriptionId,
      });
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
      );

      if (!referrer.granted) {
        result.skipped++;
        continue;
      }

      result.granted++;
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
