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

// ══════════════════════════════════════════════════════════════════════════
// Lot 113AE (#728) — Standard actif = T2 complet ; compte restreint = ZÉRO
// appel modèle (UNDERSTAND, ANSWER, REVALIDATE, ARBITRATE), y compris en
// reprise de clarification ; IA coupée ou budget épuisé : même repli pour
// Standard et Premium.
// ══════════════════════════════════════════════════════════════════════════
type Access = NonNullable<Input['aiAccess']>;
const ACCES = {
  standard: { modelCalls: true, denial: null, commercialPlan: 'standard', status: 'active', premiumFeatures: false, canWrite: true } as Access,
  premium: { modelCalls: true, denial: null, commercialPlan: 'premium', status: 'active', premiumFeatures: true, canWrite: true } as Access,
  essai: { modelCalls: true, denial: null, commercialPlan: 'trial', status: 'trialing', premiumFeatures: true, canWrite: true } as Access,
  readonly: { modelCalls: false, denial: 'TRIAL_EXPIRED', commercialPlan: 'none', status: 'readonly', premiumFeatures: false, canWrite: false } as Access,
  past_due: { modelCalls: false, denial: 'SUBSCRIPTION_REQUIRED', commercialPlan: 'none', status: 'past_due', premiumFeatures: false, canWrite: false } as Access,
  canceled: { modelCalls: false, denial: 'SUBSCRIPTION_REQUIRED', commercialPlan: 'none', status: 'canceled', premiumFeatures: false, canWrite: false } as Access,
  none: { modelCalls: false, denial: 'SUBSCRIPTION_REQUIRED', commercialPlan: 'none', status: 'none', premiumFeatures: false, canWrite: false } as Access,
};

function portsModele() {
  const classify = vi.fn(async () => null);
  const generate = vi.fn(async () => ({ answer: 'Synthèse rédigée.', claims: [], actions: [], supportLevel: 'supported' as const, model: 'm' }));
  const arbitrate = vi.fn(async () => null);
  const revalidate = vi.fn(async () => ({ results: [], established: false }));
  const p = ports({ classifyWithAI: classify, generateWithAI: generate as never, arbitrateWithAI: arbitrate, revalidateFacts: revalidate });
  return { p, classify, generate, arbitrate, revalidate, appels: () => classify.mock.calls.length + generate.mock.calls.length + arbitrate.mock.calls.length + revalidate.mock.calls.length };
}

const QUESTIONS = ['Résume les garanties de mon vélo', 'raconte-moi un truc sur ce que je possède', 'Compare mes deux contrats'];

