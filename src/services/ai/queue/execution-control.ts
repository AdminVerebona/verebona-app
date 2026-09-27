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

// ── Exécutions HORS file durable (file mémoire T1, chemin `legacy`) ─────────
//
// La file mémoire n'a pas de ligne dans `ai_job_queue` : `requeueRunning` ne
// la voyait pas, et un rollback laissait l'analyse en cours écrire ses
// résultats avec la configuration abandonnée (audit final BO IA, ligne 1 —
// VER-017, WF-06). Elle s'enregistre donc ici, par traitement, et
// `requeueRunning` l'interrompt comme une exécution durable locale.
//
// ⚠️ Limite assumée : ce registre est propre au processus. Une file mémoire
// sur une AUTRE instance n'est pas interrompue par la commande reçue ici ;
// elle le sera au prochain appel modèle si l'IA est coupée (garde de la
// passerelle), mais pas par un rollback. C'est l'une des raisons de basculer
// sur la file durable (`AI_DURABLE_QUEUE=enabled`), où le jeton en base
// couvre toutes les instances.

const horsFile = new Map<string, Set<AbortController>>();

/** Enregistre une exécution hors file ; rend la fonction de désinscription. */
export function registerMemoryExecution(treatment: string, controller: AbortController): () => void {
  let set = horsFile.get(treatment);
  if (!set) { set = new Set(); horsFile.set(treatment, set); }
  set.add(controller);
  return () => { horsFile.get(treatment)?.delete(controller); };
}

/** Interrompt les exécutions hors file d'un traitement, dans ce processus. */
export function abortMemoryExecutions(treatment: string, reason: string): number {
  let n = 0;
  for (const c of horsFile.get(treatment) ?? []) {
    if (!c.signal.aborted) {
      c.abort(new ExecutionCancelledError(reason));
      n++;
    }
  }
  return n;
}

/** Nombre d'exécutions hors file en cours (diagnostic, tests). */
export function countMemoryExecutions(treatment: string): number {
  return horsFile.get(treatment)?.size ?? 0;
}

/**
 * Attend la fin RÉELLE d'une exécution dont le délai global est dépassé, au
 * plus `maxMs`. Rend `true` si elle s'est terminée (succès ou erreur).
 *
 * Revue lot 3 : couper le chronomètre ne coupe pas le travail. Le moteur
 * historique T1 (`AI_UNIFIED_SOURCE_ANALYSIS=legacy`) ne connaît pas la garde
 * et continue d'écrire ; libérer tout de suite le job (ou la place de la file
 * mémoire) laissait une seconde exécution démarrer pendant que la première
 * tournait encore — double analyse, échéances et liens dupliqués. Le délai
 * dépassé déclenche donc l'interruption (signal, garde), puis on ATTEND que
 * l'exécution se termine vraiment avant de la déclarer en échec. La borne
 * `maxMs` ne sert qu'à ne pas immobiliser indéfiniment une exécution bloquée
 * (les appels modèle ont chacun leur propre timeout).
 */
export async function waitForSettlement(p: Promise<unknown>, maxMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fini = p.then(() => true, () => true);
  const borne = new Promise<boolean>((r) => {
    timer = setTimeout(() => r(false), Math.max(0, maxMs));
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([fini, borne]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
