/**
 * Plusieurs fils de conversation indépendants — migration 0152.
 *
 * La clé fonctionnelle devient compte + utilisateur + conversation : un fil
 * se crée explicitement, se reprend par son identifiant, et un identifiant
 * qui n'appartient pas à l'utilisateur est refusé — jamais remplacé en
 * silence par un autre fil.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

let owned: number[] = [];
vi.mock('@/db', () => {
  const unsafe = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (/^\s*SELECT id FROM verebona_conversations\s+WHERE id = \$1/.test(sql)) {
      return owned.includes(params[0] as number) ? [{ id: params[0] }] : [];
    }
    if (/INSERT INTO verebona_conversations/.test(sql)) return [{ id: 99 }];
    return [];
  });
  return { pgClient: Object.assign(vi.fn(), { unsafe, begin: vi.fn(async (fn: (t: unknown) => unknown) => fn({ unsafe })) }) };
});

import {
  resolveConversation,
  ConversationNotFoundError,
  findOwnedConversation,
} from '@/services/verebona-assistant/core/conversation.service';
import { libelleFil } from '@/components/verebona/VerebonaThreads';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

beforeEach(() => { owned = [5]; });

describe('résolution du fil d’une demande', () => {
  it('un fil de l’utilisateur est repris tel quel', async () => {
    expect(await resolveConversation(1, 2, 'fr-FR', 5)).toBe(5);
  });

  it('un fil qui n’est pas le sien est refusé (pas de repli silencieux)', async () => {
    await expect(resolveConversation(1, 2, 'fr-FR', 6)).rejects.toBeInstanceOf(ConversationNotFoundError);
  });

  it('sans identifiant : fil le plus récent, créé au besoin', async () => {
    expect(await resolveConversation(1, 2, 'fr-FR', null)).toBe(99);
  });

  it('identifiant invalide : aucune requête, aucun accès', async () => {
    expect(await findOwnedConversation(1, 2, -3)).toBeNull();
    expect(await findOwnedConversation(1, 2, Number.NaN)).toBeNull();
  });
});

describe('migration 0152', () => {
  const M = read('src/db/migrations/0152_verebona_conversation_threads.sql');
  it('supprime l’unicité « un fil actif par utilisateur »', () => {
    expect(M).toMatch(/DROP INDEX IF EXISTS verebona_conversations_active_user_uidx/);
    expect(M).not.toMatch(/CREATE UNIQUE INDEX/);
  });
  it('ajoute titre et date du dernier message', () => {
    expect(M).toMatch(/ADD COLUMN IF NOT EXISTS title TEXT/);
    expect(M).toMatch(/ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ/);
  });
});

describe('API : conversationId réellement utilisé', () => {
  it('liste et création explicite des fils', () => {
    const r = read('src/app/api/verebona/conversations/route.ts');
    expect(r).toMatch(/listConversations\(accountId, session\.userId\)/);
    expect(r).toMatch(/createConversation\(accountId, session\.userId/);
  });

  it('historique et effacement filtrés par fil', () => {
    const r = read('src/app/api/verebona/conversation/route.ts');
    expect(r).toMatch(/findOwnedConversation\(accountId, session\.userId, requested\)/);
    expect(r).toMatch(/listActiveMessages\(accountId, session\.userId, conversationId\)/);
    expect(r).toMatch(/clearUserHistory\(accountId, session\.userId, requested\)/);
  });

  it('un message est envoyé dans le fil sélectionné, contrôlé côté serveur', () => {
    const r = read('src/app/api/verebona/messages/route.ts');
    expect(r).toMatch(/resolveConversation\(accountId, session\.userId, cfg\.locale, requestedConversation\)/);
    expect(r).toMatch(/ConversationNotFoundError/);
    expect(r).toMatch(/toApiPayload\(result, conversationId\)/);
    expect(read('src/services/verebona-assistant/core/api-payload.ts'))
      .toMatch(/conversationId: result\.conversationId \?\? conversationId \?\? null/);
  });

  it('la clarification est cherchée dans le fil qui la porte', () => {
    expect(read('src/services/verebona-assistant/core/clarification.service.ts'))
      .toMatch(/clarification_state_json->>'clarificationId' = \$\{clarificationId\}/);
    expect(read('src/services/verebona-assistant/core/ports.ts'))
      .toMatch(/WHERE id = \$3 AND account_id = \$1 AND user_id = \$2/);
  });

  it('le messageId rendu est celui de la base (sources, avis retrouvables)', () => {
    const o = read('src/services/verebona-assistant/core/assistant-orchestrator.service.ts');
    expect(o).toMatch(/r\.messageId = String\(ids\.messageId\)/);
  });
});

describe('client', () => {
  const H = read('src/lib/verebona/useVerebona.ts');
  it('envoie le fil courant et sait en créer / en reprendre un', () => {
    expect(H).toMatch(/conversationId: conversationRef\.current/);
    expect(H).toMatch(/fetch\('\/api\/verebona\/conversations', \{ method: 'POST' \}\)/);
    expect(H).toMatch(/\/api\/verebona\/conversation\?conversationId=\$\{id\}/);
  });

  it('libellé lisible d’un fil', () => {
    expect(libelleFil({ id: 1, title: 'Quand expire mon assurance ?', createdAt: '2026-09-20T10:00:00Z', lastMessageAt: null, messageCount: 2 }))
      .toBe('Quand expire mon assurance ? · 20/09');
    expect(libelleFil({ id: 1, title: null, createdAt: '2026-09-20T10:00:00Z', lastMessageAt: null, messageCount: 0 }))
      .toMatch(/^Nouvelle conversation/);
  });
});
