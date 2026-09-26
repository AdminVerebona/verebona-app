/**
 * Contexte d'une exécution IA — CDC BO IA VER-015, VER-016, WF-05, §9.1
 * (LOG-UI-05, CST-UI-05), GEN-012.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI UN CONTEXTE PORTÉ PAR L'EXÉCUTION, ET PAS UN PARAMÈTRE
 *
 * Une exécution T1 enchaîne plusieurs appels modèle, à plusieurs niveaux de
 * profondeur (pipeline → étapes → passerelle). La configuration était résolue
 * à CHAQUE appel : une activation survenue au milieu d'une analyse changeait
 * de modèle et de préambule en cours de route — ce que le VER-015 interdit
 * (« une activation normale laisse finir les exécutions en cours avec leur
 * ancienne config »).
 *
 * Faire descendre la version épinglée de paramètre en paramètre jusqu'à la
 * passerelle toucherait toutes les signatures du pipeline, et il suffirait
 * d'un oubli pour la perdre. `AsyncLocalStorage` la fait suivre l'exécution
 * sans qu'aucun appelant ait à y penser : la passerelle et la trace la lisent
 * directement.
 *
 * Le même contexte transporte l'identifiant du job (§9.1 : l'appel est
 * rattaché à son exécution parente) — jusqu'ici jamais transmis.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * VERSION AFFECTÉE AU DÉMARRAGE, PAS À LA MISE EN FILE (VER-016)
 *
 * Le boucleur résout la version effective au moment où il prélève le job, et
 * l'écrit dans `ai_job_queue.config_version_id`. Un job en attente pendant une
 * activation démarre donc avec la nouvelle Active ; un job déjà démarré garde
 * celle de son démarrage.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Treatment } from '../config/treatments';

export interface AiJobContext {
  /** Job de `ai_job_queue` à l'origine des appels, s'il y en a un. */
  jobId: number | null;
  treatment: Treatment | null;
  /**
   * Version de configuration figée pour toute l'exécution. `null` = aucune
   * version effective au démarrage : la configuration du code s'applique, et
   * elle ne change pas non plus en cours d'exécution.
   */
  configVersionId: number | null;
  /** Signal d'interruption de l'exécution (timeout global, annulation). */
  signal?: AbortSignal;
  /**
   * Instant de démarrage de l'exécution (ms epoch). MOD-011 / OPS-023 : sous
   * disjoncteur, une exécution DÉJÀ démarrée termine ; la garde de la
   * passerelle (runnable-guard) compare cet instant à `suspended_at` pour
   * laisser passer ses appels, et seulement les siens.
   */
  startedAt?: number;
}

const storage = new AsyncLocalStorage<AiJobContext>();

/** Exécute `fn` dans le contexte donné ; tous les appels qu'il déclenche en héritent. */
export function runInJobContext<T>(ctx: AiJobContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

/** Contexte courant, ou `null` hors exécution (appel synchrone T2, T5, T6). */
export function currentJobContext(): AiJobContext | null {
  return storage.getStore() ?? null;
}

/**
 * Timeout global d'exécution par traitement — GEN-012.
 *
 * Distinct du timeout PAR APPEL (`op.timeoutMs`, dans le référentiel) : un
 * pipeline T1 peut enchaîner dix appels chacun sous leur limite et durer
 * pourtant une heure. L'attente en file est exclue : le chronomètre part au
 * prélèvement. Constantes du code (GEN-012 ne les rend pas administrables).
 *
 * Choisies larges : elles bornent une exécution emballée, elles ne doivent
 * jamais couper une exécution normale. T3 parcourt tous les biens d'un compte.
 */
export const EXECUTION_TIMEOUT_MS: Readonly<Record<'T1' | 'T3' | 'T4', number>> = {
  T1: 15 * 60_000,
  T3: 30 * 60_000,
  T4: 10 * 60_000,
};

export function executionTimeoutMs(treatment: Treatment): number | null {
  return (EXECUTION_TIMEOUT_MS as Record<string, number>)[treatment] ?? null;
}
