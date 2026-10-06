import { NextResponse } from 'next/server';
import { runTrialExpiry } from '@/services/trial-expiry.job';

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
 * Lot 25 : planifiee DANS l'application (tache interne `expire-trials`,
 * horaire) ; cette route ne sert plus qu'au declenchement manuel. Double
 * passage sans effet (bascule atomique, notification dedupliquee).
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  // Secret non configuré : refus. Sans ce garde, l'en-tête littéral
  // « Bearer undefined » suffisait à déclencher la tâche.
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { expired } = await runTrialExpiry();

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
