/**
 * Transfert unique de l'ancienne file T3 vers la file durable (lot 25).
 *
 * Les demandes restées au statut `queued` dans `account_reconciliation_runs`
 * au déploiement sont transférées par `processDueAccountReconciliations`.
 * Ce transfert était déclenché « une seule fois après le déploiement » par un
 * appel manuel de `/api/cron/ai/account-reconciliation` : il est désormais
 * lancé AU DÉMARRAGE par la tâche interne `t3-legacy-transfer`, puis
 * seulement tant que des lignes `queued` subsistent (transfert partiel).
 *
 * ── IDEMPOTENT ET EXCLUSIF ───────────────────────────────────────────────
 * Une ligne n'est supprimée qu'après son transfert acquitté, et la file
 * durable fusionne les demandes d'un même compte. Mais deux transferts
 * SIMULTANÉS (deux conteneurs au démarrage, ou la route appelée pendant la
 * tâche) liraient les mêmes lignes et ajouteraient deux fois leurs
 * événements au même job : le bail en base `t3-legacy-transfer` est pris par
 * la tâche ET par la route. Sans ligne `queued`, rien n'est écrit.
 */
import { pgClient } from '@/db';
import { withJobLockOrSkip } from '@/lib/job-lock';
import { innerLockTtlMs, T3_LEGACY_TRANSFER_TIMEOUT_MS } from '@/services/scheduling/task-timeouts';
import { processDueAccountReconciliations } from './account-reconciliation.service';

export const T3_LEGACY_TRANSFER_LOCK = 't3-legacy-transfer';
/** Couvre la durée maximale d'une exécution planifiée (2 × délai + marge). */
export const T3_LEGACY_TRANSFER_LOCK_TTL_MS = innerLockTtlMs(T3_LEGACY_TRANSFER_TIMEOUT_MS);

/** Demandes encore au statut `queued` dans l'ancienne file (index partiel). */
export async function countLegacyQueuedT3(): Promise<number> {
  const rows = (await pgClient.unsafe(
    `SELECT count(*)::int AS n FROM account_reconciliation_runs WHERE status = 'queued'`,
  )) as unknown as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

export interface LegacyTransferResult {
  /** Demandes trouvées avant le transfert. */
  before: number;
  /** Demandes restantes après (échecs de transfert, ou plus de 200). */
  remaining: number;
}

/**
 * `null` : un autre transfert détient le bail. Une erreur d'acquisition (base
 * indisponible) est LEVÉE, jamais confondue avec un passage ignoré.
 */
export async function transferLegacyT3Queue(): Promise<LegacyTransferResult | null> {
  return withJobLockOrSkip(T3_LEGACY_TRANSFER_LOCK, T3_LEGACY_TRANSFER_LOCK_TTL_MS, async () => {
    const before = await countLegacyQueuedT3();
    if (before === 0) return { before: 0, remaining: 0 };
    await processDueAccountReconciliations();
    return { before, remaining: await countLegacyQueuedT3() };
  });
}
