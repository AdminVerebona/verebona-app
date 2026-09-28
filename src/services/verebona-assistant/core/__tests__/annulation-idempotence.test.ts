/**
 * Annulation effective, idempotence et verrou par fil — CDC §6.6, §7.8, §9.7,
 * §27.5, §31.9, CA-22, CA-29, 37.17, 37.20.
 *
 * Une base en mémoire rejoue les requêtes de `request-lifecycle.service` et
 * de `persistResult` : ce qui est vérifié, c'est l'ENCHAÎNEMENT (réservation
 * au début, relecture sous verrou à la fin), pas la syntaxe SQL.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

type Run = { id: number; request_id: string; client_request_id: string | null; conversation_id: number; account_id: number; user_id: number; status: string; created_at: Date };

const h = vi.hoisted(() => ({
  runs: [] as Run[],
  sql: [] as string[],
  runAssistant: vi.fn(),
}));

function unsafe(q: string, p: unknown[] = []): unknown[] {
  h.sql.push(q);
  const runs = h.runs;
  if (/pg_advisory_xact_lock/.test(q)) return [];
  if (/FROM verebona_request_runs\s+WHERE account_id = \$1 AND user_id = \$2 AND client_request_id = \$3/.test(q)) {
    return runs.filter((r) => r.account_id === p[0] && r.user_id === p[1] && r.client_request_id === p[2]).slice(-1);
  }
  if (/WHERE conversation_id = \$1 AND status = 'pending'/.test(q)) {
    const limite = Date.now() - Number(p[1]);
    return runs.filter((r) => r.conversation_id === p[0] && r.status === 'pending' && r.created_at.getTime() > limite).slice(-1);
  }
  if (/^\s*INSERT INTO verebona_request_runs[\s\S]*'pending'/.test(q)) {
    if (runs.some((r) => r.account_id === p[3] && r.user_id === p[4] && r.client_request_id === p[1])) return [];
    runs.push({ id: runs.length + 1, request_id: String(p[0]), client_request_id: String(p[1]), conversation_id: Number(p[2]), account_id: Number(p[3]), user_id: Number(p[4]), status: 'pending', created_at: new Date() });
    return [{ request_id: p[0] }];
  }
  if (/UPDATE verebona_request_runs SET created_at = now\(\)/.test(q)) {
    const r = runs.find((x) => x.request_id === p[0]); if (r) r.created_at = new Date();
    return [];
  }
  if (/SELECT 1 FROM verebona_request_runs WHERE request_id = \$1 AND status = 'cancelled'/.test(q)) {
    return runs.filter((r) => r.request_id === p[0] && r.status === 'cancelled').map(() => 1);
  }
  if (/UPDATE verebona_request_runs SET status = \$2/.test(q)) {
    const r = runs.find((x) => x.request_id === p[0] && x.status === 'pending'); if (r) r.status = String(p[1]);
    return [];
  }
  if (/SELECT status FROM verebona_request_runs WHERE request_id = \$1 LIMIT 1/.test(q)) {
    return runs.filter((r) => r.request_id === p[0]).map((r) => ({ status: r.status }));
  }
  // persistResult
  if (/SELECT id FROM verebona_conversations[\s\S]*FOR UPDATE/.test(q)) return [{ id: p[0] }];
  if (/SELECT status FROM verebona_request_runs\s+WHERE request_id = \$1 AND account_id = \$2 FOR UPDATE/.test(q)) {
    return runs.filter((r) => r.request_id === p[0]).map((r) => ({ status: r.status }));
  }
  if (/INSERT INTO verebona_messages/.test(q)) return [{ id: 99 }];
  return [];
}

vi.mock('@/db', () => ({
  pgClient: {
    unsafe: vi.fn(async (q: string, p?: unknown[]) => unsafe(q, p)),
    begin: vi.fn(async (cb: (tx: unknown) => unknown) => cb({ unsafe: async (q: string, p?: unknown[]) => unsafe(q, p) })),
  },
  db: {},
  ensureMigrations: vi.fn(async () => {}),
  ensureUnaccent: vi.fn(async () => {}),
}));

const { reserveRequest, isRequestCancelled, closePendingRequest } = await import('../request-lifecycle.service');
const { persistResult } = await import('../conversation.service');
const { runAssistant } = await import('../assistant-orchestrator.service');

const BASE = { accountId: 7, userId: 3, conversationId: 11, staleAfterMs: 30_000 };

beforeEach(() => {
  h.runs.length = 0;
  h.sql.length = 0;
});

describe('réservation au début du traitement', () => {
  it('première demande : réservée, ligne « pending » écrite AVANT le traitement', async () => {
    const r = await reserveRequest({ ...BASE, clientRequestId: 'c1' });
    expect(r.kind).toBe('reserved');
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0].status).toBe('pending');
  });

  it('même envoi en double (double clic) : aucune seconde réservation (§31.9, 37.17)', async () => {
    const a = await reserveRequest({ ...BASE, clientRequestId: 'c1' });
    const b = await reserveRequest({ ...BASE, clientRequestId: 'c1' });
    expect(b).toEqual({ kind: 'duplicate_in_progress', requestId: (a as { requestId: string }).requestId });
    expect(h.runs).toHaveLength(1);
  });

  it('autre question dans le même fil pendant le traitement : refusée (§6.6)', async () => {
    await reserveRequest({ ...BASE, clientRequestId: 'c1' });
    const b = await reserveRequest({ ...BASE, clientRequestId: 'c2' });
    expect(b.kind).toBe('thread_busy');
  });

  it('un autre fil n’est pas bloqué', async () => {
    await reserveRequest({ ...BASE, clientRequestId: 'c1' });
    const b = await reserveRequest({ ...BASE, conversationId: 12, clientRequestId: 'c2' });
    expect(b.kind).toBe('reserved');
  });

  it('demande terminée : le fil se libère', async () => {
    const a = await reserveRequest({ ...BASE, clientRequestId: 'c1' });
    await closePendingRequest((a as { requestId: string }).requestId, 'ok');
    expect((await reserveRequest({ ...BASE, clientRequestId: 'c2' })).kind).toBe('reserved');
    expect((await reserveRequest({ ...BASE, clientRequestId: 'c1' })).kind).toBe('duplicate_finished');
  });

  it('réservation abandonnée (processus tué) : reprise après expiration', async () => {
    const a = await reserveRequest({ ...BASE, clientRequestId: 'c1' });
    h.runs[0].created_at = new Date(Date.now() - 60_000);
    const b = await reserveRequest({ ...BASE, clientRequestId: 'c1' });
    expect(b).toEqual({ kind: 'reserved', requestId: (a as { requestId: string }).requestId });
    expect((await reserveRequest({ ...BASE, clientRequestId: 'c2' })).kind).toBe('thread_busy');
  });
});

describe('annulation effective (§7.8, CA-22, 37.20)', () => {
  const RESULT = {
    requestId: '', messageId: 'm', finalState: 'READY', mode: 'ai', route: { intent: 'ACCOUNT_SUMMARY' },
    answer: 'Réponse tardive.', supportLevel: 'supported', claims: [], sources: [], actions: [], clarification: null,
  };
  const INPUT = { accountId: 7, userId: 3, planType: 'PREMIUM', message: 'Résume', clientRequestId: 'c1', locale: 'fr-FR', conversationId: 11 };

  it('annulée pendant le traitement : la réponse tardive n’est PAS enregistrée', async () => {
    const r = await reserveRequest({ ...BASE, clientRequestId: 'c1' });
    const id = (r as { requestId: string }).requestId;
    h.runs[0].status = 'cancelled'; // DELETE /requests/c1
    expect(await isRequestCancelled(id)).toBe(true);
    const ids = await persistResult({ ...RESULT, requestId: id } as never, INPUT as never);
    expect(ids).toBeNull();
    expect(h.sql.some((q) => /INSERT INTO verebona_messages/.test(q))).toBe(false);
    expect(h.runs[0].status).toBe('cancelled');
  });

  it('non annulée : la réponse est enregistrée et la réservation complétée (pas de second INSERT de trace)', async () => {
    const r = await reserveRequest({ ...BASE, clientRequestId: 'c1' });
    const id = (r as { requestId: string }).requestId;
    const ids = await persistResult({ ...RESULT, requestId: id } as never, INPUT as never);
    expect(ids).toEqual({ conversationId: 11, messageId: 99 });
    expect(h.sql.filter((q) => /INSERT INTO verebona_request_runs/.test(q))).toHaveLength(1); // la réservation seule
    expect(h.sql.some((q) => /UPDATE verebona_request_runs\s+SET client_request_id/.test(q))).toBe(true);
  });

  it('orchestrateur : demande annulée avant la génération → aucun appel modèle, état CANCELLED', async () => {
    const generateWithAI = vi.fn();
    const out = await runAssistant({ ...INPUT, message: 'Résume les garanties de mon vélo', requestId: 'req-x' } as never, {
      retrieve: async () => [{ id: 'doc_1', type: 'document', title: 'Garantie', content: 'Deux ans.', relevanceScore: 0.9 }] as never,
      resolveSources: async (s) => s as never,
      resolveActions: async () => [],
      persist: async () => null,
      hasPendingClarification: async () => false,
      generateWithAI,
      isCancelled: async () => true,
    });
    expect(generateWithAI).not.toHaveBeenCalled();
    expect(out.finalState).toBe('CANCELLED');
    expect(out.requestId).toBe('req-x');
  });
});

describe('route POST /api/verebona/messages : deux envois identiques → UN seul traitement', () => {
  it('le second envoi pendant le premier reçoit 409, le pipeline ne tourne qu’une fois', async () => {
    vi.doMock('@/lib/session-service', () => ({
      SessionService: { getSession: vi.fn(async () => ({ userId: 3, currentAccountId: 7, planType: 'PREMIUM' })), handleSessionError: vi.fn() },
    }));
    vi.doMock('@/lib/rate-limiter', () => ({ rateLimiter: { check: () => ({ allowed: true }) }, getClientIp: () => '1.2.3.4' }));
    vi.doMock('@/services/entitlements.service', () => ({ getEntitlements: vi.fn(async () => ({ plan: 'premium', premiumFeatures: true, canWrite: true })) }));
    vi.doMock('@/lib/write-access-guard', () => ({ refuserSiPasDIA: vi.fn(async () => null) }));
    vi.doMock('@/services/verebona-assistant/core/ports', () => ({ buildOrchestratorPorts: () => ({ hasPendingClarification: async () => false }) }));
    vi.doMock('@/services/verebona-assistant/core/conversation.service', () => ({
      ConversationNotFoundError: class extends Error {},
      findReplayedAnswer: vi.fn(async () => null),
      resolveConversation: vi.fn(async () => 11),
    }));
    let liberer: () => void = () => {};
    h.runAssistant.mockImplementation(async (input: { requestId: string }) => {
      await new Promise<void>((r) => { liberer = r; });
      return { requestId: input.requestId, messageId: '1', finalState: 'READY', mode: 'deterministic', route: { intent: 'GREETING' }, answer: 'ok', supportLevel: null, claims: [], sources: [], actions: [], clarification: null };
    });
    vi.doMock('@/services/verebona-assistant', async (orig) => ({
      ...(await orig<typeof import('@/services/verebona-assistant')>()),
      runAssistant: h.runAssistant,
      ensureAssistantStartupChecked: () => ({ ok: true }),
    }));
    vi.resetModules();
    const route = await import('@/app/api/verebona/messages/route');
    const post = () => new NextRequest('http://x/api/verebona/messages', {
      method: 'POST', body: JSON.stringify({ message: 'Bonjour', clientRequestId: 'same-id' }), headers: { 'content-type': 'application/json' },
    });
    const premier = route.POST(post());
    await vi.waitFor(() => expect(h.runAssistant).toHaveBeenCalledTimes(1));
    const second = await route.POST(post());
    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe('REQUEST_IN_PROGRESS');
    liberer();
    expect((await premier).status).toBe(200);
    expect(h.runAssistant).toHaveBeenCalledTimes(1);
    // La réservation est close : le fil est libre.
    expect(h.runs[0].status).toBe('ok');
  });
});
