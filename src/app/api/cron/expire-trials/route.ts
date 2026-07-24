import { NextResponse } from 'next/server';
import { expireOverdueTrials } from '@/services/trial.service';
import { trackFunnelEvent } from '@/services/funnel-analytics.service';

/**
 * GET /api/cron/expire-trials
 *
 * Bascule en mode restreint (`readonly`) les essais de 7 jours arrives a
 * echeance sans souscription (CDC §3.5).
 *
 * Aucun paiement n'est declenche, aucun compte n'est supprime, aucune donnee
 * n'est perdue : seul le statut d'abonnement change.
 *
 * Protege par CRON_SECRET (header Authorization: Bearer <secret>).
 * Frequence conseillee : toutes les heures.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { expired, accountIds } = await expireOverdueTrials();

    for (const accountId of accountIds) {
      void trackFunnelEvent({ event: 'expired_without_conversion', accountId });
    }

    if (expired > 0) {
      console.info(`[cron/expire-trials] ${expired} essai(s) bascule(s) en mode restreint`);
    }

    return NextResponse.json({
      ok: true,
      expired,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[cron/expire-trials] erreur:', error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
