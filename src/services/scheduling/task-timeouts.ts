/**
 * Délais des tâches planifiées qui portent AUSSI un verrou interne partagé
 * avec leur route `/api/cron/*` — source unique (lot 25, revue I2).
 *
 * Le moteur (`scheduled-task-runner.ts`) considère une exécution vivante au
 * plus `2 × délai` après son début (renouvellement du bail plafonné). Le
 * verrou interne (`job_locks`) doit couvrir au moins cette durée : sinon une
 * route externe ou un appel manuel pourrait lancer un second balayage pendant
 * qu'un premier, en dépassement, tourne encore. D'où `ttl = 2 × délai + marge`.
 *
 * Module pur : importé par le catalogue (sans base) et par les traitements.
 */
const MIN = 60_000;
const MARGE_MS = 2 * MIN;

export const TO_PROCESS_SCAN_TIMEOUT_MS = 12 * MIN;
export const WITHDRAWAL_SWEEP_TIMEOUT_MS = 15 * MIN;
export const T3_LEGACY_TRANSFER_TIMEOUT_MS = 10 * MIN;

/** Durée de vie du verrou interne d'une tâche de délai `timeoutMs`. */
export function innerLockTtlMs(timeoutMs: number): number {
  return 2 * timeoutMs + MARGE_MS;
}
