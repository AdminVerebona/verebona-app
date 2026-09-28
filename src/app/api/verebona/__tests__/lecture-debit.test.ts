/**
 * Conventions API de l'assistant pour les LECTURES — CDC §27 (préambule :
 * « toutes les routes appliquent les limitations de débit, journalisent un
 * requestId, valident les entrées avec un schéma »).
 *
 * Routes concernées : explication, sources, historique (GET conversation),
 * état d'une demande, suggestions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  userId: 500,
  accountId: 7000,
  unsafe: vi.fn(async () => [] as unknown[]),
  suggestionsForRoute: vi.fn((_route: string, _state: unknown) => [{ id: 's1', label: 'Que dois-je traiter ?' }]),
}));

vi.mock('@/db', () => ({ ensureMigrations: vi.fn(async () => {}), pgClient: Object.assign(h.unsafe, { unsafe: h.unsafe }), db: {} }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: vi.fn(async () => ({ userId: h.userId, currentAccountId: h.accountId, planType: 'PREMIUM' })),
    handleSessionError: vi.fn(),
  },
}));
vi.mock('@/services/verebona-assistant/core/conversation.service', () => ({
  findLatestConversation: vi.fn(async () => null),
  findOwnedConversation: vi.fn(async () => null),
  listActiveMessages: vi.fn(async () => ({ messages: [], nextCursor: null })),
  clearUserHistory: vi.fn(async () => ({ conversations: 0, messages: 0, cachedModelResponses: 0 })),
  MESSAGE_OWNED_BY_USER: () => 'TRUE',
}));
vi.mock('@/services/verebona-assistant/core/clarification.service', () => ({ chargerClarification: vi.fn(async () => ({ etat: null })) }));
vi.mock('@/services/verebona-assistant/commands/plan.service', () => ({ listThreadCommandPlans: vi.fn(async () => []) }));
vi.mock('@/services/verebona-assistant/core/source-availability.service', () => ({
  reverifierCartesDesMessages: vi.fn(async (m: unknown) => m),
  marquerDisponibilite: vi.fn(async (s: unknown) => s),
}));
vi.mock('@/services/verebona-assistant/registries/capability-registry', () => ({ suggestionsForRoute: h.suggestionsForRoute }));
vi.mock('@/services/verebona-assistant/core/account-state', () => ({ loadAccountSuggestionState: vi.fn(async () => null) }));

const explanation = await import('../messages/[messageId]/explanation/route');
const sources = await import('../messages/[messageId]/sources/route');
const conversation = await import('../conversation/route');
const requests = await import('../requests/[requestId]/route');
const suggestions = await import('../suggestions/route');
const { checkAssistantReadRateLimit, readRatePerMinute } = await import('@/lib/verebona/rate-limit');
const { SuggestionsQuerySchema } = await import('@/lib/verebona/api-schemas');

const get = (url: string, headers: Record<string, string> = {}) => new NextRequest(url, { method: 'GET', headers });
const msg = { params: Promise.resolve({ messageId: '12' }) };

let utilisateur = 500;
beforeEach(() => {
  // Un utilisateur neuf par test : le limiteur est un état du processus.
  h.userId = ++utilisateur;
  h.accountId += 1;
  h.suggestionsForRoute.mockClear();
});

/** Épuise le quota de lecture de l'utilisateur courant. */
const epuiser = () => { for (let i = 0; i < readRatePerMinute(); i++) checkAssistantReadRateLimit(h.userId, h.accountId); };

describe('§27 — les lectures sont limitées en débit', () => {
  it.each([
    ['explication', () => explanation.GET(get('http://x/e'), { params: Promise.resolve({ messageId: '12' }) })],
    ['sources', () => sources.GET(get('http://x/s'), { params: Promise.resolve({ messageId: '12' }) })],
    ['historique', () => conversation.GET(get('http://x/api/verebona/conversation'))],
    ['état d’une demande', () => requests.GET(get('http://x/r'), { params: Promise.resolve({ requestId: 'req-123456' }) })],
    ['suggestions', () => suggestions.GET(get('http://x/api/verebona/suggestions?route=/'))],
  ] as const)('%s : quota épuisé → 429 RATE_LIMITED, Retry-After et x-request-id', async (_nom, appel) => {
    expect((await appel()).status).not.toBe(429);
    epuiser();
    const res = await appel();
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(res.headers.get('x-request-id')).toBeTruthy();
    expect(await res.json()).toMatchObject({ status: 'error', error: { code: 'RATE_LIMITED', recoverable: true } });
  });

  it('quota des lectures distinct de celui des écritures et des questions', async () => {
    epuiser();
    const { checkAssistantMutationRateLimit, checkAssistantRateLimit } = await import('@/lib/verebona/rate-limit');
    expect(checkAssistantMutationRateLimit(h.userId, h.accountId, 'feedback').allowed).toBe(true);
    expect(checkAssistantRateLimit(h.userId, h.accountId, 10).allowed).toBe(true);
  });

  it('quota par compte : 3× le quota utilisateur, partagé par les membres', () => {
    const n = readRatePerMinute();
    for (let u = 0; u < 3; u++) for (let i = 0; i < n; i++) checkAssistantReadRateLimit(9000 + u, 99);
    expect(checkAssistantReadRateLimit(9100, 99)).toMatchObject({ allowed: false, scope: 'account' });
  });
});

describe('§27 — requestId renvoyé sur les lectures', () => {
  it('x-request-id repris de la demande sur explication, sources et état', async () => {
    const hdr = { 'x-request-id': 'req-lecture-01' };
    expect((await explanation.GET(get('http://x/e', hdr), msg)).headers.get('x-request-id')).toBe('req-lecture-01');
    expect((await sources.GET(get('http://x/s', hdr), { params: Promise.resolve({ messageId: '12' }) })).headers.get('x-request-id')).toBe('req-lecture-01');
    expect((await requests.GET(get('http://x/r', hdr), { params: Promise.resolve({ requestId: 'req-123456' }) })).headers.get('x-request-id')).toBe('req-lecture-01');
  });
});

describe('§27 — suggestions : schéma zod et x-request-id', () => {
  it('réponse normale : suggestions du catalogue et x-request-id', async () => {
    const res = await suggestions.GET(get('http://x/api/verebona/suggestions?route=/biens/12', { 'x-request-id': 'req-sugg-0001' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe('req-sugg-0001');
    expect(await res.json()).toEqual({ suggestions: [{ id: 's1', label: 'Que dois-je traiter ?' }] });
    expect(h.suggestionsForRoute).toHaveBeenCalledWith('/biens/12', null);
  });

  it('chemin hors motif interne (URL, caractères spéciaux) → suggestions génériques « / »', async () => {
    await suggestions.GET(get('http://x/api/verebona/suggestions?route=' + encodeURIComponent('https://evil.example/x')));
    expect(h.suggestionsForRoute).toHaveBeenCalledWith('/', null);
    expect(SuggestionsQuerySchema.parse({}).route).toBe('/');
  });

  it('route démesurée → 400 VALIDATION_FAILED (INVALID_ROUTE), x-request-id présent', async () => {
    const res = await suggestions.GET(get('http://x/api/verebona/suggestions?route=/' + 'a'.repeat(600)));
    expect(res.status).toBe(400);
    expect(res.headers.get('x-request-id')).toBeTruthy();
    expect((await res.json()).error).toMatchObject({ code: 'VALIDATION_FAILED', reason: 'INVALID_ROUTE' });
  });
});
