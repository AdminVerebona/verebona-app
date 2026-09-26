import { NextResponse } from 'next/server';
import { db } from '@/db';
import { referralEvents } from '@/db/schema';
import { and, eq, isNull, isNotNull, lte, ne } from 'drizzle-orm';
import {
  applyReferralRewardOnce,
  WITHDRAWAL_PERIOD_DAYS,
} from '@/services/referral-reward.service';
import { checkReferralEligibility } from '@/services/referral/referral-eligibility.service';
import { getStripeServer } from '@/lib/stripe';
import { autoResolveAnomaly, referralRewardFingerprint, reportReferralRewardFailure } from '@/services/admin/anomaly.service';

/**
 * GET /api/cron/referral-rewards
 *
 * Attribue l'avantage de parrainage (CDC tarification §13) :
 * un mois offert AU PARRAIN SEUL, lorsque le filleul — nouveau
 * compte — a souscrit un abonnement ANNUEL et que le delai de retractation
 * de 14 jours est ecoule.
 *
 * L'avantage prend la forme d'un report d'un mois de la prochaine echeance,
 * pour chacun des deux comptes. Les avantages sont cumulables.
 *
 * Idempotence : le statut de l'evenement passe a `reward_granted`, ce qui
 * l'exclut des executions suivantes.
 *
 * Protege par CRON_SECRET. Frequence conseillee : une fois par jour.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  // Secret non configuré : refus. Sans ce garde, l'en-tête littéral
  // « Bearer undefined » suffisait à déclencher la tâche.
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const now = new Date();
  const cutoff = new Date(now.getTime() - WITHDRAWAL_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  const result = { examined: 0, granted: 0, skipped: 0, ineligible: 0, errors: 0 };

  try {
    // Evenements factures, delai de retractation ecoule, avantage non encore accorde.
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
            `[cron/referral-rewards] événement ${event.id} non attribué : ${eligibility.reason}` +
            `${eligibility.final ? ' (définitif)' : ' (report)'}`,
          );
          continue;
        }

        // ══════════════════════════════════════════════════════════════
        // L'AVANTAGE VA AU PARRAIN SEUL
        //
        // Le filleul ne reçoit rien : c'est la règle commerciale retenue.
        //
        // Les textes d'inscription ont été repris en conséquence — ils
        // annonçaient « un mois offert » à celui qui saisit le code, ce qui
        // serait devenu une promesse non tenue au moment même où il décide
        // de payer.
        //
        // Le déclencheur reste inchangé : l'avantage est acquis quand le
        // FILLEUL souscrit un abonnement annuel. C'est un point à surveiller
        // — n'y gagnant plus rien, il a moins de raisons de choisir
        // l'annuel, donc moins de parrains seront récompensés.
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
          `[cron/referral-rewards] avantage accordé au parrain — événement ${event.id}, ` +
          `compte ${event.referrerAccountId}`,
        );
      } catch (error) {
        result.errors++;
        console.error(`[cron/referral-rewards] echec sur l'evenement ${event.id}:`, error);
        await reportReferralRewardFailure(event, cutoff, error); // SUP-009 : après plusieurs passages
      }
    }

    return NextResponse.json({ ok: true, ...result, checkedAt: now.toISOString() });
  } catch (error) {
    console.error('[cron/referral-rewards] erreur:', error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
