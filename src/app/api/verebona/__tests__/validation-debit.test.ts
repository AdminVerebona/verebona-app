/**
 * Conventions API de l'assistant — CDC §27 (préambule), §27.6, §27.11, §31.10.
 *
 *   · toute entrée est validée par un schéma : invalide → VALIDATION_FAILED ;
 *   · un requestId est journalisé et renvoyé (x-request-id) ;
 *   · toutes les routes qui écrivent passent par le limiteur de l'assistant ;
 *   · l'historique se pagine par curseur (limit ≤ 50, cursor / before).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  userId: 3,
  listActiveMessages: vi.fn(async () => ({ messages: [{ id: 9, role: 'user' }], nextCursor: 9 })),
  unsafe: vi.fn(async () => [] as unknown[]),
}));

vi.mock('@/db', () => ({ ensureMigrations: vi.fn(async () => {}), pgClient: Object.assign(h.unsafe, { unsafe: h.unsafe }), db: {} }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: vi.fn(async () => ({ userId: h.userId, currentAccountId: 7, planType: 'PREMIUM' })),
    handleSessionError: vi.fn(),
  },
}));
vi.mock('@/services/verebona-assistant', () => ({
  runAssistant: vi.fn(),
  getAssistantConfig: () => ({ enabled: true, locale: 'fr-FR', totalTimeoutMs: 20_000, rateLimitPerMinute: 10 }),
  ensureAssistantStartupChecked: () => ({ ok: true }),
}));
vi.mock('@/services/verebona-assistant/core/conversation.service', () => ({
  ConversationNotFoundError: class extends Error {},
  findReplayedAnswer: vi.fn(async () => null),
  resolveConversation: vi.fn(async () => 11),
  findLatestConversation: vi.fn(async () => 11),
  findOwnedConversation: vi.fn(async () => 11),
  listActiveMessages: h.listActiveMessages,
  clearUserHistory: vi.fn(async () => ({ conversations: 1, messages: 0, cachedModelResponses: 0 })),
  MESSAGE_OWNED_BY_USER: () => 'TRUE',
}));
vi.mock('@/services/verebona-assistant/core/clarification.service', () => ({ chargerClarification: vi.fn(async () => ({ etat: null })) }));
vi.mock('@/services/verebona-assistant/commands/plan.service', () => ({ listThreadCommandPlans: vi.fn(async () => []) }));
vi.mock('@/services/verebona-assistant/core/source-availability.service', () => ({
  reverifierCartesDesMessages: vi.fn(async (m: unknown) => m),
  marquerDisponibilite: vi.fn(async (s: unknown) => s),
}));

const messages = await import('../messages/route');
const feedback = await import('../messages/[messageId]/feedback/route');
const conversation = await import('../conversation/route');
const requests = await import('../requests/[requestId]/route');
const { PostMessageSchema, ConversationQuerySchema, FeedbackSchema } = await import('@/lib/verebona/api-schemas');
const { checkAssistantMutationRateLimit } = await import('@/lib/verebona/rate-limit');

const req = (url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(url, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), headers: { 'content-type': 'application/json', ...headers } });

let utilisateur = 100;
beforeEach(() => {
  // Un utilisateur neuf par test : le limiteur est un état du processus.
  h.userId = ++utilisateur;
  h.listActiveMessages.mockClear();
});

describe('§27 — validation par schéma, VALIDATION_FAILED', () => {
  it('POST messages : message vide → 400 VALIDATION_FAILED (motif EMPTY_MESSAGE), requestId renvoyé', async () => {
    const res = await messages.POST(req('http://x/api/verebona/messages', 'POST', { message: '   ', clientRequestId: 'c1' }, { 'x-request-id': 'req-abcdef12' }));
    expect(res.status).toBe(400);
    expect(res.headers.get('x-request-id')).toBe('req-abcdef12');
    expect(await res.json()).toMatchObject({ status: 'error', error: { code: 'VALIDATION_FAILED', reason: 'EMPTY_MESSAGE', recoverable: false } });
  });

  it('POST messages : trop long, identifiant client manquant ou fil mal formé', async () => {
    const code = async (b: unknown) => (await (await messages.POST(req('http://x/m', 'POST', b))).json()).error.reason;
    expect(await code({ message: 'x'.repeat(2001), clientRequestId: 'c' })).toBe('MESSAGE_TOO_LONG');
    expect(await code({ message: 'bonjour' })).toBe('MISSING_CLIENT_REQUEST_ID');
    expect(await code({ message: 'bonjour', clientRequestId: 'c', conversationId: 'abc' })).toBe('CONVERSATION_NOT_FOUND');
  });

  it('schémas : valeurs typées, clés inconnues ignorées', () => {
    const r = PostMessageSchema.safeParse({ message: '  Où est ma facture ?  ', clientRequestId: 'c-1', conversationId: '12', inconnue: 1 });
    expect(r.success && r.data).toMatchObject({ message: 'Où est ma facture ?', conversationId: 12 });
    expect(r.success && 'inconnue' in r.data).toBe(false);
    expect(FeedbackSchema.safeParse({ value: 'helpful', reason: 'too_long' }).success).toBe(true);
    expect(FeedbackSchema.safeParse({ value: 'meh' }).success).toBe(false);
    expect(ConversationQuerySchema.safeParse({ limit: '51' }).success).toBe(false);
  });

  it('feedback : identifiant de message non numérique ou valeur hors liste → VALIDATION_FAILED', async () => {
    const r1 = await feedback.POST(req('http://x/f', 'POST', { value: 'helpful' }), { params: Promise.resolve({ messageId: 'abc' }) });
    expect(r1.status).toBe(400);
    expect((await r1.json()).error).toMatchObject({ code: 'VALIDATION_FAILED', reason: 'INVALID_MESSAGE_ID' });
    const r2 = await feedback.POST(req('http://x/f', 'POST', { value: 'bof' }), { params: Promise.resolve({ messageId: '12' }) });
    expect((await r2.json()).error).toMatchObject({ code: 'VALIDATION_FAILED', reason: 'INVALID_VALUE' });
  });
});

describe('§31.10 — limiteur sur toutes les routes qui écrivent', () => {
  it('feedback : au-delà du quota par minute → 429 RATE_LIMITED', async () => {
    let dernier = 200;
    for (let i = 0; i < 31; i++) {
      dernier = (await feedback.POST(req('http://x/f', 'POST', { value: 'helpful' }), { params: Promise.resolve({ messageId: '12' }) })).status;
    }
    expect(dernier).toBe(429);
  });

  it('annulation d’une demande et effacement d’un fil sont limités', async () => {
    for (let i = 0; i < 30; i++) await checkAssistantMutationRateLimit(h.userId, 7, 'cancel');
    const r = await requests.DELETE(req('http://x/r', 'DELETE'), { params: Promise.resolve({ requestId: 'abc' }) });
    expect(r.status).toBe(429);
    for (let i = 0; i < 30; i++) await checkAssistantMutationRateLimit(h.userId, 7, 'conversation');
    expect((await conversation.DELETE(req('http://x/c', 'DELETE'))).status).toBe(429);
  });

  it('quotas séparés : les avis ne consomment pas celui des fils', async () => {
    for (let i = 0; i < 30; i++) await checkAssistantMutationRateLimit(h.userId, 7, 'feedback');
    expect((await checkAssistantMutationRateLimit(h.userId, 7, 'feedback')).allowed).toBe(false);
    expect((await checkAssistantMutationRateLimit(h.userId, 7, 'conversation')).allowed).toBe(true);
  });
});

describe('§27.6 — historique paginé par curseur', () => {
  it('limit et cursor transmis ; nextCursor renvoyé', async () => {
    const res = await conversation.GET(req('http://x/api/verebona/conversation?conversationId=11&limit=20&cursor=40'));
    expect(res.status).toBe(200);
    expect(h.listActiveMessages).toHaveBeenCalledWith(7, h.userId, 11, { limit: 20, before: 40 });
    expect(await res.json()).toMatchObject({ conversationId: 11, nextCursor: 9 });
  });

  it('`before` est accepté comme curseur ; limit > 50 refusé', async () => {
    await conversation.GET(req('http://x/api/verebona/conversation?before=33'));
    expect(h.listActiveMessages).toHaveBeenCalledWith(7, h.userId, 11, { limit: undefined, before: 33 });
    const r = await conversation.GET(req('http://x/api/verebona/conversation?limit=200'));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatchObject({ code: 'VALIDATION_FAILED', reason: 'INVALID_LIMIT' });
  });
});
