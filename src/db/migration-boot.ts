/**
 * Décision de démarrage après le passage des migrations (APP-PERF-16, CA-01).
 *
 * Seule la phase `failed` — une migration CRITIQUE manquante alors que ce
 * processus avait la main — fait échouer le démarrage (politique `block`) :
 * même convention que les secrets de signature dans `instrumentation-node`,
 * une mise en service bloquée vaut mieux que des 500 sur colonne absente.
 *
 * Ne bloquent PAS : `degraded` (index optionnel), `waiting` (un autre
 * exécutant a la main), `unknown` (base injoignable : le redémarrage en
 * boucle n'y changerait rien ; la readiness reste à 503), `skipped`.
 */
import type { MigrationStatus } from '@/db';
import { resolveMigrationRuntimeConfig } from '@/db/migration-config';

export class MigrationBootError extends Error {
  readonly code = 'MIGRATION_CRITICAL_FAILED';
}

export function assertMigrationBootPolicy(
  status: Pick<MigrationStatus, 'phase' | 'pendingCritical' | 'firstFailure'>,
  env: Record<string, string | undefined> = process.env,
): void {
  if (status.phase !== 'failed') return;
  const cause = status.firstFailure
    ? `${status.firstFailure.filename} (${status.firstFailure.code ?? 'sans code'}) : ${status.firstFailure.message}`
    : 'cause non rapportée';
  const resume = `${status.pendingCritical.length} migration(s) critique(s) non appliquée(s). Première cause : ${cause}`;
  if (resolveMigrationRuntimeConfig(env).policy === 'degraded') {
    console.error(`[startup] ⚠️ ${resume}. MIGRATIONS_BOOT_POLICY=degraded : démarrage maintenu, readiness à 503.`);
    return;
  }
  throw new MigrationBootError(
    `[startup] ${resume}. Démarrage refusé (MIGRATIONS_BOOT_POLICY=block) : corriger la migration, ` +
    'ou poser MIGRATIONS_BOOT_POLICY=degraded le temps de l\'incident.',
  );
}
