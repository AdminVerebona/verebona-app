/**
 * Réglages des migrations côté serveur web (APP-PERF-16, lot 24b).
 *
 * L'étape de référence est la commande de déploiement (`scripts/migrate.mjs`,
 * hook `postdeploy` du Procfile Scalingo) : elle s'exécute une seule fois,
 * avant que la nouvelle version reçoive du trafic, construit les index et un
 * échec critique fait échouer le déploiement. Le démarrage web n'est qu'un
 * filet, et ne construit JAMAIS d'index CONCURRENTLY (lot 24b) :
 *
 *   MIGRATIONS_ON_BOOT
 *     run   (défaut) applique les fichiers critiques qui manquent, sous le
 *           même verrou inter-processus ; verrou détenu ailleurs (postdeploy)
 *           → attend un schéma critique prêt sans rien appliquer ; index
 *           construits ensuite en arrière-plan ;
 *     check lecture seule : aucune DDL depuis un conteneur web (ni au
 *           démarrage, ni en arrière-plan) ;
 *     off   rien au démarrage (la readiness relit l'état à la demande).
 *   MIGRATIONS_BOOT_POLICY
 *     block    (défaut) une migration CRITIQUE en échec fait échouer le
 *              démarrage : la version n'est pas mise en service (CA-01) ;
 *     degraded démarre quand même (gestion d'incident), readiness à 503.
 *   MIGRATION_BOOT_WAIT_MS      attente maximale, au démarrage, d'un schéma
 *                               critique prêt quand un autre exécutant a la
 *                               main (défaut 900000 = 15 min, la durée d'un
 *                               postdeploy ; 0 = ne pas attendre).
 *   MIGRATION_LOCK_TIMEOUT      lock_timeout de chaque instruction (défaut 10s).
 *   MIGRATION_STATEMENT_TIMEOUT statement_timeout (défaut 0 : aucun).
 *   MIGRATION_INDEX_LOCK_TIMEOUT lock_timeout des constructions CONCURRENTLY de
 *                               la maintenance en arrière-plan (défaut 10min ;
 *                               même variable que le postdeploy).
 *   MIGRATION_INDEX_REBUILD_INTERVAL_MIN  intervalle de la maintenance des
 *                               index en arrière-plan (défaut 30 ; 0 = jamais).
 *
 * Retirée (lot 24b) : MIGRATIONS_REPAIR_ON_BOOT — la réparation est faite par
 * l'étape de déploiement puis par la maintenance en arrière-plan ; ignorée,
 * signalée. MIGRATION_LOCK_WAIT_MS ne concerne plus que `scripts/migrate.mjs`.
 *
 * Valeur invalide : erreur explicite, jamais un défaut deviné en silence.
 */
import {
  MIGRATION_BOOT_WAIT_DEFAULT_MS, MIGRATION_DEFAULT_LOCK_TIMEOUT, MIGRATION_INDEX_LOCK_TIMEOUT_DEPLOY, isPgDuration,
} from '@/db/migration-index';

export type MigrationBootMode = 'run' | 'check' | 'off';
export type MigrationBootPolicy = 'block' | 'degraded';

export interface MigrationRuntimeConfig {
  mode: MigrationBootMode;
  policy: MigrationBootPolicy;
  /** Attente d'un schéma critique prêt quand un autre exécutant a la main (ms). */
  bootWaitMs: number;
  lockTimeout: string;
  statementTimeout: string;
  /** Délai des constructions CONCURRENTLY en arrière-plan. */
  indexLockTimeout: string;
  /** Maintenance des index en arrière-plan : premier passage et intervalle (ms) ; 0 = désactivée. */
  indexMaintenance: { firstDelayMs: number; intervalMs: number; maxIntervalMs: number };
  /** Variables obsolètes posées (à signaler). */
  obsolete: string[];
}

type Env = Record<string, string | undefined>;

function choix<T extends string>(env: Env, nom: string, valeurs: readonly T[], defaut: T): T {
  const brut = (env[nom] ?? '').trim().toLowerCase();
  if (!brut) return defaut;
  if ((valeurs as readonly string[]).includes(brut)) return brut as T;
  throw new Error(`[db] ${nom}=« ${env[nom]} » invalide (attendu : ${valeurs.join(' | ')}).`);
}

function duree(env: Env, nom: string, defaut: string): string {
  const brut = (env[nom] ?? '').trim();
  if (!brut) return defaut;
  if (!isPgDuration(brut)) throw new Error(`[db] ${nom}=« ${brut} » invalide (attendu : 500ms, 10s, 2min, 0).`);
  return brut;
}

function entier(env: Env, nom: string, defaut: number, max: number): number {
  const brut = (env[nom] ?? '').trim();
  if (!brut) return defaut;
  const n = Number(brut);
  if (!/^\d+$/.test(brut) || !Number.isSafeInteger(n) || n > max) {
    throw new Error(`[db] ${nom}=« ${brut} » invalide (entier de 0 à ${max}).`);
  }
  return n;
}

/**
 * Premier passage de la maintenance en arrière-plan. Sur Scalingo (`CONTAINER`
 * posé par la plateforme), le conteneur web démarre AVANT le postdeploy, qui
 * dure au plus 20 min : le premier passage vient après (25 min), quand
 * l'ancienne version — dont les transactions bloquaient les constructions —
 * est arrêtée. Ailleurs (poste local, sans postdeploy) : 15 s.
 */
export function indexMaintenanceFirstDelayMs(env: Env = process.env): number {
  return (env.CONTAINER ?? '').trim() ? 25 * 60_000 : 15_000;
}

export function resolveMigrationRuntimeConfig(env: Env = process.env): MigrationRuntimeConfig {
  const intervalMin = entier(env, 'MIGRATION_INDEX_REBUILD_INTERVAL_MIN', 30, 24 * 60);
  const obsolete: string[] = [];
  if ((env.MIGRATIONS_REPAIR_ON_BOOT ?? '').trim()) obsolete.push('MIGRATIONS_REPAIR_ON_BOOT');
  return {
    mode: choix(env, 'MIGRATIONS_ON_BOOT', ['run', 'check', 'off'] as const, 'run'),
    policy: choix(env, 'MIGRATIONS_BOOT_POLICY', ['block', 'degraded'] as const, 'block'),
    bootWaitMs: entier(env, 'MIGRATION_BOOT_WAIT_MS', MIGRATION_BOOT_WAIT_DEFAULT_MS, 3_600_000),
    lockTimeout: duree(env, 'MIGRATION_LOCK_TIMEOUT', MIGRATION_DEFAULT_LOCK_TIMEOUT),
    statementTimeout: duree(env, 'MIGRATION_STATEMENT_TIMEOUT', '0'),
    indexLockTimeout: duree(env, 'MIGRATION_INDEX_LOCK_TIMEOUT', MIGRATION_INDEX_LOCK_TIMEOUT_DEPLOY),
    indexMaintenance: {
      firstDelayMs: intervalMin === 0 ? 0 : indexMaintenanceFirstDelayMs(env),
      intervalMs: intervalMin * 60_000,
      maxIntervalMs: Math.max(intervalMin * 60_000, 6 * 3_600_000),
    },
    obsolete,
  };
}
