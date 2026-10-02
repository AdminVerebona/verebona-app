/**
 * Lot 21 — décisions PO du 01/10 sur l'assistant :
 *   D-J3 OPEN_SEARCH_RESULTS (§22.4) : jeton signé, court, lié au compte ;
 *   D-J4 aide sans article (§10.6, CDC 14 T2-03) : « Ouvrir l'aide » puis support ;
 *   D-J7 indicateurs d'usage (§32.3) : anonymes, catalogue fermé.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, ensureMigrations: vi.fn(async () => {}) }));

const T = await import('../search-token');
const { resolveActions } = await import('../action-resolver.service');
const { searchResultsIntent, helpSearchIntent, construireActionIntents } = await import('../ports');
const { fallbackFromHelpSources } = await import('../help-corpus.service');
const U = await import('../usage-events');

const ENV = { JWT_SECRET: 'secret-de-test' } as unknown as NodeJS.ProcessEnv;
const NOW = Date.parse('2026-10-01T10:00:00Z');
afterEach(() => vi.unstubAllEnvs());

describe('D-J3 — jeton OPEN_SEARCH_RESULTS', () => {
  it('signé, lié au compte, court (30 min)', () => {
    const t = T.createSearchToken({ accountId: 7, scope: 'documents', ids: [3, 4, 4, 'x', -1], assets: [9] }, NOW, ENV);
    const ok = T.verifySearchToken(t, 7, NOW + 60_000, ENV);
    expect(ok).toMatchObject({ ok: true, payload: { a: 7, s: 'documents', ids: [3, 4], assets: [9] } });
    expect(T.verifySearchToken(t, 8, NOW, ENV)).toEqual({ ok: false, reason: 'OTHER_ACCOUNT' });
    expect(T.verifySearchToken(t, 7, NOW + T.SEARCH_TOKEN_TTL_S * 1000 + 1000, ENV)).toEqual({ ok: false, reason: 'EXPIRED' });
  });

  it('jeton modifié ou illisible : refusé', () => {
    const t = T.createSearchToken({ accountId: 7, scope: 'documents', ids: [3] }, NOW, ENV);
    const [body, sig] = t.split('.');
    const autre = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), a: 8 })).toString('base64url');
    expect(T.verifySearchToken(`${autre}.${sig}`, 8, NOW, ENV)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(T.verifySearchToken('pas un jeton', 7, NOW, ENV)).toEqual({ ok: false, reason: 'MALFORMED' });
    expect(T.verifySearchToken(t, 7, NOW, { JWT_SECRET: 'autre' } as unknown as NodeJS.ProcessEnv)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('cible : Mes documents filtrés, ou l’agenda filtré par biens', () => {
    expect(T.searchResultsTarget('documents', [3, 4], [9])).toBe('/documents?resultats=3%2C4');
    expect(T.searchResultsTarget('agenda', [5], [9, 10])).toBe('/agenda?assetIds=9%2C10');
    expect(T.searchResultsTarget('documents', [], [])).toBe('/documents');
    // Documents du jeton tous disparus : « aucun résultat », pas la liste complète.
    expect(T.searchResultsTarget('documents', [], [], 2)).toBe('/documents?resultats=aucun');
  });

  it('proposé pour une recherche à plusieurs résultats seulement', () => {
    const docs = [
      { id: 'doc_3', type: 'document', meta: { assetId: 9 } },
      { id: 'doc_4', type: 'document', meta: { assetId: 9 } },
    ] as never[];
    expect(searchResultsIntent('ACCOUNT_SEARCH_DOCUMENT', docs)).toEqual({ type: 'OPEN_SEARCH_RESULTS', params: { scope: 'documents', ids: '3,4', assets: '9' } });
    expect(searchResultsIntent('ACCOUNT_SEARCH_DOCUMENT', docs.slice(0, 1))).toBeNull();
    expect(searchResultsIntent('ACCOUNT_SUMMARY', docs)).toBeNull();
    const agenda = [{ id: 'agenda_1', type: 'agenda_item', meta: { assetId: 9 } }, { id: 'agenda_2', type: 'agenda_item', meta: { assetId: 10 } }] as never[];
    expect(searchResultsIntent('ACCOUNT_SEARCH_AGENDA', agenda)).toMatchObject({ params: { scope: 'agenda', assets: '9,10' } });
  });

  it('résolveur : lien vers la route de résolution, jeton du compte, expiration', async () => {
    vi.stubEnv('JWT_SECRET', 'secret-de-test');
    const access = { assetInAccount: async () => true, documentInAccount: async () => true, agendaItemInAccount: async () => true, helpEntryPublished: async () => true };
    const [a] = await resolveActions({
      accountId: 7, intent: 'ACCOUNT_SEARCH_DOCUMENT', access,
      actionIntents: [{ type: 'OPEN_SEARCH_RESULTS', params: { scope: 'documents', ids: '3,4', assets: '9' } }],
    });
    expect(a).toMatchObject({ type: 'OPEN_SEARCH_RESULTS', label: 'Voir les résultats', expiresAt: expect.any(String) });
    expect(a.href).toMatch(/^\/api\/verebona\/search-results\?t=/);
    const t = a.href!.split('t=')[1];
    expect(T.verifySearchToken(t, 7)).toMatchObject({ ok: true, payload: { ids: [3, 4] } });
    // Paramètres vides : aucune action (jamais de lien mort).
    expect(await resolveActions({ accountId: 7, intent: 'ACCOUNT_SEARCH_DOCUMENT', access, actionIntents: [{ type: 'OPEN_SEARCH_RESULTS', params: { scope: 'documents' } }] })).toEqual([]);
  });
});

describe('D-J4 — aide sans article : « Ouvrir l’aide », puis le support', () => {
  it('texte : aveu (T2-03), puis aide, puis support', () => {
    const t = fallbackFromHelpSources([]);
    expect(t).toMatch(/^Je ne peux pas répondre de façon fiable/);
    expect(t).toMatch(/consulter l’aide Verebona, ou contacter le support/);
  });

  it('actions : OPEN_HELP sur la recherche du Centre d’aide AVANT OPEN_CONTACT', async () => {
    const route = { intent: 'PRODUCT_HELP_HOW_TO', allowedActionTypes: ['OPEN_HELP', 'OPEN_CONTACT'] } as never;
    const intents = construireActionIntents(route, { message: 'Comment synchroniser mon calendrier Outlook ?' } as never, []);
    expect(intents.map((i) => i.type)).toEqual(['OPEN_HELP', 'OPEN_CONTACT']);
    expect(intents[0].params?.path).toMatch(/^\/aide\?q=/);
    const access = { assetInAccount: async () => true, documentInAccount: async () => true, agendaItemInAccount: async () => true, helpEntryPublished: async () => true };
    const actions = await resolveActions({ accountId: 1, intent: 'PRODUCT_HELP_HOW_TO', access, actionIntents: intents });
    expect(actions.map((a) => a.label)).toEqual(['Ouvrir l’aide', 'Contacter le support']);
    expect(actions[0].href).toMatch(/^\/aide\?page=%2Faide%3Fq%3D/);
  });

  it('question sans mot utile : l’accueil du Centre d’aide', () => {
    expect(helpSearchIntent('?')).toEqual({ type: 'OPEN_HELP', params: { path: '/aide', search: true } });
  });
});

describe('D-J7 — indicateurs d’usage anonymes', () => {
  it('catalogue fermé : valeurs inconnues ramenées à null, types inconnus ignorés, 20 au plus', () => {
    const e = U.normalizeUsageEvents([
      { type: 'ACTION_CLICK', actionType: 'OPEN_DOCUMENT', value: 'primary', intent: 'ACCOUNT_SEARCH_DOCUMENT', accountId: 7 },
      { type: 'SOURCE_OPEN', sourceType: 'document', actionType: 'OPEN_DOCUMENT' },
      { type: 'FEEDBACK', value: 'bof' },
      { type: 'ACTION_CLICK', actionType: 'DROP_TABLE' },
      { type: 'INCONNU' },
      ...Array.from({ length: 30 }, () => ({ type: 'ASSISTANT_OPEN' })),
    ]);
    expect(e[0]).toEqual({ type: 'ACTION_CLICK', actionType: 'OPEN_DOCUMENT', sourceType: null, intent: 'ACCOUNT_SEARCH_DOCUMENT', value: 'primary' });
    expect(e[1]).toEqual({ type: 'SOURCE_OPEN', actionType: null, sourceType: 'document', intent: null, value: null });
    expect(e[2].value).toBeNull();
    expect(e[3].actionType).toBeNull();
    expect(e).toHaveLength(19); // 20 lus, 1 type inconnu écarté
    expect(JSON.stringify(e)).not.toMatch(/accountId|7,/);
  });

  it('offre normalisée, jamais d’identifiant', () => {
    expect(U.usagePlan('premium_duo')).toBe('PREMIUM_DUO');
    expect(U.usagePlan('compte-7')).toBeNull();
  });

  it('enregistrement : une insertion, sans compte ni utilisateur', async () => {
    const { pgClient } = await import('@/db');
    const n = await U.recordUsageEvents(U.normalizeUsageEvents([{ type: 'ANSWER_COPY' }, { type: 'ASSISTANT_OPEN' }]), 'PREMIUM');
    expect(n).toBe(2);
    const [sql, params] = vi.mocked(pgClient.unsafe).mock.calls.at(-1)!;
    expect(sql).toMatch(/INSERT INTO verebona_usage_events \(event_type, action_type, source_type, intent, plan, value, created_at\)/);
    expect(sql).toMatch(/date_trunc\('hour', now\(\)\)/);
    expect(sql).not.toMatch(/account|user/);
    expect((params as unknown[][])[0]).toEqual(['ANSWER_COPY', 'ASSISTANT_OPEN']);
  });
});
