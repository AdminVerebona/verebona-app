/**
 * Lot 102A — tâche planifiée `account-lifecycle` (horaire, catalogue des
 * tâches internes) : cycle de vie des comptes.
 *
 *   1. suppressions DEMANDÉES arrivées à échéance : exécutées au plus tôt
 *      (balayage existant `runAccountDeletionSweepExclusive`, limité à ce
 *      motif, même verrou que la tâche quotidienne et la route ; mode
 *      ACCOUNT_DELETION_SWEEP respecté, `off` : rien) ;
 *   2. anomalies de Supervision : purge en retard, plafond technique de la
 *      suppression demandée dépassé (résolues automatiquement ensuite) ;
 *   3. rotation du registre de rejeu (au-delà des sauvegardes restaurables).
 *
 * Idempotente et rejouable : chaque étape l'est.
 */
import { accountDeletionSweepMode, sweepOptionsFor } from './account-deletion.rules';

export interface AccountLifecycleRunResult {
  sweep: 'done' | 'busy' | 'off';
  executed: number;
  failed: number;
  anomalies: { overdue: number; voluntaryOverCeiling: number } | null;
  registryPurged: number;
}

export async function runAccountLifecycleTask(now: Date = new Date()): Promise<AccountLifecycleRunResult> {
  const out: AccountLifecycleRunResult = { sweep: 'off', executed: 0, failed: 0, anomalies: null, registryPurged: 0 };

  const mode = accountDeletionSweepMode();
  if (mode !== 'off') {
    const { runAccountDeletionSweepExclusive } = await import('./voluntary-deletion.service');
    const r = await runAccountDeletionSweepExclusive({ ...sweepOptionsFor(mode), now, voluntaryOnly: true });
    if (!r) out.sweep = 'busy';
    else {
      out.sweep = 'done';
      out.executed = r.deletions.executed;
      out.failed = r.deletions.failed;
    }
  }

  try {
    const { reportLifecycleAnomalies } = await import('./restricted-state.service');
    out.anomalies = await reportLifecycleAnomalies(now);
  } catch (e) {
    console.error('[account-lifecycle] supervision :', (e as Error).message);
  }

  try {
    const { purgeDeletionRegistry } = await import('./deletion-registry.service');
    out.registryPurged = await purgeDeletionRegistry(now);
  } catch (e) {
    console.error('[account-lifecycle] rotation du registre :', (e as Error).message);
  }
  return out;
}
