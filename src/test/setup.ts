/**
 * Bootstrap des tests — CDC §11.
 *
 * Aucun test ne doit appeler un fournisseur réel : le `FakeProvider` est installé
 * par défaut et toute tentative d'appel réseau doit échouer bruyamment.
 */
import { beforeEach, afterEach, vi } from 'vitest';
import { setAiProvider, FakeProvider } from '@/services/ai/gateway/providers';
import { __setJobScopeCheckForTests } from '@/services/ai/queue/job-scope';
import { __setT3EnqueueTraceWriterForTests } from '@/services/ai/queue/t3-enqueue-trace';
import { __setAccountAccessCheckForTests } from '@/lib/auth/account-access';
import { __setProcessingEligibilityForTests } from '@/services/account/processing-eligibility-override';
import { __setSessionRegistryStoreForTests } from '@/lib/auth/session-registry';
import { createMemorySessionRegistryStore } from '@/lib/auth/session-registry-memory';
import { createMemoryReauthProofStore } from '@/lib/auth/reauth-memory';

export const fakeProvider = new FakeProvider();

beforeEach(async () => {
  fakeProvider.reset();
  setAiProvider(fakeProvider);
  process.env.GEMINI_API_KEY = 'test-key-not-used';
  // Aucun test unitaire ne doit ouvrir de connexion à la base.
  process.env.AI_IDEMPOTENCY_DISABLED = 'true';
  // Lot 49 : contrôle de périmètre des travaux de la file (requête en base)
  // neutralisé en test unitaire ; exercé par les e2e PostgreSQL et par ses
  // propres tests (`job-scope.test.ts`).
  __setJobScopeCheckForTests(async () => {});
  // Lot 54A : trace des demandes T3 en base (0370) neutralisée en test
  // unitaire (journal seul) ; exercée par les e2e PostgreSQL.
  __setT3EnqueueTraceWriterForTests(null);
  // Lot 54 (SEC-01) : droit actif sur le compte du jeton (requête en base)
  // accordé en test unitaire ; exercé par les e2e PostgreSQL et par
  // `account-access.test.ts`.
  __setAccountAccessCheckForTests(async () => true);
  // Lot 92 : registre des sessions et preuves de réauthentification en
  // mémoire (aucune connexion) ; exercés en base par l'e2e L92.
  __setSessionRegistryStoreForTests(createMemorySessionRegistryStore());
  // (même clé globale que `__setReauthProofStoreForTests`, sans importer `reauth.ts` ici)
  (globalThis as Record<string, unknown>).__verebonaReauthProofStore = createMemoryReauthProofStore();
  // Lot 96B : alerte « nouvel appareil » sans base (création du compte : non ;
  // envoi : ignoré) — même clé globale que `__setNewDeviceAlertDepsForTests` ;
  // exercée en base par l'e2e L96B.
  (globalThis as Record<string, unknown>).__verebonaNewDeviceAlertDeps = {
    // Intégration 96 : compte du cookie d'appareil sans base (entrées `uid` seulement).
    account: async (userId: number) => ({ userId }),
    isAccountCreation: async () => false,
    send: async () => {},
  };
  // Lot 82A (C-Q10) : éligibilité des comptes aux traitements (requête en
  // base) accordée en test unitaire ; exercée par les e2e PostgreSQL
  // (`l82a-eligibilite-comptes`) et par `processing-eligibility.test.ts`.
  __setProcessingEligibilityForTests(async () => ({ eligible: true, reason: null }));
  // Lot 85C : fiches de capacités sans base — références documentées du code
  // seules (aucune donnée de catalogue) ; exercées en base par l'e2e L85C.
  // Import dynamique : n'évalue pas `@/db` avant les `vi.mock` du fichier de test.
  const [{ __setModelCapabilityLoaderForTests }, { setStoredCapabilityInputs }] = await Promise.all([
    import('@/services/ai/provider/model-capabilities.repository'), import('@/services/ai/provider/model-capabilities'),
  ]);
  __setModelCapabilityLoaderForTests(async () => new Map());
  setStoredCapabilityInputs(new Map());
  // Plus aucun drapeau de moteur : AI_INTELLIGENT_ASSISTANT, AI_AGENDA_ENGINE
  // (lot 16b-2), AI_UNIFIED_SOURCE_ANALYSIS et AI_RECONCILIATION_ENGINE
  // (lot 16b-3) retirés.
});

afterEach(() => {
  vi.restoreAllMocks();
});
