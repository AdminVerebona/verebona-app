/**
 * Réglages des migrations au démarrage du serveur web (APP-PERF-16).
 *
 * L'étape de référence est la commande de déploiement (`scripts/migrate.mjs`,
 * hook `postdeploy` du Procfile Scalingo) : elle s'exécute une seule fois,
 * avant que la nouvelle version reçoive du trafic, et un échec critique fait
 * échouer le déploiement. Le démarrage web n'est qu'un filet :
 *
 *   MIGRATIONS_ON_BOOT
 *     run   (défaut) applique ce qui manque, sous le même verrou
 *           inter-processus — sans rien à faire, une seule lecture ;
 *     check lecture seule : aucune DDL depuis un conteneur web ;
 *     off   rien au démarrage (la readiness relit l'état à la demande).
 *   MIGRATIONS_BOOT_POLICY
 *     block    (défaut) une migration CRITIQUE manquante fait échouer le
 *              démarrage : la version n'est pas mise en service (CA-01) ;
 *     degraded démarre quand même (gestion d'incident), readiness à 503.
 *   MIGRATIONS_REPAIR_ON_BOOT   true : réparation des index invalides aussi
 *                               au démarrage (défaut false — étape de déploiement).
 *   MIGRATION_LOCK_WAIT_MS      attente du verrou de l'exécutant (défaut 30000).
 *   MIGRATION_LOCK_TIMEOUT      lock_timeout de chaque instruction (défaut 10s).
 *   MIGRATION_STATEMENT_TIMEOUT statement_timeout (défaut 0 : aucun).
 *
 * Valeur invalide : erreur explicite, jamais un défaut deviné en silence.
 */
import { MIGRATION_DEFAULT_LOCK_TIMEOUT, isPgDuration } from '@/db/migration-index';

export type MigrationBootMode = 'run' | 'check' | 'off';
export type MigrationBootPolicy = 'block' | 'degraded';

export interface MigrationRuntimeConfig {
  mode: MigrationBootMode;
  policy: MigrationBootPolicy;
  repairOnBoot: boolean;
  lockWaitMs: number;
  lockTimeout: string;
  statementTimeout: string;
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

export function resolveMigrationRuntimeConfig(env: Env = process.env): MigrationRuntimeConfig {
  const attente = (env.MIGRATION_LOCK_WAIT_MS ?? '').trim();
  let lockWaitMs = 30_000;
  if (attente) {
    const n = Number(attente);
    if (!Number.isInteger(n) || n < 0 || n > 3_600_000) {
      throw new Error(`[db] MIGRATION_LOCK_WAIT_MS=« ${attente} » invalide (entier de 0 à 3600000).`);
    }
    lockWaitMs = n;
  }
  return {
    mode: choix(env, 'MIGRATIONS_ON_BOOT', ['run', 'check', 'off'] as const, 'run'),
    policy: choix(env, 'MIGRATIONS_BOOT_POLICY', ['block', 'degraded'] as const, 'block'),
    repairOnBoot: choix(env, 'MIGRATIONS_REPAIR_ON_BOOT', ['true', 'false'] as const, 'false') === 'true',
    lockWaitMs,
    lockTimeout: duree(env, 'MIGRATION_LOCK_TIMEOUT', MIGRATION_DEFAULT_LOCK_TIMEOUT),
    statementTimeout: duree(env, 'MIGRATION_STATEMENT_TIMEOUT', '0'),
  };
}
