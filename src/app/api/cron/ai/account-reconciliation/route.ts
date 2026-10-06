/**
 * GET /api/cron/ai/account-reconciliation — transfert de l'ancienne file T3.
 *
 * Transfère dans la file durable les demandes restées au statut `queued`
 * dans `account_reconciliation_runs` (transition). La planification T3 est
 * portée par les déclencheurs `schedule_*` de la file durable.
 *
 * Lot 25 : le transfert est lancé AUTOMATIQUEMENT au démarrage (tâche
 * interne `t3-legacy-transfer`, puis tant que des lignes `queued`
 * subsistent). Cette route ne sert plus qu'au déclenchement manuel ; même
 * bail en base que la tâche (`legacy-queue-transfer.ts`) : appelée pendant un
 * transfert en cours, elle répond `{ ok: true, skipped: 'locked' }`.
 * Protégée par CRON_SECRET.
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureMigrations } from '@/db';
import { transferLegacyT3Queue } from '@/services/ai/reconciliation/legacy-queue-transfer';

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }
  await ensureMigrations();
  try {
    const transfer = await transferLegacyT3Queue();
    if (transfer === null) return NextResponse.json({ ok: true, skipped: 'locked' });
    // `events` / `scheduled` : forme historique de la réponse, désormais
    // toujours vide (l'exécution appartient au boucleur de la file durable).
    return NextResponse.json({ ok: true, transfer, events: [], scheduled: [] });
  } catch (e) {
    console.error('[cron/t3] échec :', (e as Error).message);
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
