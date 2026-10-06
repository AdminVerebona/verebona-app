import { NextResponse } from 'next/server';
import { runReferralRewards } from '@/services/referral/referral-rewards.job';

/**
 * GET /api/cron/referral-rewards
 *
 * Attribue l'avantage de parrainage (CDC tarification §13) : un mois offert
 * AU PARRAIN SEUL. Le traitement vit dans `referral-rewards.job.ts`, partagé
 * avec la tâche planifiée interne `referral-rewards` (lot 25, quotidienne) :
 * cette route ne sert plus qu'au déclenchement manuel. Idempotent : un double
 * passage n'accorde jamais deux fois le même avantage.
 *
 * Protégé par CRON_SECRET.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  // Secret non configuré : refus. Sans ce garde, l'en-tête littéral
  // « Bearer undefined » suffisait à déclencher la tâche.
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const now = new Date();
  try {
    const result = await runReferralRewards(now);
    return NextResponse.json({ ok: true, ...result, checkedAt: now.toISOString() });
  } catch (error) {
    console.error('[cron/referral-rewards] erreur:', error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
