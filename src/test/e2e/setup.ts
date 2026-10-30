/**
 * Préambule de chaque fichier de scénarios E2E (vitest `setupFiles`).
 *
 * Exécuté AVANT tout import de `@/db` par les scénarios : la connexion
 * applicative vise la base E2E de CE fichier.
 *
 * Lot 100A — isolation entre fichiers (tous exécutés dans le même processus) :
 *   · base : une copie neuve de la base modèle par fichier (`global-setup.ts`),
 *     supprimée à la fin du fichier SUIVANT ; `E2E_SHARED_DB=1` rétablit la base commune ;
 *   · environnement : `process.env` est remis, au début de chaque fichier, dans
 *     l'état où le premier fichier l'a trouvé — une variable posée par un
 *     fichier sans être restaurée (seuils, drapeaux, tailles de page…) ne
 *     change plus le comportement des fichiers suivants.
 */
import { inject, beforeEach, afterAll } from 'vitest';
import { cloneE2eDatabase, derivedDatabaseName, dropE2eDatabasesWithPrefix } from './db-bootstrap';
import { restoreProcessEnv } from './isolation';

const ORIGINE = Symbol.for('verebona.e2e.envOrigine');
const g = globalThis as unknown as Record<symbol, Record<string, string | undefined> | undefined>;
g[ORIGINE] ??= { ...process.env };
restoreProcessEnv(process.env, g[ORIGINE]!);

// Lot 101-quinquies — pollution de prototype propre aux tests : drizzle-kit (jamais chargé
// par l'application) ajoute `Array.prototype.random` ÉNUMÉRABLE dans le processus unique de
// la suite ; pdf.js refuse alors de lire tout PDF (« Array.prototype contains unexpected
// enumerable property "random" »), ce qui faisait échouer en CI les analyses T1 des fichiers
// suivants (L83C). Retirée au début de chaque fichier et avant chaque test.
function retirerPollutionPrototype(): void {
  const d = Object.getOwnPropertyDescriptor(Array.prototype, 'random');
  if (d?.enumerable) delete (Array.prototype as unknown as Record<string, unknown>).random;
}
retirerPollutionPrototype();
beforeEach(retirerPollutionPrototype);

if (process.env.E2E_SHARED_DB === '1') {
  process.env.DATABASE_URL = inject('e2eDatabaseUrl');
} else {
  const adminUrl = process.env.E2E_DATABASE_URL!;
  const prefix = inject('e2eRunPrefix');
  const database = derivedDatabaseName(prefix, `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`);
  process.env.DATABASE_URL = await cloneE2eDatabase({ adminUrl, template: inject('e2eTemplateDatabase'), database });
  // Fin du fichier : suppression des bases des fichiers PRÉCÉDENTS, pas de la sienne (supprimée à la fin
  // du fichier suivant, ou en fin d'exécution) — une écriture sans attente encore en vol (journal
  // d'activité, e-mail…) se termine sur sa base au lieu d'échouer sur une connexion coupée (ECONNRESET).
  // Jamais plus de deux copies sur le serveur. `E2E_KEEP_DB=1` : tout est conservé.
  afterAll(async () => {
    if (process.env.E2E_KEEP_DB === '1') return;
    await dropE2eDatabasesWithPrefix(adminUrl, prefix, { except: database })
      .catch((e) => console.warn(`[e2e] bases précédentes non supprimées : ${(e as Error).message}`));
  }, 60_000);
}

// Ni clé ni réseau : la passerelle passe par le rejeu (`replay-gateway.ts`).
process.env.GEMINI_API_KEY = 'e2e-sans-reseau';
process.env.NEXT_PUBLIC_APP_ENV = process.env.NEXT_PUBLIC_APP_ENV ?? 'local';
// Décision D-01 : nouveau moteur seul. Plus aucun drapeau de moteur depuis le
// lot 16b-3 (AI_UNIFIED_SOURCE_ANALYSIS, AI_RECONCILIATION_ENGINE retirés).
// Idempotence en base désactivée : chaque scénario rejoue ses propres sorties.
process.env.AI_IDEMPOTENCY_DISABLED = 'true';
// Lot 86 : le budget de relances T1 du contrôle de cohérence est commun à la plateforme
// (200 / 24 h, décision PO L83-Q3). Dans une exécution complète, les relances de tous les
// fichiers précédents s'y cumulaient : un scénario pouvait se voir refuser sa relance selon l'ordre.
// Les scénarios qui testent le budget le fixent eux-mêmes (L83B-E2E-11).
process.env.COHERENCE_T1_RELAUNCH_DAILY_MAX = process.env.COHERENCE_T1_RELAUNCH_DAILY_MAX ?? '100000';

// Aucun appel réseau sortant : seul le serveur PostgreSQL local est joignable
// (le pilote `postgres` n'utilise pas `fetch`).
const fetchOrigine = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`[e2e] appel réseau interdit : ${String((input as { url?: string })?.url ?? input)}`);
  }) as typeof fetch;
  return () => { globalThis.fetch = fetchOrigine; };
});

// Lot 33 : les pré-générations rapides de la mascotte (minuteurs de 3 s) ne
// doivent pas survivre au fichier qui les a déclenchées — sinon elles
// tournent pendant le fichier suivant (même processus) et faussent ses
// compteurs d'appels IA.
afterAll(async () => {
  const m = await import('@/services/home/mascot/mascot.service');
  m.cancelPendingPregenerations();
});
