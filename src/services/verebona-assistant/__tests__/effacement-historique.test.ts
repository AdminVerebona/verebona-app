/**
 * Effacement manuel effectif de l'historique de l'assistant (§24.5).
 *
 * Passer la conversation à `deleted` ne suffisait pas : la lecture ignorait
 * le statut, et sources, citations, actions et réponses modèle en cache
 * restaient en base. On vérifie ici que l'effacement SUPPRIME tout ce qui
 * permet de reconstruire la conversation, dans le bon ordre.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const calls: string[] = [];
const tx = {
  unsafe: vi.fn(async (sql: string, _params?: unknown[]) => {
    calls.push(sql.replace(/\s+/g, ' ').trim());
    if (/^SELECT id FROM verebona_conversations/.test(sql.trim())) return [{ id: 41 }, { id: 42 }];
    if (/to_regclass/.test(sql)) return [{ present: true }];
    if (/RETURNING/.test(sql)) return [{ id: 1 }];
    return [];
  }),
};
vi.mock('@/db', () => ({
  pgClient: Object.assign(vi.fn(), {
    unsafe: vi.fn(async () => []),
    begin: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  }),
}));

import { clearUserHistory, purgeConversationData } from '@/services/verebona-assistant/core/conversation.service';
import { assistantIdempotencyKey, assistantCachePrefix } from '@/services/verebona-assistant/core/assistant-cache-key';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

beforeEach(() => { calls.length = 0; });

describe('clearUserHistory', () => {
  it('verrouille les conversations de l’utilisateur (et seulement les siennes)', async () => {
    await clearUserHistory(5, 9);
    expect(calls[0]).toMatch(/WHERE account_id = \$1 AND user_id = \$2 FOR UPDATE/);
    expect(tx.unsafe.mock.calls[0][1]).toEqual([5, 9]);
  });

  it('supprime tout, enfant avant parent — sans dépendre des cascades', async () => {
    await clearUserHistory(5, 9);
    const idx = (re: RegExp) => calls.findIndex((c) => re.test(c));
    const links = idx(/^DELETE FROM verebona_claim_sources/);
    const claims = idx(/^DELETE FROM verebona_message_claims/);
    const sources = idx(/^DELETE FROM verebona_message_sources/);
    const actions = idx(/^DELETE FROM verebona_message_actions/);
    const feedback = idx(/^DELETE FROM verebona_feedback/);
    const messages = idx(/^DELETE FROM verebona_messages/);
    const conv = idx(/^DELETE FROM verebona_conversations/);
    for (const i of [links, claims, sources, actions, feedback, messages, conv]) expect(i).toBeGreaterThan(-1);
    expect(links).toBeLessThan(claims);
    expect(Math.max(claims, sources, actions, feedback)).toBeLessThan(messages);
    expect(messages).toBeLessThan(conv);
  });

  it('purge les réponses brutes du modèle rattachées aux fils', async () => {
    await clearUserHistory(5, 9);
    expect(calls.some((c) => /DELETE FROM ai_operation_idempotency WHERE key_hash LIKE ANY/.test(c))).toBe(true);
    const params = tx.unsafe.mock.calls.find((c) => /ai_operation_idempotency WHERE/.test(c[0] as string))![1] as unknown as unknown[];
    expect(params[0]).toEqual(expect.arrayContaining(['assistant:c41:%', 'assistant:c42:%']));
  });

  it('détache les traces d’exécution sans les supprimer', async () => {
    await clearUserHistory(5, 9);
    expect(calls.some((c) => /UPDATE verebona_request_runs SET conversation_id = NULL, client_request_id = NULL/.test(c))).toBe(true);
    expect(calls.some((c) => /DELETE FROM verebona_request_runs/.test(c))).toBe(false);
  });

  it('ne se contente plus d’un statut deleted', () => {
    const s = read('src/services/verebona-assistant/core/conversation.service.ts');
    expect(s).not.toMatch(/SET status = 'deleted'/);
  });

  it('aucune purge sans conversation', async () => {
    const r = await purgeConversationData(tx, []);
    expect(r).toEqual({ conversations: 0, messages: 0, cachedModelResponses: 0 });
    expect(calls).toHaveLength(0);
  });
});

describe('copies en cache du modèle rattachées au fil', () => {
  it('clé préfixée par la conversation', () => {
    const k = assistantIdempotencyKey({ accountId: 5, conversationId: 41 }, 'generate_answer', { QUESTION: 'x' });
    expect(k!.startsWith(assistantCachePrefix(41))).toBe(true);
  });

  it('les deux appels modèle de l’assistant passent cette clé', () => {
    expect(read('src/services/verebona-assistant/core/generation.adapter.ts'))
      .toMatch(/idempotencyKey: assistantIdempotencyKey\(input, 'generate_answer'/);
    expect(read('src/services/verebona-assistant/core/classification.adapter.ts'))
      .toMatch(/idempotencyKey: assistantIdempotencyKey\(input, 'understand_request'/);
  });
});

describe('lecture et écriture après effacement', () => {
  it('l’API d’historique ne lit que la conversation active de l’utilisateur', () => {
    const s = read('src/services/verebona-assistant/core/conversation.service.ts');
    const bloc = s.slice(s.indexOf('export async function listActiveMessages'));
    expect(bloc).toMatch(/JOIN verebona_conversations c ON c\.id = m\.conversation_id/);
    expect(bloc).toMatch(/c\.status = 'active'/);
  });

  it('une réponse tardive ne ressuscite pas un fil effacé', () => {
    const s = read('src/services/verebona-assistant/core/conversation.service.ts');
    const bloc = s.slice(s.indexOf('export async function persistResult'));
    expect(bloc).toMatch(/AND user_id = \$3 AND status = 'active'\s+FOR UPDATE/);
    expect(bloc).toMatch(/if \(\(fil as unknown as unknown\[\]\)\.length === 0\) return( null)?;/);
  });

  it('la purge de rétention supprime aussi les dépendances', () => {
    const job = read('src/services/ai/assistant/retention/purge-assistant-logs.job.ts');
    expect(job).toMatch(/purgeConversationData\(/);
    expect(job).toMatch(/purgeMessagesWhere\(/);
  });
});
