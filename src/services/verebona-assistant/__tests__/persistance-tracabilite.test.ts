/**
 * Traçabilité persistée — CDC §28.2, §28.6, §28.7, §28.8, §27.6, §43.
 *
 * Joué contre un faux client SQL qui enregistre chaque requête : on vérifie
 * ce qui est réellement ÉCRIT (colonnes et valeurs), pas le texte du code.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const repondre = (sql: string): unknown[] => {
    if (/FROM verebona_conversations[\s\S]*FOR UPDATE/.test(sql)) return [{ id: 5 }];
    if (/SELECT status FROM verebona_request_runs/.test(sql)) return [{ status: 'pending' }];
    if (/INSERT INTO verebona_messages[\s\S]*'user'/.test(sql)) return [{ id: 100 }];
    if (/INSERT INTO verebona_messages/.test(sql)) return [{ id: 101 }];
    if (/INSERT INTO verebona_message_sources|INSERT INTO verebona_message_claims/.test(sql)) return [{ id: 1 }];
    return [];
  };
  const unsafe = vi.fn(async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return repondre(sql); });
  return { calls, unsafe };
});

// R1 (lot 19) : colonne 0228 réputée présente — la détection de schéma
// n'entre pas dans la séquence de requêtes observée ici.
vi.mock('../core/timeline-persistence', async (o) => ({ ...(await o<object>()), timelineColumnReady: async () => true }));
vi.mock('@/db', () => ({
  pgClient: Object.assign(h.unsafe, {
    unsafe: h.unsafe,
    begin: async (fn: (tx: unknown) => unknown) => fn({ unsafe: h.unsafe }),
  }),
  ensureMigrations: vi.fn(async () => {}),
}));

const { persistResult, findReplayedAnswer, listActiveMessages, actionTarget } = await import('../core/conversation.service');
const { resetAssistantConfigForTests } = await import('../config/assistant-config');
type Result = import('../types/contracts').AssistantRunResult;
type Input = import('../types/contracts').AssistantRequestInput;

const INPUT: Input = { accountId: 7, userId: 3, planType: 'PREMIUM', message: 'Ouvre la facture', clientRequestId: 'c1', locale: 'fr-FR', conversationId: 5 };
const RESULT = (over: Partial<Result> = {}): Result => ({
  requestId: 'req-1', messageId: 'x', finalState: 'READY', mode: 'deterministic',
  route: { intent: 'ACCOUNT_SEARCH_DOCUMENT' } as Result['route'], answer: 'Voici la facture.', supportLevel: 'supported',
  claims: [], sources: [], clarification: null,
  actions: [{
    actionId: 'a1', type: 'OPEN_ASSET', label: 'Ouvrir le bien', href: '/assets/42?tab=equipments', token: null,
    requiresConfirmation: false, expiresAt: null, analyticsCode: 'verebona.action.open_asset',
    targetRef: 'asset:42', payload: { tab: 'equipments' },
  }],
  cascade: {
    intent: 'ACCOUNT_SEARCH_DOCUMENT', strategy: 's', answeredBy: 'retrieval', sufficiency: null, escalationReasons: [],
    attempts: [], sourceCount: 0, aiCalls: 0, model: null, thresholds: { database: 1, text: 1, source: 'x' }, latencyMs: 12,
  },
  ...over,
});

beforeEach(() => {
  h.calls.length = 0;
  delete process.env.VEREBONA_ASSISTANT_IDEMPOTENCY_TTL_SECONDS;
  resetAssistantConfigForTests();
});

const requete = (re: RegExp) => h.calls.find((c) => re.test(c.sql));

describe('§28.2 — versions de catalogue et message parent', () => {
  it('la réponse porte intent_catalog_version, action_catalog_version, schema_version et parent_message_id', async () => {
    await persistResult(RESULT(), INPUT);
    const q = requete(/INSERT INTO verebona_messages[\s\S]*'assistant'/)!;
    expect(q.sql).toMatch(/intent_catalog_version, schema_version, parent_message_id/);
    expect(q.params).toEqual(expect.arrayContaining(['intent-catalog-v1.0', 'assistant-response-v1.0', 100]));
    expect(q.params.some((p) => typeof p === 'string' && p.startsWith('action-catalog-'))).toBe(true);
  });
});

describe('§28.6 — cible et payload des actions', () => {
  it('target_type, target_id et payload_json écrits', async () => {
    await persistResult(RESULT(), INPUT);
    const q = requete(/INSERT INTO verebona_message_actions/)!;
    expect(q.sql).toMatch(/target_type, target_id, payload_json/);
    expect(q.params.slice(-3)).toEqual(['asset', '42', JSON.stringify({ tab: 'equipments' })]);
  });

  it('actionTarget : cible absente ou mal formée → nulle, payload vide', () => {
    expect(actionTarget({ targetRef: null })).toEqual({ targetType: null, targetId: null, payload: {} });
    expect(actionTarget({ targetRef: 'https://evil.example' })).toMatchObject({ targetType: null, targetId: null });
    expect(actionTarget({ targetRef: 'agenda_item:9', payload: { a: 1 } })).toEqual({ targetType: 'agenda_item', targetId: '9', payload: { a: 1 } });
  });
});

describe('§28.7 — cache_hit ; §28.8 — message_id des appels modèle', () => {
  it('cache_hit calculé (cache de retrieval OU appel servi par le cache)', async () => {
    await persistResult(RESULT({ cascade: { ...RESULT().cascade!, cacheHit: true } }), INPUT);
    const q = requete(/UPDATE verebona_request_runs[\s\S]*cache_hit/)!;
    expect(q.sql).toMatch(/cache_hit = \(\$16::boolean OR EXISTS \(SELECT 1 FROM verebona_ai_runs x/);
    expect(q.params[15]).toBe(true);
  });

  it('les appels modèle de la demande sont rattachés au message enregistré', async () => {
    await persistResult(RESULT(), INPUT);
    const q = requete(/UPDATE verebona_ai_runs SET message_id/)!;
    expect(q.params).toEqual([101, 'req-1', 7]);
  });
});

describe('§43 — fenêtre d’idempotence lue en configuration', () => {
  it('le rejeu est borné par IDEMPOTENCY_TTL_SECONDS', async () => {
    process.env.VEREBONA_ASSISTANT_IDEMPOTENCY_TTL_SECONDS = '120';
    resetAssistantConfigForTests();
    await findReplayedAnswer(7, 3, 'c1');
    const q = requete(/FROM verebona_messages q/)!;
    expect(q.sql).toMatch(/q\.created_at > now\(\) - \(\$4::int \* interval '1 second'\)/);
    expect(q.params[3]).toBe(120);
  });
});

describe('§28.12 — index alias + date et intention + date (migration 0204)', () => {
  it('migration idempotente, schéma Drizzle aligné', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const sql = readFileSync(join(process.cwd(), 'src/db/migrations/0204_verebona_assistant_observability.sql'), 'utf8');
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS verebona_ai_runs_alias_idx\s+ON verebona_ai_runs \(model_alias, created_at\)/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS verebona_request_runs_intent_idx\s+ON verebona_request_runs \(intent, created_at\)/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS expected_model_id/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS deprecation_date/);
    const schema = readFileSync(join(process.cwd(), 'src/db/verebona-schema.ts'), 'utf8');
    expect(schema).toMatch(/verebona_ai_runs_alias_idx/);
    expect(schema).toMatch(/verebona_request_runs_intent_idx/);
  });
});

describe('§27.6 — historique paginé par curseur', () => {
  it('limit borné à 50, curseur transmis, page renvoyée dans l’ordre chronologique', async () => {
    h.unsafe.mockImplementationOnce(async (sql: string, params: unknown[] = []) => {
      h.calls.push({ sql, params });
      // 4 lignes pour une page de 3 : il en reste de plus anciennes.
      return [{ id: 7 }, { id: 8 }, { id: 9 }, { id: 10 }];
    });
    const page = await listActiveMessages(7, 3, 5, { limit: 3, before: 42 });
    const q = h.calls[0];
    expect(q.params).toEqual([7, 3, 5, 4, 42]);
    expect(q.sql).toMatch(/ORDER BY m\.created_at DESC, m\.id DESC/);
    expect(page.messages.map((m) => m.id)).toEqual([8, 9, 10]);
    expect(page.nextCursor).toBe(8);

    h.calls.length = 0;
    await listActiveMessages(7, 3, 5, { limit: 500 });
    expect(h.calls[0].params).toEqual([7, 3, 5, 51, null]);
  });

  it('dernière page : pas de curseur', async () => {
    h.unsafe.mockImplementationOnce(async () => [{ id: 1 }, { id: 2 }]);
    expect((await listActiveMessages(7, 3, 5)).nextCursor).toBeNull();
  });
});
