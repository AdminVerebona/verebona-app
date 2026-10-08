/**
 * Préambule de chaque fichier de scénarios E2E (vitest `setupFiles`).
 *
 * Exécuté AVANT tout import de `@/db` par les scénarios : la connexion
 * applicative vise la base E2E de l'exécution.
 */
import { inject, beforeEach, afterAll } from 'vitest';

process.env.DATABASE_URL = inject('e2eDatabaseUrl');
// Ni clé ni réseau : la passerelle passe par le rejeu (`replay-gateway.ts`).
process.env.GEMINI_API_KEY = 'e2e-sans-reseau';
process.env.NEXT_PUBLIC_APP_ENV = process.env.NEXT_PUBLIC_APP_ENV ?? 'local';
// Décision D-01 : nouveau moteur seul. Plus aucun drapeau de moteur depuis le
// lot 16b-3 (AI_UNIFIED_SOURCE_ANALYSIS, AI_RECONCILIATION_ENGINE retirés).
// Idempotence en base désactivée : chaque scénario rejoue ses propres sorties.
process.env.AI_IDEMPOTENCY_DISABLED = 'true';

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
