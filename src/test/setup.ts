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

export const fakeProvider = new FakeProvider();

beforeEach(() => {
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
  // Lot 82A (C-Q10) : éligibilité des comptes aux traitements (requête en
  // base) accordée en test unitaire ; exercée par les e2e PostgreSQL
  // (`l82a-eligibilite-comptes`) et par `processing-eligibility.test.ts`.
  __setProcessingEligibilityForTests(async () => ({ eligible: true, reason: null }));
  // Plus aucun drapeau de moteur : AI_INTELLIGENT_ASSISTANT, AI_AGENDA_ENGINE
  // (lot 16b-2), AI_UNIFIED_SOURCE_ANALYSIS et AI_RECONCILIATION_ENGINE
  // (lot 16b-3) retirés.
});

afterEach(() => {
  vi.restoreAllMocks();
});
