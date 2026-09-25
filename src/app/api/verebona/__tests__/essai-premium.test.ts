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
  entitlements: { plan: 'trial', premiumFeatures: true, canWrite: true } as Record<string, unknown>,
  runAssistant: vi.fn(),
  executerIssueClarification: vi.fn(),
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
vi.mock('@/services/entitlements.service', () => ({ getEntitlements: vi.fn(async () => h.entitlements) }));
vi.mock('@/lib/write-access-guard', () => ({ refuserSiPasDIA: vi.fn(async () => null) }));
vi.mock('@/services/verebona-assistant', () => ({
  runAssistant: h.runAssistant,
  getAssistantConfig: () => ({ enabled: true, locale: 'fr-FR' }),
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
  it('Standard, essai expiré ou abonnement suspendu → Standard, sans IA', () => {
    for (const plan of ['standard', 'none'] as const) {
      const p = assistantPlanFromEntitlements({ plan, premiumFeatures: false }, 'PREMIUM');
      expect(p).toBe('STANDARD');
      expect(isPlanAiEligible(p)).toBe(false);
    }
  });
  it('Premium et Duo suivent les droits du compte, pas le JWT', () => {
    expect(assistantPlanFromEntitlements({ plan: 'premium', premiumFeatures: true }, 'STANDARD')).toBe('PREMIUM');
    expect(assistantPlanFromEntitlements({ plan: 'premium_duo', premiumFeatures: true }, 'STANDARD')).toBe('PREMIUM_DUO');
    expect(assistantPlanFromEntitlements({ plan: 'premium', premiumFeatures: true }, 'PREMIUM_PRO')).toBe('PREMIUM_PRO');
  });
});

describe('routes : essai → IA éligible', () => {
  it('POST /api/verebona/messages transmet une offre éligible pendant l’essai', async () => {
    h.entitlements = { plan: 'trial', premiumFeatures: true, canWrite: true };
    const res = await messages.POST(post('http://t/api/verebona/messages', { message: 'Résume mes garanties', clientRequestId: 'c1' }));
    expect(res.status).toBe(200);
    const input = h.runAssistant.mock.calls[0][0];
    expect(input.planType).toBe('PREMIUM');
    expect(isPlanAiEligible(input.planType)).toBe(true);
  });

  it('POST /api/verebona/messages reste Standard sans fonctions Premium', async () => {
    h.entitlements = { plan: 'standard', premiumFeatures: false, canWrite: true };
    await messages.POST(post('http://t/api/verebona/messages', { message: 'Bonjour', clientRequestId: 'c2' }));
    expect(h.runAssistant.mock.calls[0][0].planType).toBe('STANDARD');
  });

  it('POST clarifications/[id]/answer : même dérivation', async () => {
    h.entitlements = { plan: 'trial', premiumFeatures: true, canWrite: true };
    const res = await clarification.POST(
      post('http://t/api/verebona/clarifications/abc/answer', { choiceId: 'x', conversationId: 11 }),
      { params: Promise.resolve({ clarificationId: 'abc' }) },
    );
    expect(res.status).toBe(200);
    expect(h.executerIssueClarification.mock.calls[0][1].planType).toBe('PREMIUM');
  });
});
