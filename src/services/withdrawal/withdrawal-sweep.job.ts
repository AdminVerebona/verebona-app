/**
 * Balayage des rétractations — CDC 6 §10 et §21.
 *
 * Traitement partagé par GET /api/cron/withdrawal/process et la tâche
 * planifiée interne `withdrawal-process` (lot 25).
 *
 *   · `received`   — confirmées mais jamais traitées (traitement Stripe
 *                    différé, §7.4) ;
 *   · `failed`     — reprise automatique (§10) ;
 *   · `processing` — traitement interrompu.
 *
 * ── UN SEUL BALAYAGE À LA FOIS ───────────────────────────────────────────
 * `processWithdrawal` est idempotent côté Stripe (clés d'idempotence), mais
 * deux balayages simultanés journaliseraient deux fois les mêmes étapes et
 * feraient deux appels Stripe par demande. Le bail en base `withdrawal-sweep`
 * est pris par la route ET par la tâche interne : un appel externe pendant
 * le passage interne est refusé (`null`), jamais exécuté en parallèle.
 */
import { and, inArray, lt } from 'drizzle-orm';
import { db } from '@/db';
import { withdrawalRequests } from '@/db/schema';
import { withJobLockOrSkip } from '@/lib/job-lock';
import { innerLockTtlMs, WITHDRAWAL_SWEEP_TIMEOUT_MS } from '@/services/scheduling/task-timeouts';
import { processWithdrawal } from './withdrawal-processor.service';

/** Au-delà, une demande non traitée est une anomalie (§21). */
export const WITHDRAWAL_STALE_HOURS = 24;
export const WITHDRAWAL_SWEEP_LOCK = 'withdrawal-sweep';
/** Couvre la durée maximale d'une exécution planifiée (2 × délai + marge). */
export const WITHDRAWAL_SWEEP_LOCK_TTL_MS = innerLockTtlMs(WITHDRAWAL_SWEEP_TIMEOUT_MS);

/**
 * `null` : un autre balayage détient le bail. Une erreur d'acquisition (base
 * indisponible) est LEVÉE, jamais confondue avec un passage ignoré.
 */
export async function runWithdrawalSweep(now: Date = new Date()) {
  return withJobLockOrSkip(WITHDRAWAL_SWEEP_LOCK, WITHDRAWAL_SWEEP_LOCK_TTL_MS, async () => {
    const pending = await db
      .select({
        publicReference: withdrawalRequests.publicReference,
        status: withdrawalRequests.status,
        requestedAt: withdrawalRequests.requestedAt,
      })
      .from(withdrawalRequests)
      .where(inArray(withdrawalRequests.status, ['received', 'failed', 'processing']))
      .limit(50);

    const outcome = { completed: 0, processing: 0, failed: 0, skipped: 0 };
    const failures: Array<{ reference: string; code?: string }> = [];

    for (const item of pending) {
      const result = await processWithdrawal(item.publicReference, { now });
      if (result.status === 'completed') outcome.completed += 1;
      else if (result.status === 'processing') outcome.processing += 1;
      else if (result.status === 'failed') {
        outcome.failed += 1;
        failures.push({ reference: item.publicReference, code: result.failureCode });
      } else outcome.skipped += 1;
    }

    // Demandes anciennes toujours non réglées : anomalie du §21.
    const staleThreshold = new Date(now.getTime() - WITHDRAWAL_STALE_HOURS * 3600 * 1000);
    const stale = await db
      .select({
        publicReference: withdrawalRequests.publicReference,
        requestedAt: withdrawalRequests.requestedAt,
        status: withdrawalRequests.status,
      })
      .from(withdrawalRequests)
      .where(
        and(
          inArray(withdrawalRequests.status, ['received', 'failed', 'processing']),
          lt(withdrawalRequests.requestedAt, staleThreshold),
        ),
      );

    return { processed: pending.length, outcome, failures, stale };
  });
}

export type WithdrawalSweepResult = NonNullable<Awaited<ReturnType<typeof runWithdrawalSweep>>>;
