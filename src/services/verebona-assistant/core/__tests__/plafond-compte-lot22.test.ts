/**
 * Lot 22 — T2 au plafond IA du mois du COMPTE (tous traitements, offre ou
 * dérogation) : même repli déterministe « sources seules » et même message
 * que le plafond de l'assistant ; un refus de la passerelle en cours de
 * demande est traité comme un budget épuisé (aucun second appel).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/db', () => ({
  pgClient: { unsafe: vi.fn(async () => []) },
  db: {},
  ensureMigrations: vi.fn(async () => {}),
  ensureUnaccent: vi.fn(async () => {}),
}));

const { runAssistant } = await import('../assistant-orchestrator.service');
const { checkMonthlyBudget, MONTHLY_BUDGET_NOTICE } = await import('../budget.service');
const { classifyModelFailure } = await import('../model-call-policy');
const { setCostCapStoreForTests } = await import('@/services/ai/gateway/account-cost-cap');
const { AiCostCapReachedError } = await import('@/services/ai/gateway/errors');
type Ports = import('../assistant-orchestrator.service').OrchestratorPorts;

const DOC = { id: 'doc_5', type: 'document', title: 'Facture vélo', content: 'Facture du 12/03/2024, 1 290 €.', relevanceScore: 0.8 } as never;
const INPUT = { accountId: 7, userId: 3, planType: 'PREMIUM', message: 'Résume les garanties de mon vélo', clientRequestId: 'c', locale: 'fr-FR' };

const capStore = (spent: number, override: number | null = null) => ({
  planOf: async () => 'premium' as const,
  overrideOf: async () => override,
  offerCap: async () => 1_000_000,
  spent: async () => spent,
  raise: async () => true,
});

afterEach(() => setCostCapStoreForTests(null));

describe('T2 : plafond IA du compte', () => {
  it('atteint : checkMonthlyBudget refuse, repli « sources seules » avec le message du plafond, aucun appel modèle', async () => {
    setCostCapStoreForTests(capStore(1_500_000));
    expect(await checkMonthlyBudget(7)).toMatchObject({ allowed: false, limitMicros: 1_000_000 });
    const generateWithAI = vi.fn();
    const out = await runAssistant(INPUT, {
      retrieve: async () => [DOC],
      resolveSources: async (s) => s as never,
      resolveActions: async () => [],
      persist: async () => null,
      hasPendingClarification: async () => false,
      generateWithAI,
      checkMonthlyBudget: (a) => checkMonthlyBudget(a),
    } as Ports);
    expect(generateWithAI).not.toHaveBeenCalled();
    expect(out.answer).toContain(MONTHLY_BUDGET_NOTICE);
    expect(out.cascade?.escalationReasons).toContain('AI_MONTHLY_BUDGET_EXCEEDED');
  });

  it('dérogation du compte relevée : pas de refus du plafond du compte', async () => {
    setCostCapStoreForTests(capStore(1_500_000, 50_000_000));
    vi.stubEnv('VEREBONA_ASSISTANT_MONTHLY_BUDGET_MICROS', '0');
    expect((await checkMonthlyBudget(7)).allowed).toBe(true);
    vi.unstubAllEnvs();
  });

  it('refus de la passerelle en cours de demande : budget épuisé (repli, aucune réparation ni escalade)', () => {
    const e = new AiCostCapReachedError('t2_answer', 7, 1, 2, new Date());
    expect(classifyModelFailure(e).kind).toBe('BUDGET_EXHAUSTED');
  });
});
