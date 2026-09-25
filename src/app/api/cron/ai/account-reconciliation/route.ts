/**
 * GET /api/cron/ai/account-reconciliation — T3 planifié et événementiel.
 *
 *   1. demandes événementielles arrivées à échéance (temporisées, fusionnées) ;
 *   2. comptes dont la dernière exécution T3 date de plus de
 *      T3_ACCOUNT_RECONCILIATION_INTERVAL_HOURS (24 h par défaut).
 *
 * Rejoue la cohérence à partir des connaissances déjà persistées — ne
 * réanalyse aucun document. Protégée par CRON_SECRET. Fréquence conseillée :
 * toutes les 15 minutes (les exécutions planifiées restent bornées par
 * l'intervalle).
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureMigrations } from '@/db';
import {
  processDueAccountReconciliations,
  runScheduledAccountReconciliations,
} from '@/services/ai/reconciliation/account-reconciliation.service';

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }
  await ensureMigrations();
  try {
    const events = await processDueAccountReconciliations();
    const scheduled = await runScheduledAccountReconciliations();
    const resume = (l: typeof events) => l.map((r) => ({ runId: r.runId, accountId: r.accountId, status: r.status, examined: r.objectsExamined, errors: r.errors }));
    return NextResponse.json({ ok: true, events: resume(events), scheduled: resume(scheduled) });
  } catch (e) {
    console.error('[cron/t3] échec :', (e as Error).message);
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
