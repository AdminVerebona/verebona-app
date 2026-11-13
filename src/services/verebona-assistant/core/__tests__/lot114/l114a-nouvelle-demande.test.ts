/**
 * Lot 114A (Trello #753, CDC T2 §6.5, D17, M02-M03, tests U23-U24-X01) —
 * NOUVELLE DEMANDE PAR DÉFAUT, HISTORIQUE CONSERVÉ.
 *
 *   N01  serveur : sans fil choisi, jamais le dernier fil — un fil vide est
 *        réutilisé, sinon un fil est créé ;
 *   N02  serveur : un fil choisi qui n'appartient pas à l'utilisateur est refusé ;
 *   N03  client : aucun fil rechargé au montage ; fil disparu → demande vierge ;
 *   N04  l'historique reste listé et sélectionnable.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sql: string[] = [];
let vide: Array<{ id: number }> = [];
const tx = {
  unsafe: vi.fn(async (q: string) => {
    sql.push(q.replace(/\s+/g, ' ').trim());
    if (/^SELECT c\.id FROM verebona_conversations/.test(sql[sql.length - 1])) return vide;
    if (/^INSERT INTO verebona_conversations/.test(sql[sql.length - 1])) return [{ id: 77 }];
    return [];
  }),
};
vi.mock('@/db', () => ({
  pgClient: { unsafe: vi.fn(async () => []), begin: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) },
  db: {},
}));

const { resolveConversation, ConversationNotFoundError } = await import('../../conversation.service');
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

beforeEach(() => { sql.length = 0; vide = []; });

describe('L114A-N01 — sans fil choisi : une nouvelle demande', () => {
  it('aucun fil vide : un fil est créé ; la requête ne cherche jamais « le plus récent »', async () => {
    expect(await resolveConversation(1, 2, 'fr-FR', null)).toBe(77);
    const lecture = sql.find((q) => q.startsWith('SELECT c.id'))!;
    expect(lecture).toMatch(/last_message_at IS NULL/);
    expect(lecture).toMatch(/NOT EXISTS \(SELECT 1 FROM verebona_messages/);
    expect(lecture).toMatch(/clarification_state_json IS NULL/);
    expect(lecture).toMatch(/account_id = \$1 AND c\.user_id = \$2/);
    expect(sql.some((q) => q.startsWith('INSERT INTO verebona_conversations'))).toBe(true);
  });

  it('un fil encore vide existe : il est réutilisé, aucun fil vide en série', async () => {
    vide = [{ id: 12 }];
    expect(await resolveConversation(1, 2, 'fr-FR', undefined)).toBe(12);
    expect(sql.some((q) => q.startsWith('INSERT'))).toBe(false);
  });

  it('le code ne retombe plus sur le fil le plus récent', () => {
    const s = read('src/services/verebona-assistant/core/conversation.service.ts');
    const corps = s.slice(s.indexOf('export async function resolveConversation'), s.indexOf('export async function openFreshConversation'));
    expect(corps).not.toMatch(/getOrCreateActiveConversation/);
    expect(corps).toMatch(/openFreshConversation/);
  });
});

describe('L114A-N02 — fil choisi : propriété toujours contrôlée', () => {
  it('fil d’un autre utilisateur ou disparu : refus, jamais un autre fil', async () => {
    await expect(resolveConversation(1, 2, 'fr-FR', 999)).rejects.toBeInstanceOf(ConversationNotFoundError);
  });
});

describe('L114A-N03 / N04 — client', () => {
  const h = read('src/lib/verebona/useVerebona.ts');
  it('au montage : liste des fils seulement, aucun fil repris ni mémorisé', () => {
    expect(h).not.toMatch(/recallThread|rememberThread/);
    expect(h).not.toMatch(/fetch\('\/api\/verebona\/conversation'\)/);
    expect(h).toMatch(/forgetLegacyThread\(\);\s+void refreshThreads\(\);/);
  });
  it('l’historique reste accessible : liste, sélection explicite, nouveau fil', () => {
    expect(h).toMatch(/const selectConversation = useCallback/);
    expect(h).toMatch(/fetch\('\/api\/verebona\/conversations'\)/);
    expect(h).toMatch(/const newConversation = useCallback/);
  });
});
