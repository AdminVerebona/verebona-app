/**
 * Scénarios E2E du corpus CDC 15 §15 — socle commun (T2-41, DOD-20).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LANCER LE HARNAIS EN LOCAL
 *
 *   # un PostgreSQL 16 JETABLE (le harnais crée puis supprime sa base) :
 *   docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16
 *   E2E_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npm run test:e2e
 *
 *   E2E_KEEP_DB=1 : garder la base `verebona_e2e_*` pour l'inspecter.
 *   Seule E2E_DATABASE_URL est lue (jamais DATABASE_URL) ; un hôte non local
 *   est refusé sauf E2E_ALLOW_REMOTE=1.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ÉCRIRE UN SCÉNARIO
 *
 *   scenario('E2E-14', 'Immatriculation', ({ sql, make, replay }) => {
 *     it('…', async () => { const acc = await make.account(); … });
 *   });
 *
 * Un scénario vérifie l'ÉTAT FINAL en base (fiche, colonnes, agenda,
 * exports, traces), pas seulement la sortie d'un traitement. Les sorties
 * modèle viennent d'enregistrements (`replay-gateway.ts`) : jamais de réseau.
 * Fichier : `src/test/e2e/scenarios/<id>-<sujet>.e2e.ts`.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { afterAll, beforeAll, describe } from 'vitest';
import type postgres from 'postgres';
import { factories, type Factories } from './factories';
import { installReplayGateway, type RecordedOutput, type ReplayProvider } from './replay-gateway';

export interface ScenarioContext {
  /** Client SQL de la base E2E (celui de l'application : `@/db`). */
  readonly sql: postgres.Sql;
  readonly make: Factories;
  /** Rejeu installé pour ce scénario (réinitialisable par `useRecordings`). */
  readonly replay: ReplayProvider;
  /** Remplace les sorties enregistrées du scénario. */
  useRecordings(recordings: RecordedOutput[]): Promise<ReplayProvider>;
}

let fermetureEnregistree = false;

/**
 * Chaque fichier réimporte ses modules (isolation vitest, même dans le fork
 * unique) : `@/db` y ouvre SON pool (jusqu'à 8 connexions, libérées après
 * 20 s d'inactivité seulement). Au-delà d'une trentaine de fichiers, les
 * pools des fichiers précédents saturaient PostgreSQL (« too many clients
 * already », max_connections = 100 par défaut). Le pool du fichier est donc
 * fermé à la FIN DU FICHIER (crochet de niveau fichier, enregistré une fois,
 * après tous ses scénarios ; requêtes en cours terminées).
 */
function fermerLePoolEnFinDeFichier(): void {
  if (fermetureEnregistree) return;
  fermetureEnregistree = true;
  afterAll(async () => {
    const { pgClient } = await import('@/db');
    await pgClient.end({ timeout: 5 }).catch(() => undefined);
  });
}

/**
 * Déclare un scénario du corpus. `id` suit le CDC (E2E-01…, E2E-T2-01…) : le
 * rapport de CI se lit directement contre le §15.
 */
export function scenario(id: string, titre: string, body: (ctx: ScenarioContext) => void): void {
  fermerLePoolEnFinDeFichier();
  describe(`${id} — ${titre}`, () => {
    const etat: { sql?: postgres.Sql; make?: Factories; replay?: ReplayProvider } = {};
    // Le corps du scénario est évalué à la COLLECTE, avant `beforeAll` : le
    // contexte expose donc des mandataires résolus à l'exécution, ce qui
    // permet la déstructuration `({ sql, make }) => …`.
    const sql = new Proxy(function sqlMandataire() { /* mandataire */ }, {
      apply: (_t, _this, args) => (etat.sql as unknown as (...a: unknown[]) => unknown)(...args),
      get: (_t, p) => Reflect.get(etat.sql as object, p),
    }) as unknown as postgres.Sql;
    const make = new Proxy({} as Factories, { get: (_t, p) => Reflect.get(etat.make as object, p) });
    const replay = new Proxy({} as ReplayProvider, {
      get: (_t, p) => {
        const v = Reflect.get(etat.replay as object, p);
        return typeof v === 'function' ? v.bind(etat.replay) : v;
      },
    });
    const ctx: ScenarioContext = {
      sql, make, replay,
      async useRecordings(recordings) {
        etat.replay = await installReplayGateway(recordings);
        return etat.replay;
      },
    };

    beforeAll(async () => {
      const { pgClient } = await import('@/db');
      etat.sql = pgClient;
      etat.make = factories(pgClient);
      etat.replay = await installReplayGateway();
    });


    body(ctx);
  });
}
