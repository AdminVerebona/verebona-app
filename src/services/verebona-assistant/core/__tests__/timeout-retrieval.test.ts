/**
 * Retrieval déterministe borné à 3 s (§30.1) — dans l'échéance globale de 20 s.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {}, ensureMigrations: vi.fn(), ensureUnaccent: vi.fn() }));

const { runAssistant } = await import('../assistant-orchestrator.service');
const { resetAssistantConfigForTests, loadAssistantConfig } = await import('../../config/assistant-config');
type Ports = import('../assistant-orchestrator.service').OrchestratorPorts;

afterEach(() => { vi.unstubAllEnvs(); resetAssistantConfigForTests(); });

describe('timeout du retrieval (§30.1)', () => {
  it('3 s par défaut, configurable', () => {
    expect(loadAssistantConfig().retrievalTimeoutMs).toBe(3000);
  });

  it('un retrieval qui dépasse son délai s’arrête bien avant l’échéance globale', async () => {
    vi.stubEnv('VEREBONA_ASSISTANT_RETRIEVAL_TIMEOUT_MS', '30');
    resetAssistantConfigForTests();
    const ports: Ports = {
      retrieve: () => new Promise((r) => setTimeout(() => r([]), 2000)),
      resolveSources: async () => [], resolveActions: async () => [], persist: async () => null,
      hasPendingClarification: async () => false,
    };
    const debut = Date.now();
    const r = await runAssistant({ accountId: 1, userId: 2, planType: 'STANDARD', message: 'retrouve ma facture', clientRequestId: 'c', locale: 'fr-FR' }, ports);
    expect(Date.now() - debut).toBeLessThan(1000);
    expect(r.error?.code).toBe('REQUEST_TIMEOUT');
    expect(r.error?.recoverable).toBe(true);
  });
});
