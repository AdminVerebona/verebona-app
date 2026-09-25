/**
 * Conversations privées par utilisateur en Duo — migration 0151.
 *
 * Deux membres A et B d'un même compte : B ne doit voir aucun message,
 * source, action ou clarification de A, et l'effacement de A laisse
 * l'historique de B intact. Le cloisonnement est vérifié là où il vit : dans
 * les requêtes SQL (paramètres de session), pas dans l'interface.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const calls: Array<{ sql: string; params: unknown[] }> = [];
vi.mock('@/db', () => {
  const unsafe = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (/INSERT INTO verebona_conversations/.test(sql)) return [{ id: 7 }];
    if (/^\s*SELECT id FROM verebona_conversations/.test(sql) && /FOR UPDATE/.test(sql)) return [{ id: 7 }];
    return [];
  });
  const tag = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ sql: strings.join('?'), params: values });
    return [];
  });
  return { pgClient: Object.assign(tag, { unsafe, begin: vi.fn(async (fn: (t: unknown) => unknown) => fn({ unsafe })) }) };
});

import {
  getOrCreateActiveConversation,
  findByClientRequestId,
  findReplayedAnswer,
  listActiveMessages,
  clearUserHistory,
} from '@/services/verebona-assistant/core/conversation.service';
import { chargerClarification } from '@/services/verebona-assistant/core/clarification.service';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const MIGRATION = read('src/db/migrations/0151_verebona_conversations_per_user.sql');

beforeEach(() => { calls.length = 0; });

describe('persistance : la clé est compte + utilisateur', () => {
  it('la conversation est cherchée puis créée pour l’utilisateur, pas pour le compte', async () => {
    await getOrCreateActiveConversation(10, 1, 'fr-FR');
    const select = calls.find((c) => /^\s*SELECT id FROM verebona_conversations/.test(c.sql))!;
    expect(select.sql).toMatch(/account_id = \$1 AND user_id = \$2 AND status = 'active'/);
    const insert = calls.find((c) => /INSERT INTO verebona_conversations/.test(c.sql))!;
    expect(insert.sql).toMatch(/\(account_id, user_id, status/);
    expect(insert.params.slice(0, 2)).toEqual([10, 1]);
  });

  it('l’idempotence est propre à l’auteur', async () => {
    await findByClientRequestId(10, 2, 'req-A');
    expect(calls[0].sql).toMatch(/author_user_id = \$2/);
    expect(calls[0].sql).toMatch(/c\.user_id = \$2/);
    expect(calls[0].params).toEqual([10, 2, 'req-A']);

    await findReplayedAnswer(10, 2, 'req-A');
    expect(calls[1].sql).toMatch(/q\.author_user_id = \$2/);
    expect(calls[1].sql).toMatch(/c\.user_id = \$2 AND c\.status = 'active'/);
  });

  it('l’historique lu est celui de l’utilisateur, conversation active seulement', async () => {
    await listActiveMessages(10, 2, 7);
    expect(calls[0].sql).toMatch(/c\.id = \$3 AND c\.account_id = \$1 AND c\.user_id = \$2 AND c\.status = 'active'/);
    expect(calls[0].params.slice(0, 3)).toEqual([10, 2, 7]);
  });

  it('l’effacement de A ne touche pas B', async () => {
    await clearUserHistory(10, 1);
    expect(calls[0].sql).toMatch(/WHERE account_id = \$1 AND user_id = \$2\s+FOR UPDATE/);
    expect(calls[0].params).toEqual([10, 1]);
  });

  it('la clarification en attente est chargée pour l’utilisateur', async () => {
    await chargerClarification(10, 2);
    expect(calls[0].sql).toMatch(/user_id = \? AND status = 'active'/);
    expect(calls[0].params).toEqual([10, 2]);
  });
});

describe('routes : filtrage serveur sur l’identifiant de session', () => {
  const route = (p: string) => read(`src/app/api/verebona/${p}`);

  it('historique et effacement passent session.userId', () => {
    const r = route('conversation/route.ts');
    expect(r).toMatch(/listActiveMessages\(accountId, session\.userId, conversationId\)/);
    expect(r).toMatch(/clearUserHistory\(accountId, session\.userId, requested\)/);
    expect(r).not.toMatch(/FROM verebona_messages\s+WHERE account_id = \$1 AND expires_at/);
  });

  it.each([
    'messages/[messageId]/sources/route.ts',
    'messages/[messageId]/explanation/route.ts',
    'messages/[messageId]/feedback/route.ts',
  ])('%s vérifie que le message appartient à l’utilisateur', (p) => {
    const r = route(p);
    expect(r).toMatch(/MESSAGE_OWNED_BY_USER\('m', '\$2', '\$3'\)/);
    expect(r).toMatch(/session\.userId/);
  });

  it('une clarification de A ne peut pas être reprise par B', () => {
    expect(route('clarifications/[clarificationId]/answer/route.ts'))
      .toMatch(/resoudreClarification\(\{\s+accountId,\s+userId: session\.userId,\s+clarificationId,/);
    expect(read('src/services/verebona-assistant/core/clarification.service.ts'))
      .toMatch(/chargerClarification\(p\.accountId, p\.userId, p\.clarificationId, p\.conversationId\)/);
  });

  it('une demande de A ne peut être ni lue ni annulée par B', () => {
    const r = route('requests/[requestId]/route.ts');
    expect(r.match(/user_id = \$\{session\.userId\}|user_id = \$3/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('le rejeu d’un clientRequestId est borné à l’utilisateur', () => {
    expect(route('messages/route.ts')).toMatch(/findReplayedAnswer\(accountId, session\.userId, clientRequestId\)/);
  });

  it('la clarification en attente de A ne détourne pas la question de B', () => {
    const ports = read('src/services/verebona-assistant/core/ports.ts');
    expect(ports).toMatch(/account_id = \$1 AND user_id = \$2 AND status = 'active'/);
    const orch = read('src/services/verebona-assistant/core/assistant-orchestrator.service.ts');
    expect(orch).toMatch(/hasPendingClarification\(input\.accountId, input\.userId/);
  });
});

describe('migration 0151 : le cloisonnement est en base', () => {
  it('user_id obligatoire, unicité active par (compte, utilisateur)', () => {
    expect(MIGRATION).toMatch(/ALTER COLUMN user_id SET NOT NULL/);
    expect(MIGRATION).toMatch(/DROP INDEX IF EXISTS verebona_conversations_active_account_uidx/);
    expect(MIGRATION).toMatch(/ON verebona_conversations \(account_id, user_id\) WHERE status = 'active'/);
  });

  it('idempotence des messages par auteur', () => {
    expect(MIGRATION).toMatch(/DROP INDEX IF EXISTS verebona_messages_idempotency_uidx/);
    expect(MIGRATION).toMatch(/\(account_id, author_user_id, client_request_id\)/);
  });

  it('les conversations Duo existantes sont scindées par auteur', () => {
    expect(MIGRATION).toMatch(/m\.author_user_id <> c\.user_id/);
    expect(MIGRATION).toMatch(/UPDATE verebona_request_runs/);
  });

  it('l’ancien index est retiré AVANT la scission', () => {
    expect(MIGRATION.indexOf('DROP INDEX IF EXISTS verebona_conversations_active_account_uidx'))
      .toBeLessThan(MIGRATION.indexOf('DO $$'));
  });
});
