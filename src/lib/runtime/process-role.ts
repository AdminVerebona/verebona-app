/**
 * Rôle du processus — lot 109H (mémoire du conteneur web Scalingo).
 *
 * Deux types de processus dans le Procfile (`scripts/start-server.mjs`) :
 *   · `web`    reçoit le trafic HTTP ;
 *   · `worker` ne reçoit aucun trafic (0 conteneur tant que le PO ne le
 *              dimensionne pas dans Scalingo).
 *
 * `BACKGROUND_JOBS_PROCESS` dit où tournent les traitements de fond
 * (planificateurs, files de jobs, rendu PDF, diagnostics, sauvegarde) :
 *   · `web` (DÉFAUT) — dans le conteneur web, exactement comme avant ;
 *   · `worker`       — dans le conteneur worker seulement ; le web ne sert
 *                      plus que les requêtes (et réveille le worker par la base).
 *
 * Le type vient de `APP_PROCESS_TYPE` (posé par le lanceur), sinon de
 * `CONTAINER` (web-1, worker-1… posé par Scalingo), sinon `web`. Même règle
 * de lecture que `jobsPlacement` du lanceur (test de concordance).
 *
 * Les ABONNEMENTS aux événements (réconciliation, agenda, cohérence…) restent
 * câblés dans tous les processus : ils réagissent à ce qui se passe dans le
 * processus qui les émet (requête web ou traitement de fond).
 *
 * Lot 113Q (#714) — PROCESSUS DÉDIÉ AUX DIAGNOSTICS BO : troisième type
 * `diagworker` (0 conteneur tant que le PO ne le dimensionne pas). Avec
 * `DIAG_JOB_PROCESS=diagworker`, SEUL ce processus prend les diagnostics
 * (aucun planificateur, aucune file IA, aucun rendu PDF à côté : sa mémoire
 * mesurée est celle de l'export) ; web et worker n'en prennent plus. Sans la
 * variable (défaut), les diagnostics suivent les traitements de fond comme
 * avant. Le type `diagworker` n'exécute jamais les autres traitements.
 */

export type ProcessType = 'web' | 'worker' | 'diagworker';
export type JobsPlacement = 'web' | 'worker';

type Env = Record<string, string | undefined>;

export function processType(env: Env = process.env): ProcessType {
  const explicit = (env.APP_PROCESS_TYPE ?? '').trim().toLowerCase();
  if (explicit === 'web' || explicit === 'worker' || explicit === 'diagworker') return explicit;
  const container = (env.CONTAINER ?? '').trim().toLowerCase();
  if (/^worker(-|$)/.test(container)) return 'worker';
  if (/^diagworker(-|$)/.test(container)) return 'diagworker';
  return 'web';
}

export function jobsPlacement(env: Env = process.env): JobsPlacement {
  const raw = (env.BACKGROUND_JOBS_PROCESS ?? '').trim().toLowerCase();
  return raw === 'worker' ? 'worker' : 'web';
}

/** Ce processus exécute-t-il les traitements de fond ? */
export function runsBackgroundJobs(env: Env = process.env): boolean {
  return jobsPlacement(env) === processType(env);
}

/** Lot 113Q : où tournent les diagnostics BO — processus dédié (`diagworker`) ou avec les traitements de fond (défaut). */
export function diagnosticsPlacement(env: Env = process.env): JobsPlacement | 'diagworker' {
  return (env.DIAG_JOB_PROCESS ?? '').trim().toLowerCase() === 'diagworker' ? 'diagworker' : jobsPlacement(env);
}

/** Lot 113Q : ce processus exécute-t-il les diagnostics BO ? */
export function runsDiagnosticJobs(env: Env = process.env): boolean {
  return diagnosticsPlacement(env) === processType(env);
}

/** Résumé journalisable (aucun secret). */
export function processRoleSummary(env: Env = process.env): { process: ProcessType; placement: JobsPlacement; backgroundJobs: boolean; diagnostics: boolean; diagnosticsPlacement: JobsPlacement | 'diagworker'; container: string | null } {
  const container = (env.CONTAINER ?? '').trim();
  return {
    process: processType(env),
    placement: jobsPlacement(env),
    backgroundJobs: runsBackgroundJobs(env),
    diagnostics: runsDiagnosticJobs(env),
    diagnosticsPlacement: diagnosticsPlacement(env),
    container: /^[A-Za-z0-9._-]{1,40}$/.test(container) ? container : null,
  };
}
