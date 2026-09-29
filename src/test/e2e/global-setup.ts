/**
 * Démarrage du harnais E2E (vitest `globalSetup`) — CDC 15 T2-41, D-07.
 *
 * Une base neuve par exécution, construite depuis le schéma Drizzle puis les
 * migrations SQL (`db-bootstrap.ts`), transmise aux scénarios par `provide`.
 * Sans URL de serveur PostgreSQL : échec explicite, avec la marche à suivre —
 * un harnais qui se sauterait en silence donnerait une CI verte sans rien
 * avoir vérifié.
 */
import type { TestProject } from 'vitest/node';
import { adminUrlFromEnv, bootstrapE2eDatabase, dropE2eDatabase } from './db-bootstrap';

declare module 'vitest' {
  export interface ProvidedContext {
    e2eDatabaseUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const adminUrl = adminUrlFromEnv();
  if (!adminUrl) {
    throw new Error(
      '[e2e] E2E_DATABASE_URL absente : la définir vers un serveur PostgreSQL JETABLE et LOCAL, par exemple '
      + 'postgres://postgres:postgres@127.0.0.1:5432/postgres (DATABASE_URL n\'est jamais utilisée). Le harnais '
      + 'y crée puis supprime sa propre base (verebona_e2e_*). Serveur distant : E2E_ALLOW_REMOTE=1. '
      + 'Voir src/test/e2e/scenario.ts.',
    );
  }
  const r = await bootstrapE2eDatabase({ adminUrl, log: (m) => console.info(m) });
  project.provide('e2eDatabaseUrl', r.url);
  return async () => {
    await dropE2eDatabase(adminUrl, r.database);
  };
}
