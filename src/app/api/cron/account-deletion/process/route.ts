/**
 * GET /api/cron/account-deletion/process — CDC rétractation §13.3 et §21.
 *
 * Balayage quotidien : rappels à sept jours et vingt-quatre heures, puis
 * exécution des échéances atteintes.
 *
 * Répond **409** dès qu'une suppression est en retard de plus de vingt-quatre
 * heures. Le §21 fait de « la suppression de données non exécutée à
 * l'échéance » une anomalie à détecter : sans ce signal, un travail planifié
 * en panne resterait invisible jusqu'au jour où il faudrait justifier la
 * suppression.
 *
 * `?dryRun=1` simule sans rien écrire. À utiliser au premier passage en
 * production.
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureMigrations } from '@/db';
import {
  listDueReminders,
  listDueDeletions,
  listOverdueDeletions,
  markReminderSent,
  executeScheduledDeletion,
} from '@/services/account/scheduled-deletion.service';

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  await ensureMigrations();

  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1';
  const now = new Date();

  // ── Rappels ─────────────────────────────────────────────────────────────
  const reminders = await listDueReminders(now);
  const sent = { j7: 0, j1: 0 };

  for (const [which, items] of [['j7', reminders.j7], ['j1', reminders.j1]] as const) {
    for (const item of items) {
      if (!dryRun) {
        // L'envoi effectif est branché au lot rétractation, qui apporte les
        // modèles de courriel. Le compte à rebours est marqué dès à présent
        // pour que la mécanique de balayage soit vérifiable seule.
        await markReminderSent(item.id, which, now);
      }
      sent[which] += 1;
    }
  }

  // ── Exécutions ──────────────────────────────────────────────────────────
  const due = await listDueDeletions(now);
  const results = { executed: 0, skipped: 0, failed: 0 as number };
  const failures: Array<{ accountId: number; reason?: string }> = [];

  for (const item of due) {
    const result = await executeScheduledDeletion(item.id, { dryRun, now });
    if (result.status === 'executed') results.executed += 1;
    else if (result.status === 'failed') {
      results.failed += 1;
      failures.push({ accountId: item.accountId, reason: result.reason });
    } else results.skipped += 1;
  }

  const overdue = await listOverdueDeletions(now);

  return NextResponse.json(
    {
      dryRun,
      reminders: sent,
      deletions: results,
      failures,
      overdue: overdue.map((o) => ({
        accountId: o.accountId,
        scheduledAt: o.scheduledAt,
      })),
    },
    { status: overdue.length > 0 || results.failed > 0 ? 409 : 200 },
  );
}
