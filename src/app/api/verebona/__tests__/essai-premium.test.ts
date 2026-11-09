/**
 * Essai 7 jours = comportement Premium — CDC Assistant §6.5, §0.13.
 *
 * Pendant l'essai, `premiumFeatures` vaut vrai mais le planType du JWT reste
 * `STANDARD` : l'assistant en déduisait « pas d'IA ». L'offre effective est
 * désormais dérivée des DROITS du compte, dans les deux routes qui lancent
 * le pipeline (envoi d'un message, réponse à une clarification).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  entitlements: { plan: 'trial', status: 'trialing', premiumFeatures: true, canWrite: true, canRead: true, isRestricted: false } as Record<string, unknown>,
  runAssistant: vi.fn(),
  executerIssueClarification: vi.fn(),
  refus: vi.fn(async () => null as unknown),
}));

vi.mock('@/db', () => ({ ensureMigrations: vi.fn(async () => {}), pgClient: { unsafe: vi.fn() }, db: {} }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    // Le JWT dit STANDARD : c'est précisément le cas de l'essai.
    getSession: vi.fn(async () => ({ userId: 3, currentAccountId: 7, planType: 'STANDARD' })),
    handleSessionError: vi.fn(),
  },
}));
vi.mock('@/lib/rate-limiter', () => ({ rateLimiter: { check: () => ({ allowed: true }) }, getClientIp: () => '1.2.3.4' }));
// Lot 113AE : nombreux envois dans ce fichier — le limiteur dédié n'est pas l'objet du test.
vi.mock('@/lib/verebona/rate-limit', () => ({ checkAssistantRateLimit: vi.fn(async () => ({ allowed: true, retryAfterMs: 0 })) }));
vi.mock('@/services/entitlements.service', () => ({ getEntitlements: vi.fn(async () => h.entitlements) }));
vi.mock('@/lib/write-access-guard', () => ({ refuserSiPasDIA: h.refus }));
vi.mock('@/services/verebona-assistant', () => ({
  runAssistant: h.runAssistant,
  getAssistantConfig: () => ({ enabled: true, locale: 'fr-FR', totalTimeoutMs: 20_000 }),
  ensureAssistantStartupChecked: () => ({ ok: true }),
}));
vi.mock('@/services/verebona-assistant/core/assistant-orchestrator.service', () => ({ runAssistant: h.runAssistant }));
vi.mock('@/services/verebona-assistant/core/ports', () => ({
  buildOrchestratorPorts: () => ({ hasPendingClarification: async () => false }),
}));
vi.mock('@/services/verebona-assistant/core/conversation.service', () => ({
  ConversationNotFoundError: class extends Error {},
  findReplayedAnswer: vi.fn(async () => null),
  resolveConversation: vi.fn(async () => 11),
}));
vi.mock('@/services/verebona-assistant/core/clarification.service', () => ({ resoudreClarification: vi.fn(async () => ({ kind: 'ok' })) }));
vi.mock('@/services/verebona-assistant/core/clarification-flow', () => ({ executerIssueClarification: h.executerIssueClarification }));

const { assistantPlanFromEntitlements } = await import('@/services/verebona-assistant/core/plan-eligibility');
const { isPlanAiEligible } = await import('@/services/verebona-assistant/registries/capability-registry');
const { accountAllowsModelCalls, assistantAiAccessFromEntitlements } = await import('@/services/verebona-assistant/core/ai-access');
const messages = await import('../messages/route');
const clarification = await import('../clarifications/[clarificationId]/answer/route');

const RESULT = {
  requestId: 'r', messageId: '1', finalState: 'READY', mode: 'deterministic', route: { intent: 'GREETING' },
  answer: 'ok', supportLevel: null, claims: [], sources: [], actions: [], clarification: null,
};

function post(url: string, body: unknown) {
  return new NextRequest(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  h.runAssistant.mockReset().mockResolvedValue(RESULT);
  h.executerIssueClarification.mockReset().mockResolvedValue({ kind: 'result', result: RESULT });
});

describe('assistantPlanFromEntitlements', () => {
  it('essai actif → Premium, donc IA éligible (§6.5)', () => {
    const p = assistantPlanFromEntitlements({ plan: 'trial', premiumFeatures: true }, 'STANDARD');
    expect(p).toBe('PREMIUM');
    expect(isPlanAiEligible(p)).toBe(true);
  });
  // Lot 113AE (#728) : code cognitif STANDARD = T2 complet. Jamais un PREMIUM simulé ;
  // l'appel modèle d'un compte restreint est coupé par l'accès IA (droits réels), pas par l'offre.
  it('Standard, essai expiré ou abonnement suspendu → code STANDARD (T2 cognitif complet, jamais PREMIUM)', () => {
    for (const plan of ['standard', 'none'] as const) {
      const p = assistantPlanFromEntitlements({ plan, premiumFeatures: false }, 'PREMIUM');
      expect(p).toBe('STANDARD');
      expect(isPlanAiEligible(p)).toBe(true);
    }
  });
  it('Premium et Duo suivent les droits du compte, pas le JWT', () => {
    expect(assistantPlanFromEntitlements({ plan: 'premium', premiumFeatures: true }, 'STANDARD')).toBe('PREMIUM');
    expect(assistantPlanFromEntitlements({ plan: 'premium_duo', premiumFeatures: true }, 'STANDARD')).toBe('PREMIUM_DUO');
    expect(assistantPlanFromEntitlements({ plan: 'premium', premiumFeatures: true }, 'PREMIUM_PRO')).toBe('PREMIUM_PRO');
  });
});

describe('lot 113AE (#728) — accès IA effectif : Standard actif OUI, essai actif OUI, compte restreint NON', () => {
  const E = (o: Record<string, unknown>) => ({ plan: 'standard', status: 'active', premiumFeatures: false, canWrite: true, canRead: true, isRestricted: false, ...o }) as never;
  it('Standard actif : appels modèle autorisés, offre réelle « standard », AUCUN droit Premium', () => {
    const a = assistantAiAccessFromEntitlements(E({}));
    expect(a).toEqual({ modelCalls: true, denial: null, commercialPlan: 'standard', status: 'active', premiumFeatures: false, canWrite: true });
  });
  it('essai actif, Premium, Premium Duo : autorisés, droit Premium réel', () => {
    for (const plan of ['trial', 'premium', 'premium_duo']) {
      const a = assistantAiAccessFromEntitlements(E({ plan, status: plan === 'trial' ? 'trialing' : 'active', premiumFeatures: true }));
      expect(a.modelCalls).toBe(true);
      expect(a.premiumFeatures).toBe(true);
      expect(a.commercialPlan).toBe(plan);
    }
  });
  it('readonly, past_due, canceled, none : AUCUN appel modèle, motif de limite conservé', () => {
    const cas: Array<[string, string]> = [['readonly', 'TRIAL_EXPIRED'], ['past_due', 'SUBSCRIPTION_REQUIRED'], ['canceled', 'SUBSCRIPTION_REQUIRED'], ['none', 'SUBSCRIPTION_REQUIRED']];
    for (const [status, denial] of cas) {
      const a = assistantAiAccessFromEntitlements(E({ plan: 'none', status, canWrite: false, isRestricted: true }));
      expect(a.modelCalls).toBe(false);
      expect(a.denial).toBe(denial);
      expect(accountAllowsModelCalls({ planType: 'STANDARD', aiAccess: a })).toBe(false);
    }
  });
  it('canRead=false : NO_ACCESS, aucun appel', () => {
    const a = assistantAiAccessFromEntitlements(E({ plan: 'none', status: 'none', canWrite: false, canRead: false, isRestricted: true }));
    expect(a).toMatchObject({ modelCalls: false, denial: 'NO_ACCESS' });
  });
  it('statut inconnu (écriture permise) : prudence, aucun appel', () => {
    expect(assistantAiAccessFromEntitlements(E({ status: 'incomplete' })).modelCalls).toBe(false);
  });
  it('appel interne sans accès : une limite de compte suffit à tout couper', () => {
    expect(accountAllowsModelCalls({ planType: 'STANDARD' })).toBe(true);
    expect(accountAllowsModelCalls({ planType: 'STANDARD', planLimit: 'TRIAL_EXPIRED' })).toBe(false);
    expect(accountAllowsModelCalls({ planType: 'PREMIUM', planLimit: 'SUBSCRIPTION_REQUIRED' })).toBe(false);
  });
});

describe('routes : essai → IA éligible', () => {
  it('POST /api/verebona/messages transmet une offre éligible pendant l’essai', async () => {
    h.entitlements = { plan: 'trial', status: 'trialing', premiumFeatures: true, canWrite: true, canRead: true, isRestricted: false };
    const res = await messages.POST(post('http://t/api/verebona/messages', { message: 'Résume mes garanties', clientRequestId: 'c1' }));
    expect(res.status).toBe(200);
    const input = h.runAssistant.mock.calls[0][0];
    expect(input.planType).toBe('PREMIUM');
    expect(isPlanAiEligible(input.planType)).toBe(true);
    expect(input.aiAccess).toMatchObject({ modelCalls: true, commercialPlan: 'trial', premiumFeatures: true });
  });

  it('lot 113AE — POST /api/verebona/messages : Standard actif = T2 complet, offre réelle « standard », sans Premium', async () => {
    h.entitlements = { plan: 'standard', status: 'active', premiumFeatures: false, canWrite: true, canRead: true, isRestricted: false };
    await messages.POST(post('http://t/api/verebona/messages', { message: 'Bonjour', clientRequestId: 'c2' }));
    const input = h.runAssistant.mock.calls[0][0];
    // Jamais un PREMIUM simulé, jamais premiumFeatures=true.
    expect(input.planType).toBe('STANDARD');
    expect(input.planLimit).toBeNull();
    expect(input.aiAccess).toEqual({ modelCalls: true, denial: null, commercialPlan: 'standard', status: 'active', premiumFeatures: false, canWrite: true });
    expect(accountAllowsModelCalls(input)).toBe(true);
  });

  it('lot 113AE — POST clarifications/[id]/answer : Standard actif garde son accès IA réel en reprise', async () => {
    h.entitlements = { plan: 'standard', status: 'active', premiumFeatures: false, canWrite: true, canRead: true, isRestricted: false };
    await clarification.POST(
      post('http://t/api/verebona/clarifications/abc/answer', { choiceId: 'x', conversationId: 11 }),
      { params: Promise.resolve({ clarificationId: 'abc' }) },
    );
    const base = h.executerIssueClarification.mock.calls[0][1];
    expect(base.planType).toBe('STANDARD');
    expect(base.aiAccess).toMatchObject({ modelCalls: true, commercialPlan: 'standard', premiumFeatures: false });
  });

  it('lot 113AE — POST clarifications/[id]/answer : compte restreint, reprise SANS appel modèle', async () => {
    h.entitlements = { plan: 'none', status: 'readonly', premiumFeatures: false, canWrite: false, canRead: true, isRestricted: true };
    const res = await clarification.POST(
      post('http://t/api/verebona/clarifications/abc/answer', { choiceId: 'x', conversationId: 11 }),
      { params: Promise.resolve({ clarificationId: 'abc' }) },
    );
    expect(res.status).toBe(200);
    const base = h.executerIssueClarification.mock.calls[0][1];
    expect(base.planLimit).toBe('TRIAL_EXPIRED');
    expect(base.aiAccess).toMatchObject({ modelCalls: false, denial: 'TRIAL_EXPIRED' });
    expect(accountAllowsModelCalls(base)).toBe(false);
  });

  it('POST clarifications/[id]/answer : même dérivation', async () => {
    h.entitlements = { plan: 'trial', status: 'trialing', premiumFeatures: true, canWrite: true, canRead: true, isRestricted: false };
    const res = await clarification.POST(
      post('http://t/api/verebona/clarifications/abc/answer', { choiceId: 'x', conversationId: 11 }),
      { params: Promise.resolve({ clarificationId: 'abc' }) },
    );
    expect(res.status).toBe(200);
    expect(h.executerIssueClarification.mock.calls[0][1].planType).toBe('PREMIUM');
  });
});

describe('fin d’essai : recherche et aide restent disponibles (§6.5)', () => {
  it('essai échu (lecture seule) : pas de 403, AUCUN appel modèle autorisé, limite transmise', async () => {
    h.refus.mockClear();
    h.entitlements = { plan: 'none', premiumFeatures: false, canWrite: false, canRead: true, status: 'readonly', isRestricted: true };
    const res = await messages.POST(post('http://t/api/verebona/messages', { message: 'Retrouve ma facture', clientRequestId: 'c9' }));
    expect(res.status).toBe(200);
    const input = h.runAssistant.mock.calls[0][0];
    expect(input.planType).toBe('STANDARD');
    expect(input.planLimit).toBe('TRIAL_EXPIRED');
    expect(input.aiAccess).toMatchObject({ modelCalls: false, denial: 'TRIAL_EXPIRED', commercialPlan: 'none' });
    expect(accountAllowsModelCalls(input)).toBe(false);
    expect(h.refus).not.toHaveBeenCalled();
  });

  it('impayé (past_due) et résilié (canceled) : aucun appel modèle autorisé', async () => {
    for (const status of ['past_due', 'canceled']) {
      h.runAssistant.mockClear();
      h.entitlements = { plan: 'none', premiumFeatures: false, canWrite: false, canRead: true, status, isRestricted: true };
      await messages.POST(post('http://t/api/verebona/messages', { message: 'Résume mes garanties', clientRequestId: `c-${status}` }));
      const input = h.runAssistant.mock.calls[0][0];
      expect(input.planLimit).toBe('SUBSCRIPTION_REQUIRED');
      expect(accountAllowsModelCalls(input)).toBe(false);
    }
  });

  it('compte non consultable : refus comme avant', async () => {
    h.refus.mockClear().mockResolvedValueOnce(new Response(JSON.stringify({ code: 'SUBSCRIPTION_REQUIRED' }), { status: 403 }));
    h.entitlements = { plan: 'none', premiumFeatures: false, canWrite: false, canRead: false, status: 'none' };
    const res = await messages.POST(post('http://t/api/verebona/messages', { message: 'Retrouve ma facture', clientRequestId: 'c10' }));
    expect(res.status).toBe(403);
    expect(h.runAssistant).not.toHaveBeenCalled();
  });

  it('lot 113AE — canRead=false : refus même si la garde ne répond rien (messages ET clarifications)', async () => {
    h.refus.mockClear().mockResolvedValue(null);
    h.entitlements = { plan: 'none', premiumFeatures: false, canWrite: false, canRead: false, status: 'none' };
    const res = await messages.POST(post('http://t/api/verebona/messages', { message: 'Résume', clientRequestId: 'c11' }));
    expect(res.status).toBe(403);
    expect(h.runAssistant).not.toHaveBeenCalled();
    const res2 = await clarification.POST(
      post('http://t/api/verebona/clarifications/abc/answer', { choiceId: 'x', conversationId: 11 }),
      { params: Promise.resolve({ clarificationId: 'abc' }) },
    );
    expect(res2.status).toBe(403);
    expect(h.executerIssueClarification).not.toHaveBeenCalled();
  });
});
