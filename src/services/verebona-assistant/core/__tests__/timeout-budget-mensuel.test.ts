/**
 * Timeout qui conserve les résultats déterministes (§9.6, §30.1) et plafond
 * budgétaire mensuel appliqué par l'orchestrateur (§6.6, §31.3).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/db', () => ({
  pgClient: { unsafe: vi.fn(async () => []) },
  db: {},
  ensureMigrations: vi.fn(async () => {}),
  ensureUnaccent: vi.fn(async () => {}),
}));

const { runAssistant } = await import('../assistant-orchestrator.service');
const { resetAssistantConfigForTests } = await import('../../config/assistant-config');
const { MONTHLY_BUDGET_NOTICE } = await import('../budget.service');
type Ports = import('../assistant-orchestrator.service').OrchestratorPorts;

const DOC = { id: 'doc_5', type: 'document', title: 'Facture vélo', content: 'Facture du 12/03/2024, 1 290 €.', relevanceScore: 0.8 } as never;

const INPUT = { accountId: 7, userId: 3, planType: 'PREMIUM', message: 'Retrouve la facture de mon vélo', clientRequestId: 'c', locale: 'fr-FR' };

const base = (over: Partial<Ports>): Ports => ({
  retrieve: async () => [DOC],
  resolveSources: async (s) => s as never,
  resolveActions: async () => [],
  persist: async () => null,
  hasPendingClarification: async () => false,
  ...over,
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetAssistantConfigForTests();
});

describe('timeout global : les résultats déjà trouvés sont rendus (§9.6, §30.1)', () => {
  it('recherche trop lente après le niveau 2 : ERROR_RECOVERABLE, sources conservées, pas d’erreur finale', async () => {
    vi.stubEnv('VEREBONA_ASSISTANT_TOTAL_TIMEOUT_MS', '60');
    resetAssistantConfigForTests();
    const out = await runAssistant(INPUT, base({
      answerFromData: async () => ({
        handled: false, sources: [], claims: [], contextSources: [DOC], attempts: [],
        decision: { level: 2, status: 'INSUFFICIENT', score: 0.4, threshold: 0.7, reason: 'LOW_SCORE' } as never,
        strategy: 'fulltext' as never,
      }),
      retrieve: () => new Promise(() => {}), // ne répond jamais
    }));
    expect(out.finalState).toBe('ERROR_RECOVERABLE');
    expect(out.error).toBeUndefined();
    expect(out.answer).toMatch(/pris trop de temps.*déjà trouvé/);
    expect(out.sources.map((s) => (s as { id: string }).id)).toEqual(['doc_5']);
    expect(out.cascade?.escalationReasons).toContain('TIMEOUT:PARTIAL_RESULTS');
  });

  it('rien trouvé avant le timeout : REQUEST_TIMEOUT récupérable (comportement inchangé)', async () => {
    vi.stubEnv('VEREBONA_ASSISTANT_TOTAL_TIMEOUT_MS', '40');
    resetAssistantConfigForTests();
    const out = await runAssistant(INPUT, base({ retrieve: () => new Promise(() => {}) }));
    expect(out.error?.code).toBe('REQUEST_TIMEOUT');
    expect(out.error?.recoverable).toBe(true);
  });
});

describe('plafond budgétaire mensuel (§6.6)', () => {
  const synthese = { ...INPUT, message: 'Résume les garanties de mon vélo' };

  it('plafond atteint : aucun appel modèle, repli déterministe, message non culpabilisant', async () => {
    const generateWithAI = vi.fn();
    const checkMonthlyBudget = vi.fn(async () => ({ allowed: false }));
    const out = await runAssistant(synthese, base({ generateWithAI, checkMonthlyBudget }));
    expect(generateWithAI).not.toHaveBeenCalled();
    expect(checkMonthlyBudget).toHaveBeenCalledTimes(1);
    expect(out.answer).toContain(MONTHLY_BUDGET_NOTICE);
    expect(out.answer).not.toMatch(/abus|dépass/i);
    expect(out.cascade?.escalationReasons).toContain('AI_MONTHLY_BUDGET_EXCEEDED');
  });

  it('sous le plafond : génération normale ; réponse déterministe : plafond jamais lu', async () => {
    const generateWithAI = vi.fn(async () => ({ answer: 'Garantie de deux ans.', claims: [{ claimKey: 'c1', text: 'Garantie de deux ans.', sourceIds: ['doc_5'], derivation: 'direct' as const }], actions: [] as [], supportLevel: 'supported' as const }));
    const checkMonthlyBudget = vi.fn(async () => ({ allowed: true }));
    const out = await runAssistant(synthese, base({ generateWithAI, checkMonthlyBudget }));
    expect(generateWithAI).toHaveBeenCalledTimes(1);
    expect(out.mode).toBe('ai');

    const check2 = vi.fn(async () => ({ allowed: true }));
    await runAssistant({ ...INPUT, message: 'Bonjour' }, base({ checkMonthlyBudget: check2 }));
    expect(check2).not.toHaveBeenCalled();
  });
});
