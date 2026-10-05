/**
 * Flags du §39 réellement lus, et fin d'essai sans blocage de la recherche
 * ni de l'aide — CDC §39, CA-30, §6.5.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/db', () => ({
  pgClient: { unsafe: vi.fn(async () => []) },
  db: {},
  ensureMigrations: vi.fn(async () => {}),
  ensureUnaccent: vi.fn(async () => {}),
}));

const { isAssistantFlagOn, assistantFlagsSnapshot } = await import('../../config/assistant-flags');
const { registerRetrievalAdapter, getEnabledAdapters, clearAdapters } = await import('../../registries/retrieval-adapter-registry');
const { runAssistant, PRODUCT_HELP_OFF_MESSAGE, planLimitNotice } = await import('../assistant-orchestrator.service');
const { toApiPayload } = await import('../api-payload');
const { assistantPlanLimit } = await import('../plan-eligibility');
const { resetAssistantConfigForTests } = await import('../../config/assistant-config');
type Ports = import('../assistant-orchestrator.service').OrchestratorPorts;
type Input = import('../../types/contracts').AssistantRequestInput;

const ENVS = ['VEREBONA_ASSISTANT_ACCOUNT_AI', 'VEREBONA_ASSISTANT_AI_ENABLED', 'VEREBONA_ASSISTANT_PRODUCT_HELP',
  'VEREBONA_ASSISTANT_SOURCES', 'VEREBONA_ASSISTANT_SEMANTIC_RETRIEVAL', 'VEREBONA_ASSISTANT_FALLBACK_MODEL'];
afterEach(() => { for (const e of ENVS) delete process.env[e]; resetAssistantConfigForTests(); });

const DOC = { id: 'doc_5', type: 'document' as const, title: 'Facture vélo', content: 'Facture du 12/03/2024.', relevanceScore: 0.8 };

function ports(over: Partial<Ports> = {}): Ports {
  return {
    retrieve: vi.fn(async () => [DOC]),
    resolveSources: async (s) => s.map((x) => ({ id: x.id, type: x.type, typeLabel: 'Document', title: x.title, excerpt: x.content, isAvailable: true })),
    resolveActions: async () => [],
    persist: async () => null,
    hasPendingClarification: async () => false,
    ...over,
  };
}
const input = (over: Partial<Input> = {}): Input => ({
  accountId: 7, userId: 3, planType: 'PREMIUM', message: 'Résume les garanties de mon vélo',
  clientRequestId: `c-${Math.random()}`, locale: 'fr-FR', ...over,
});

describe('flags du §39', () => {
  it('défauts du CDC, valeurs off explicites, faute de frappe sans effet', () => {
    expect(assistantFlagsSnapshot({} as NodeJS.ProcessEnv)).toEqual({
      verebona_assistant_enabled: true, verebona_assistant_product_help: true, verebona_assistant_account_ai: true,
      verebona_assistant_fallback_model: true, verebona_assistant_sources: true, verebona_assistant_semantic_retrieval: false,
    });
    expect(isAssistantFlagOn('account_ai', { VEREBONA_ASSISTANT_AI_ENABLED: 'false' } as never)).toBe(false);
    expect(isAssistantFlagOn('sources', { VEREBONA_ASSISTANT_SOURCES: 'ofF' } as never)).toBe(false);
    expect(isAssistantFlagOn('sources', { VEREBONA_ASSISTANT_SOURCES: 'oof' } as never)).toBe(true);
  });

  it('semantic_retrieval : les adaptateurs sémantiques ne sont servis que flag actif', () => {
    clearAdapters();
    registerRetrievalAdapter({ code: 'semantic', enabled: true, search: async () => [] });
    registerRetrievalAdapter({ code: 'structured', enabled: true, search: async () => [] });
    expect(getEnabledAdapters().map((a) => a.code)).toEqual(['structured']);
    process.env.VEREBONA_ASSISTANT_SEMANTIC_RETRIEVAL = 'on';
    expect(getEnabledAdapters().map((a) => a.code)).toEqual(['semantic', 'structured']);
    clearAdapters();
  });

  it('account_ai coupé : aucune classification ni génération, la recherche reste servie', async () => {
    process.env.VEREBONA_ASSISTANT_ACCOUNT_AI = 'off';
    resetAssistantConfigForTests();
    const classify = vi.fn(async () => null);
    const generate = vi.fn(async () => null);
    const p = ports({ classifyWithAI: classify, generateWithAI: generate });
    const r = await runAssistant(input(), p);
    expect(generate).not.toHaveBeenCalled();
    expect(r.error).toBeUndefined();
    const r2 = await runAssistant(input({ message: 'raconte-moi un truc sur ce que je possède' }), p);
    expect(classify).not.toHaveBeenCalled();
    expect(r2.cascade?.escalationReasons).toContain('ROUTING:AI_DISABLED');
  });

  it('product_help coupé : pas de réponse d’aide, renvoi au Centre d’aide, aucun retrieval', async () => {
    process.env.VEREBONA_ASSISTANT_PRODUCT_HELP = 'off';
    const p = ports();
    const r = await runAssistant(input({ message: 'Comment ajouter un document ?' }), p);
    expect(r.answer).toBe(PRODUCT_HELP_OFF_MESSAGE);
    expect(p.retrieve).not.toHaveBeenCalled();
  });

  it('sources coupé : aucune source exposée par l’API', async () => {
    const r = await runAssistant(input({ planType: 'STANDARD', message: 'retrouve ma facture vélo' }), ports({
      resolveActions: async () => [{ actionId: 'a', type: 'SHOW_SOURCES', label: 'Voir les sources', href: null, token: null, requiresConfirmation: false, expiresAt: null, analyticsCode: 'x' }],
    }));
    expect(toApiPayload(r).sourcesAvailable).toBe(true);
    process.env.VEREBONA_ASSISTANT_SOURCES = 'off';
    const payload = toApiPayload(r);
    expect(payload.sourcesAvailable).toBe(false);
    expect(payload.actions.some((a) => a.type === 'SHOW_SOURCES')).toBe(false);
  });
});

describe('fin d’essai (§6.5)', () => {
  it('droits → limite de l’assistant', () => {
    expect(assistantPlanLimit({ canWrite: true, status: 'active' })).toBeNull();
    expect(assistantPlanLimit({ canWrite: false, canRead: true, status: 'readonly' })).toBe('TRIAL_EXPIRED');
    expect(assistantPlanLimit({ canWrite: false, canRead: true, status: 'canceled' })).toBe('SUBSCRIPTION_REQUIRED');
    expect(assistantPlanLimit({ canWrite: false, canRead: false, status: 'none' })).toBe('NO_ACCESS');
  });

  it('question qui demandait l’IA : la limite est expliquée avec « Voir les offres »', async () => {
    const generate = vi.fn(async () => null);
    const r = await runAssistant(input({ planType: 'STANDARD', planLimit: 'TRIAL_EXPIRED' }), ports({ generateWithAI: generate }));
    expect(generate).not.toHaveBeenCalled();
    expect(r.answer).toContain(planLimitNotice('TRIAL_EXPIRED'));
    expect(r.actions[0]).toMatchObject({ type: 'OPEN_PRICING', href: '/abonnement' });
  });

  it('la recherche classique reste disponible, sans message de limite', async () => {
    const r = await runAssistant(input({ planType: 'STANDARD', planLimit: 'TRIAL_EXPIRED', message: 'retrouve ma facture vélo' }), ports());
    expect(r.error).toBeUndefined();
    expect(r.answer).not.toContain('essai est terminé');
    expect(r.resultGroups?.[0]?.items[0]?.title).toBe('Facture vélo');
  });

  it('aucune commande d’écriture préparée en lecture seule', async () => {
    const prepareCommand = vi.fn(async () => ({ kind: 'need_info' as const, message: 'x' }));
    await runAssistant(input({ planType: 'STANDARD', planLimit: 'TRIAL_EXPIRED', message: 'ajoute un rappel demain' }), ports({ prepareCommand }));
    expect(prepareCommand).not.toHaveBeenCalled();
  });
});
