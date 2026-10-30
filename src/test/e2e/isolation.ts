/**
 * Lot 100A — isolation et reproductibilité de la série E2E (parties pures,
 * testées sans base dans `__tests__/harness.test.ts`).
 *
 * Tous les fichiers de scénarios s'exécutent dans UN processus (fork unique,
 * `vitest.e2e.config.ts`) : le registre de modules est remis à zéro entre
 * fichiers, mais pas `process.env`, ni l'ordre d'exécution, qui dépendait du
 * cache de vitest (fichiers en échec et plus longs d'abord, cache partagé
 * entre copies de travail) — deux exécutions consécutives ne passaient pas
 * les fichiers dans le même ordre.
 */

/** Variables posées par vitest lui-même : jamais remises à l'état d'origine. */
const PROPRES_A_VITEST = /^(VITEST|__VITEST)/;

/**
 * Remet `env` dans l'état `origine` : variables ajoutées depuis supprimées,
 * variables modifiées ou supprimées rétablies. Rend les noms touchés (pur sur
 * ses arguments).
 */
export function restoreProcessEnv(env: NodeJS.ProcessEnv, origine: Readonly<Record<string, string | undefined>>): string[] {
  const touchees: string[] = [];
  for (const k of Object.keys(env)) {
    if (PROPRES_A_VITEST.test(k)) continue;
    if (!(k in origine) || origine[k] === undefined) {
      delete env[k];
      touchees.push(k);
    }
  }
  for (const [k, v] of Object.entries(origine)) {
    if (PROPRES_A_VITEST.test(k) || v === undefined) continue;
    if (env[k] !== v) {
      env[k] = v;
      touchees.push(k);
    }
  }
  return touchees.sort();
}

/**
 * Ordre d'exécution stable : chemin du fichier, ordre alphabétique (pur).
 * Indépendant du cache des résultats précédents et de la machine.
 */
export function stableOrder<T extends { moduleId: string }>(files: readonly T[]): T[] {
  return [...files].sort((a, b) => (a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : 0));
}
