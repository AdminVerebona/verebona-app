/**
 * GET /api/cron/account-deletion/process — CDC rétractation §13.3 et §21 ;
 * suppression volontaire du compte différée de 30 jours.
 *
 * Même traitement que la tâche interne quotidienne `daily-account-deletion`
 * (`runAccountDeletionSweep`) : rappels (e-mail J-7 pour la suppression
 * volontaire), exécution des échéances atteintes, confirmations finales en
 * attente. Idempotent : un double passage est sans effet.
 *
 * Répond **409** dès qu'une suppression est en retard de plus de vingt-quatre
 * heures ou a échoué. Le §21 fait de « la suppression de données non exécutée
 * à l'échéance » une anomalie à détecter : sans ce signal, un travail planifié
 * en panne resterait invisible jusqu'au jour où il faudrait justifier la
 * suppression.
 *
 * `?dryRun=1` simule sans rien écrire ni envoyer. À utiliser au premier
 * passage en production (équivalent de ACCOUNT_DELETION_SWEEP=dry).
 * L'arriéré (échéances de plus de 7 jours jamais tentées) suit la même règle
 * que la tâche interne : exécuté seulement si ACCOUNT_DELETION_SWEEP=live.
 *
 * Même verrou d'exécution que la tâche interne : un appel pendant un
 * balayage en cours répond 409 LOCKED sans rien faire.
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureMigrations } from '@/db';
import {
  accountDeletionSweepMode,
  runAccountDeletionSweepExclusive,
  sweepOptionsFor,
} from '@/services/account/voluntary-deletion.service';

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  await ensureMigrations();

  const mode = accountDeletionSweepMode();
  const options = sweepOptionsFor(mode === 'off' ? 'safe' : mode);
  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1' || options.dryRun;
  const r = await runAccountDeletionSweepExclusive({ dryRun, includeBacklog: options.includeBacklog });
  if (!r) {
    return NextResponse.json({ error: 'LOCKED', message: 'Un balayage des suppressions est déjà en cours.' }, { status: 409 });
  }

  return NextResponse.json(
    {
      dryRun: r.dryRun,
      reminders: r.reminders,
      deletions: r.deletions,
      failures: r.failures,
      deferred: r.deferred,
      backlog: r.backlog,
      finalEmails: r.finalEmails,
      overdue: r.overdue.map((o) => ({ accountId: o.accountId, scheduledAt: o.scheduledAt })),
    },
    { status: r.overdue.length > 0 || r.deletions.failed > 0 ? 409 : 200 },
  );
}