describe('lot 113AE (#728) — autorisation effective des appels modèle', () => {
  it('Standard actif : ANSWER réel comme Premium (même port, même route), offre réelle tracée « standard »', async () => {
    const s = portsModele();
    const r = await runAssistant(input({ planType: 'STANDARD', aiAccess: ACCES.standard }), s.p);
    expect(s.generate).toHaveBeenCalledTimes(1);
    expect(r.mode).toBe('ai');
    expect(r.cascade?.access).toMatchObject({ commercialPlan: 'standard', modelCalls: true, premiumFeatures: false, source: 'entitlements' });
    expect(r.cascade?.escalationReasons.join(' ')).not.toMatch(/PLAN_WITHOUT_AI|PLAN_LIMIT/);
    const p = portsModele();
    const rp = await runAssistant(input({ planType: 'PREMIUM', aiAccess: ACCES.premium }), p.p);
    expect(p.generate).toHaveBeenCalledTimes(1);
    // Même route, même intention : aucun « Standard light ».
    expect(r.route.intent).toBe(rp.route.intent);
    expect(r.route.aiEligible).toBe(rp.route.aiEligible);
  });

  it('Standard actif : UNDERSTAND effectif sur une question ambiguë', async () => {
    const s = portsModele();
    await runAssistant(input({ planType: 'STANDARD', aiAccess: ACCES.standard, message: 'raconte-moi un truc sur ce que je possède' }), s.p);
    expect(s.classify).toHaveBeenCalled();
  });

  it('essai actif : autorisé', async () => {
    const s = portsModele();
    await runAssistant(input({ planType: 'PREMIUM', aiAccess: ACCES.essai }), s.p);
    expect(s.generate).toHaveBeenCalledTimes(1);
  });

  for (const etat of ['readonly', 'past_due', 'canceled', 'none'] as const) {
    it(`compte ${etat} : ZÉRO appel modèle (questions ambiguës, synthèse, reprise), limite et « Voir les offres »`, async () => {
      for (const message of QUESTIONS) {
        const s = portsModele();
        const r = await runAssistant(input({ planType: 'STANDARD', aiAccess: ACCES[etat], message }), s.p);
        expect(s.appels()).toBe(0);
        expect(r.cascade?.aiCalls ?? 0).toBe(0);
        expect(r.cascade?.access).toMatchObject({ modelCalls: false, commercialPlan: 'none' });
      }
      // Reprise d'une clarification : même accès, toujours aucun appel.
      const s = portsModele();
      await runAssistant(input({
        planType: 'STANDARD', aiAccess: ACCES[etat], message: 'Résume les garanties de mon vélo',
        resume: { clarificationId: 'c1', intent: 'ACCOUNT_SUMMARY', assetId: 3, chainDepth: 1, choiceLabel: 'Vélo' },
      }), s.p);
      expect(s.appels()).toBe(0);
      const synth = await runAssistant(input({ planType: 'STANDARD', aiAccess: ACCES[etat] }), portsModele().p);
      const limite = ACCES[etat].denial as 'TRIAL_EXPIRED' | 'SUBSCRIPTION_REQUIRED';
      expect(synth.answer).toContain(planLimitNotice(limite));
      expect(synth.actions.some((a) => a.type === 'OPEN_PRICING')).toBe(true);
    });
  }

  it('compte restreint : la recherche classique reste servie, sans appel', async () => {
    const s = portsModele();
    const r = await runAssistant(input({ planType: 'STANDARD', aiAccess: ACCES.readonly, message: 'retrouve ma facture vélo' }), s.p);
    expect(s.appels()).toBe(0);
    expect(r.resultGroups?.[0]?.items[0]?.title).toBe('Facture vélo');
  });

  it('compte restreint : aucune commande préparée ; Standard actif : commande préparée (flag d’écriture porté par le port)', async () => {
    const prepareCommand = vi.fn(async () => ({ kind: 'need_info' as const, message: 'Précisez la date.' }));
    await runAssistant(input({ planType: 'STANDARD', aiAccess: ACCES.readonly, message: 'ajoute un rappel demain' }), ports({ prepareCommand }));
    expect(prepareCommand).not.toHaveBeenCalled();
    await runAssistant(input({ planType: 'STANDARD', aiAccess: ACCES.standard, message: 'ajoute un rappel demain' }), ports({ prepareCommand }));
    expect(prepareCommand).toHaveBeenCalledTimes(1);
  });

  it('IA coupée globalement : aucun appel, Standard comme Premium (aucune dérogation)', async () => {
    process.env.VEREBONA_ASSISTANT_AI_ENABLED = 'false';
    resetAssistantConfigForTests();
    for (const [planType, aiAccess] of [['STANDARD', ACCES.standard], ['PREMIUM', ACCES.premium]] as const) {
      for (const message of QUESTIONS) {
        const s = portsModele();
        await runAssistant(input({ planType, aiAccess, message }), s.p);
        expect(s.appels()).toBe(0);
      }
    }
  });

  it('budget du message épuisé : repli sans appel, Standard comme Premium', async () => {
    const { createAiCallBudget } = await import('../ai-call-budget');
    for (const [planType, aiAccess] of [['STANDARD', ACCES.standard], ['PREMIUM', ACCES.premium]] as const) {
      const s = portsModele();
      const r = await runAssistant(input({ planType, aiAccess, aiBudget: createAiCallBudget(0) }), s.p);
      expect(s.generate).not.toHaveBeenCalled();
      expect(r.error).toBeUndefined();
    }
  });

  it('plafond mensuel atteint : repli sans appel, Standard comme Premium', async () => {
    for (const [planType, aiAccess] of [['STANDARD', ACCES.standard], ['PREMIUM', ACCES.premium]] as const) {
      const s = portsModele();
      const p = { ...s.p, checkMonthlyBudget: async () => ({ allowed: false, usedMicros: 10, limitMicros: 10, alert: true }) };
      await runAssistant(input({ planType, aiAccess }), p);
      expect(s.generate).not.toHaveBeenCalled();
    }
  });

  it('PRODUCT_PLAN_LIMIT : Standard présente les questions comme INCLUSES, pas de fausse incitation', async () => {
    const r = await runAssistant(input({ planType: 'STANDARD', aiAccess: ACCES.standard, message: 'Que comprend mon offre ?' }), ports());
    expect(r.route.intent).toBe('PRODUCT_PLAN_LIMIT');
    expect(r.answer).toContain('Votre offre Standard comprend');
    expect(r.answer).toMatch(/réponses à vos questions/);
    expect(r.answer).not.toMatch(/(réponses rédigées|questions)[^.]*font partie de (Premium|l’offre Premium)/);
    expect(r.answer).toMatch(/coût de possession, la synchronisation de l’agenda et les dossiers prêts à l’usage font partie de Premium/);
  });
});
