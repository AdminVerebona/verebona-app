/**
 * Contrôle d'annulation des exécutions de la file IA — CDC BO IA WF-06, SCR-08.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * REMETTRE EN PENDING NE SUFFIT PAS
 *
 * Désactivation, arrêt d'urgence et rollback remettaient les RUNNING en
 * PENDING. L'exécution déjà lancée, elle, continuait en mémoire : l'appel IA
 * revenait, ses résultats étaient écrits avec l'ancienne configuration, puis
 * le job passait en DONE — alors qu'une nouvelle exécution le reprenait.
 *
 * Trois verrous, du plus immédiat au plus sûr :
 *
 *   1. un `AbortSignal` par exécution : dans ce processus, l'interruption est
 *      signalée tout de suite (`abortLocalExecutions`) ;
 *   2. le bail (`renewLease`) : une exécution d'une AUTRE instance découvre
 *      au battement suivant qu'elle n'est plus titulaire, et s'arrête ;
 *   3. le jeton d'exécution en base, vérifié par `assertActive()` avant
 *      chaque écriture significative et avant la clôture : aucune écriture ne
 *      peut suivre la révocation, quelle que soit l'instance.
 *
 * ⚠️ Le disjoncteur (circuit breaker) n'utilise PAS ce mécanisme : sous
 * disjoncteur, ce qui tourne termine (MOD-011). Seules les actions explicites
 * d'administration interrompent.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { currentJobContext } from './job-context';

export class ExecutionCancelledError extends Error {
  readonly code = 'EXECUTION_CANCELLED';
  constructor(reason: string) {
    super(`Exécution interrompue : ${reason}`);
    this.name = 'ExecutionCancelledError';
  }
}

/**
 * L'erreur est-elle une INTERRUPTION (et non un échec) ?
 *
 * Deux codes :
 *   · `EXECUTION_CANCELLED` — jeton révoqué, bail perdu, signal local ;
 *   · `AI_BLOCKED` — la garde de la passerelle a refusé l'appel (arrêt
 *     d'urgence, désactivation, suspension). C'est une décision
 *     d'exploitation, pas une défaillance du travail : la traiter en échec
 *     consommait une tentative (MOD-005) et marquait la source
 *     ANALYSIS_FAILED, alors que le travail doit simplement attendre la
 *     réactivation (WF-07 étapes 40-41, WF-08). Revue indépendante lot IA 2.
 *
 * Tous les appelants qui rethrowent une interruption (pipeline T1,
 * réconciliation T3, classification T4) la laissent ainsi remonter jusqu'à la
 * file, qui remet le travail en attente sans compter de tentative.
 *
 * `AI_BLOCKED` n'est une interruption qu'À L'INTÉRIEUR d'une exécution de
 * file (contexte job-context : file durable, file mémoire T1). Hors file
 * (route synchrone, appel T2), il n'y a rien à remettre en attente : les
 * appelants gardent leur repli sans IA (déterministe), comme avant.
 */
export function isExecutionCancelled(e: unknown): boolean {
  if (e instanceof ExecutionCancelledError) return true;
  const code = typeof e === 'object' && e !== null ? (e as { code?: string }).code : undefined;
  if (code === 'EXECUTION_CANCELLED') return true;
  return code === 'AI_BLOCKED' && currentJobContext() !== null;
}

/** Garde transmise à l'exécutant : signal + contrôle avant écriture. */
export interface ExecutionGuard {
  readonly jobId: number;
  readonly executionId: string | null;
  readonly signal: AbortSignal;
  /**
   * Lève `ExecutionCancelledError` si l'exécution a été interrompue ou n'est
   * plus titulaire du job. À appeler avant chaque écriture significative.
   */
  assertActive(stage?: string): Promise<void>;
}

/** Garde neutre, pour les appels hors file (routes, reprises manuelles). */
export const NO_GUARD: ExecutionGuard = {
  jobId: 0,
  executionId: null,
  signal: new AbortController().signal,
  assertActive: async () => {},
};

// ── Exécutions de ce processus ──────────────────────────────────────────────

const locales = new Map<number, AbortController>();

export function registerLocalExecution(jobId: number, controller: AbortController): void {
  locales.set(jobId, controller);
}

export function unregisterLocalExecution(jobId: number, controller: AbortController): void {
  if (locales.get(jobId) === controller) locales.delete(jobId);
}

/** Signale immédiatement l'interruption aux exécutions locales concernées. */
export function abortLocalExecutions(jobIds: number[], reason: string): number {
  let n = 0;
  for (const id of jobIds) {
    const c = locales.get(id);
    if (c && !c.signal.aborted) {
      c.abort(new ExecutionCancelledError(reason));
      n++;
    }
  }
  return n;
}

export function createExecutionGuard(
  job: { id: number; executionId: string | null },
  controller: AbortController,
  isActive: (jobId: number, executionId: string) => Promise<boolean>,
): ExecutionGuard {
  const lever = (stage?: string): never => {
    const raison = controller.signal.reason;
    throw raison instanceof ExecutionCancelledError
      ? raison
      : new ExecutionCancelledError(stage ? `avant « ${stage} »` : 'annulation');
  };
  return {
    jobId: job.id,
    executionId: job.executionId,
    signal: controller.signal,
    async assertActive(stage?: string) {
      if (controller.signal.aborted) lever(stage);
      if (!job.executionId) return;
      if (!(await isActive(job.id, job.executionId))) {
        controller.abort(new ExecutionCancelledError(`exécution révoquée${stage ? ` (avant « ${stage} »)` : ''}`));
        lever(stage);
      }
    },
  };
}
