/**
 * Balayage de la file « À traiter » (CDC V2.0 §9.2, §10) : production des
 * actions nées d'un état de la base, puis promotion des priorités.
 *
 * Traitement partagé par GET /api/cron/to-process/scan et la tâche planifiée
 * interne `to-process-scan` (lot 25). Même bail en base (`to-process-scan`)
 * pour les deux : un appel externe pendant le passage interne est refusé
 * (`null`), jamais exécuté en parallèle.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { accounts } from '@/db/schema';
import { withJobLockOrSkip } from '@/lib/job-lock';
import { innerLockTtlMs, TO_PROCESS_SCAN_TIMEOUT_MS } from '@/services/scheduling/task-timeouts';
import { closeActionsForDeletedTargets, produceAccountActions } from './producers.service';
import { promoteDueActions } from './priority-scheduler.service';

export const TO_PROCESS_SCAN_LOCK = 'to-process-scan';
/** Couvre la durée maximale d'une exécution planifiée (2 × délai + marge). */
export const TO_PROCESS_SCAN_LOCK_TTL_MS = innerLockTtlMs(TO_PROCESS_SCAN_TIMEOUT_MS);

export interface ToProcessScanResult {
  accounts: number;
  created: number;
  updated: number;
  closed: number;
  promoted: number;
  demoted: number;
  refused: number;
}

/**
 * `null` : un autre passage détient le bail. Une erreur d'acquisition (base
 * indisponible) est LEVÉE, jamais confondue avec un passage ignoré.
 */
export async function runToProcessFullScan(
  opts: { accountId?: number; limit?: number } = {},
): Promise<ToProcessScanResult | null> {
  const limit = opts.limit ?? 500;
  return withJobLockOrSkip(TO_PROCESS_SCAN_LOCK, TO_PROCESS_SCAN_LOCK_TTL_MS, async () => {
    const cibles = opts.accountId
      ? await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, opts.accountId))
      : await db.select({ id: accounts.id }).from(accounts).limit(limit);

    const totaux = { created: 0, updated: 0, closed: 0, promoted: 0, demoted: 0, refused: 0 };

    for (const compte of cibles) {
      try {
        const production = await produceAccountActions(compte.id);
        totaux.created += production.created;
        totaux.updated += production.updated;
        totaux.closed += production.closed;
        totaux.closed += await closeActionsForDeletedTargets(compte.id);

        const promotion = await promoteDueActions(compte.id);
        totaux.promoted += promotion.promoted;
        totaux.demoted += promotion.demoted;
        totaux.refused += promotion.refused;
      } catch (e) {
        // Un compte en échec ne doit pas arrêter le balayage des autres : le
        // passage suivant le rattrapera.
        console.error('[to-process-scan] compte', compte.id, (e as Error).message);
      }
    }

    return { accounts: cibles.length, ...totaux };
  });
}
