import { NextResponse } from 'next/server';
import { db } from '@/db';
import { referralEvents, accountSubscriptions } from '@/db/schema';
import { and, eq, isNull, isNotNull, lte } from 'drizzle-orm';
import {
  postponeNextBillingByOneMonth,
  WITHDRAWAL_PERIOD_DAYS,
} from '@/services/referral-reward.service';

/**
 * GET /api/cron/referral-rewards
 *
 * Attribue l'avantage de parrainage (CDC tarification §13) :
 * un mois offert au parrain et au filleul, lorsque le filleul — nouveau
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
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const now = new Date();
  const cutoff = new Date(now.getTime() - WITHDRAWAL_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  const result = { examined: 0, granted: 0, skipped: 0, errors: 0 };

  try {
    // Evenements factures, delai de retractation ecoule, avantage non encore accorde.
    const pending = await db
      .select({
        id: referralEvents.id,
        referrerAccountId: referralEvents.referrerAccountId,
        referredAccountId: referralEvents.referredAccountId,
        firstBilledAt: referralEvents.firstBilledAt,
      })
      .from(referralEvents)
      .where(
        and(
          isNotNull(referralEvents.firstBilledAt),
          lte(referralEvents.firstBilledAt, cutoff),
          isNull(referralEvents.rewardedAt),
        ),
      );

    result.examined = pending.length;

    for (const event of pending) {
      try {
        // Condition CDC : le filleul doit avoir souscrit une offre ANNUELLE.
        const [referredSub] = await db
          .select({ billingPeriod: accountSubscriptions.billingPeriod })
          .from(accountSubscriptions)
          .where(eq(accountSubscriptions.accountId, event.referredAccountId))
          .limit(1);

        if (referredSub?.billingPeriod !== 'yearly') {
          result.skipped++;
          continue;
        }

        // Un mois offert a chacun des deux comptes.
        const [referred, referrer] = await Promise.all([
          postponeNextBillingByOneMonth(event.referredAccountId, now),
          postponeNextBillingByOneMonth(event.referrerAccountId, now),
        ]);

        if (!referred.granted && !referrer.granted) {
          result.skipped++;
          continue;
        }

        await db
          .update(referralEvents)
          .set({ status: 'reward_granted', rewardedAt: now, updatedAt: now })
          .where(eq(referralEvents.id, event.id));

        result.granted++;
        console.info(
          `[cron/referral-rewards] avantage accorde — evenement ${event.id}`,
          `filleul: ${referred.granted ? 'ok' : referred.reason}`,
          `parrain: ${referrer.granted ? 'ok' : referrer.reason}`,
        );
      } catch (error) {
        result.errors++;
        console.error(`[cron/referral-rewards] echec sur l'evenement ${event.id}:`, error);
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
