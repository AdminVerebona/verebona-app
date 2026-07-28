/**
 * Bootstrap des tests — CDC §11.
 *
 * Aucun test ne doit appeler un fournisseur réel : le `FakeProvider` est installé
 * par défaut et toute tentative d'appel réseau doit échouer bruyamment.
 */
import { beforeEach, afterEach, vi } from 'vitest';
import { setAiProvider, FakeProvider } from '@/services/ai/gateway/providers';

export const fakeProvider = new FakeProvider();

beforeEach(() => {
  fakeProvider.reset();
  setAiProvider(fakeProvider);
  process.env.GEMINI_API_KEY = 'test-key-not-used';
  // Aucun test unitaire ne doit ouvrir de connexion à la base.
  process.env.AI_IDEMPOTENCY_DISABLED = 'true';
  // Bascule : tous les nouveaux moteurs actifs en test.
  process.env.AI_UNIFIED_SOURCE_ANALYSIS = 'enabled';
  process.env.AI_RECONCILIATION_ENGINE = 'enabled';
  process.env.AI_INTELLIGENT_ASSISTANT = 'enabled';
  process.env.AI_AGENDA_ENGINE = 'enabled';
  process.env.AI_PROMPT_GOVERNANCE = 'enabled';
});

afterEach(() => {
  vi.restoreAllMocks();
});
