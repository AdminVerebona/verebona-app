/**
 * Démarrage du harnais E2E (vitest `globalSetup`) — CDC 15 T2-41, D-07.
 *
 * Une base MODÈLE par exécution, construite une seule fois depuis le schéma
 * Drizzle puis les migrations SQL (`db-bootstrap.ts`). Sans URL de serveur
 * PostgreSQL : échec explicite, avec la marche à suivre — un harnais qui se
 * sauterait en silence donnerait une CI verte sans rien avoir vérifié.
 *
 * Lot 100A — isolation par fichier. Chaque fichier de scénarios reçoit SA
 * base, copie du modèle (`CREATE DATABASE … TEMPLATE`, moins d'une seconde),
 * créée par `setup.ts` avant tout import de `@/db` et supprimée à la fin du
 * fichier suivant (écritures sans attente encore en vol : jamais coupées). Avant, les 270 fichiers partageaient une base : les balayages,
 * reprises, exports et diagnostics « tous comptes » d'un fichier voyaient les
 * données, les travaux en file et les compteurs de tous les fichiers
 * précédents (7 à 13 fichiers rouges selon l'ordre, verts seuls).
 *
 * `E2E_SHARED_DB=1` rétablit l'ancien fonctionnement (une base commune,
 * copie du modèle) — pour reproduire un ancien échec, jamais en CI.
 */
import type { TestProject } from 'vitest/node';
import {
  adminUrlFromEnv, bootstrapE2eDatabase, cloneE2eDatabase, derivedDatabaseName, dropE2eDatabase, dropE2eDatabasesWithPrefix,
} from './db-bootstrap';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Base commune de l'exécution (mode `E2E_SHARED_DB=1`, et repli). */
    e2eDatabaseUrl: string;
    /** Base modèle (jamais connectée par les scénarios) : source des bases par fichier. */
    e2eTemplateDatabase: string;
    /** Préfixe des bases par fichier de cette exécution (nettoyage final). */
    e2eRunPrefix: string;
  }
}

export default async function setup(project: TestProject) {
  const adminUrl = adminUrlFromEnv();
  if (!adminUrl) {
    throw new Error(
      '[e2e] E2E_DATABASE_URL absente : la définir vers un serveur PostgreSQL JETABLE et LOCAL, par exemple '
      + 'postgres://postgres:postgres@127.0.0.1:5432/postgres (DATABASE_URL n\'est jamais utilisée). Le harnais '
      + 'y crée puis supprime ses propres bases (verebona_e2e_*). Serveur distant : E2E_ALLOW_REMOTE=1. '
      + 'Voir src/test/e2e/scenario.ts.',
    );
  }
  const prefix = `verebona_e2e_${Date.now()}_${process.pid}`;
  const template = derivedDatabaseName(prefix, 'modele');
  const t0 = Date.now();
  await bootstrapE2eDatabase({ adminUrl, database: template, log: (m) => console.info(m) });
  const shared = derivedDatabaseName(prefix, 'commune');
  const sharedUrl = await cloneE2eDatabase({ adminUrl, template, database: shared });
  console.info(`[e2e] base modèle ${template} prête en ${Math.round((Date.now() - t0) / 1000)} s ; `
    + (process.env.E2E_SHARED_DB === '1' ? 'base COMMUNE à tous les fichiers (E2E_SHARED_DB=1)' : 'une base par fichier (copie du modèle)'));
  project.provide('e2eDatabaseUrl', sharedUrl);
  project.provide('e2eTemplateDatabase', template);
  project.provide('e2eRunPrefix', derivedDatabaseName(prefix, 'f'));
  return async () => {
    if (process.env.E2E_KEEP_DB !== '1') {
      // Bases par fichier restées orphelines (fichier interrompu, minuteur…) : jamais laissées sur le serveur.
      await dropE2eDatabasesWithPrefix(adminUrl, derivedDatabaseName(prefix, 'f')).catch(() => undefined);
    }
    await dropE2eDatabase(adminUrl, shared);
    await dropE2eDatabase(adminUrl, template);
  };
}
