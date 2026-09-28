/**
 * T2 sous arrêt d'urgence / T2 désactivé : le déterministe répond, et la
 * réponse dit explicitement que la partie IA est indisponible
 * (CDC BO IA T2-041, WF-34 étape 3).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({
  pgClient: { unsafe: vi.fn(async () => []) },
  db: {},
  ensureMigrations: vi.fn(async () => {}),
  ensureUnaccent: vi.fn(async () => {}),
}));

const { runAssistant, AI_UNAVAILABLE_NOTICE } = await import('../assistant-orchestrator.service');
type Ports = import('../assistant-orchestrator.service').OrchestratorPorts;

const DOC = { id: 'doc_5', type: 'document', title: 'Facture vélo', content: 'Facture du 12/03/2024.', relevanceScore: 0.8 } as never;
const INPUT = { accountId: 7, userId: 3, planType: 'PREMIUM', message: 'Résume les garanties de mon vélo', clientRequestId: 'c', locale: 'fr-FR' };

const base = (over: Partial<Ports>): Ports => ({
  retrieve: async () => [DOC],
  resolveSources: async (s) => s as never,
  resolveActions: async () => [],
  persist: async () => null,
  hasPendingClarification: async () => false,
  ...over,
});

describe('T2 sous EStop / désactivé (T2-041, WF-34)', () => {
  it('IA bloquée : repli déterministe + message explicite d’indisponibilité', async () => {
    const out = await runAssistant(INPUT, base({
      generateWithAI: async () => null, // la gateway a levé AI_BLOCKED
      isAiUnavailable: async () => true,
    }));
    expect(out.mode).not.toBe('ai');
    expect(out.answer).toContain(AI_UNAVAILABLE_NOTICE);
    expect(out.cascade?.escalationReasons).toContain('N3:AI_BLOCKED');
  });

  it('IA disponible mais génération ratée : pas de message d’indisponibilité', async () => {
    const out = await runAssistant(INPUT, base({
      generateWithAI: async () => null,
      isAiUnavailable: async () => false,
    }));
    expect(out.answer).not.toContain(AI_UNAVAILABLE_NOTICE);
  });

  it('IA bloquée et AUCUNE source trouvée : le message d’indisponibilité reste affiché', async () => {
    const out = await runAssistant(INPUT, base({
      retrieve: async () => [],
      resolveSources: async () => [] as never,
      generateWithAI: async () => null,
      isAiUnavailable: async () => true,
    }));
    expect(out.mode).not.toBe('ai');
    expect(out.answer).toContain(AI_UNAVAILABLE_NOTICE);
    expect(out.cascade?.escalationReasons).toContain('N3:AI_BLOCKED');
  });

  it('question réglée sans IA : le garde n’est même pas consulté', async () => {
    const isAiUnavailable = vi.fn(async () => true);
    await runAssistant({ ...INPUT, message: 'Bonjour' }, base({ isAiUnavailable }));
    expect(isAiUnavailable).not.toHaveBeenCalled();
  });
});
