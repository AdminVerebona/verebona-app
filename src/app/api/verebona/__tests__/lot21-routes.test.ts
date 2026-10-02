/**
 * Lot 21 — routes de l'assistant : OPEN_SEARCH_RESULTS (D-J3, revérification
 * par compte) et indicateurs d'usage anonymes (D-J7).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({ accountId: 7, unsafe: vi.fn(async (_q: string, _p?: unknown[]) => [] as unknown[]) }));
vi.mock('@/db', () => ({ ensureMigrations: vi.fn(async () => {}), pgClient: { unsafe: h.unsafe } }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: vi.fn(async () => ({ userId: 70, currentAccountId: h.accountId, planType: 'PREMIUM' })),
    handleSessionError: vi.fn(),
  },
}));

const results = await import('../search-results/route');
const usage = await import('../usage-events/route');
const { createSearchToken } = await import('@/services/verebona-assistant/core/search-token');

beforeEach(() => {
  vi.stubEnv('JWT_SECRET', 'secret-de-test');
  h.accountId = 7;
  h.unsafe.mockReset();
  h.unsafe.mockResolvedValue([]);
});

describe('GET /api/verebona/search-results (D-J3)', () => {
  it('jeton valide : documents REVÉRIFIÉS dans le compte, puis Mes documents filtrés', async () => {
    h.unsafe.mockImplementation(async (q: string) => (/FROM asset_files/.test(q) ? [{ id: 4 }] : [{ id: 9 }]));
    const t = createSearchToken({ accountId: 7, scope: 'documents', ids: [3, 4], assets: [9] });
    const r = await results.GET(new NextRequest(`http://app.test/api/verebona/search-results?t=${t}`));
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('http://app.test/documents?resultats=4');
    const [, p] = h.unsafe.mock.calls.find(([q]) => /FROM asset_files/.test(q))!;
    expect(p).toEqual([[3, 4], 7]);
  });

  it('jeton d’un autre compte, expiré ou falsifié : Mes documents sans filtre, aucune lecture', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = createSearchToken({ accountId: 8, scope: 'documents', ids: [3] });
    const r = await results.GET(new NextRequest(`http://app.test/api/verebona/search-results?t=${t}`));
    expect(r.headers.get('location')).toBe('http://app.test/documents');
    expect((await results.GET(new NextRequest('http://app.test/x?t=abc.def'))).headers.get('location')).toBe('http://app.test/documents');
    expect(h.unsafe).not.toHaveBeenCalled();
  });

  it('documents du jeton tous disparus : « aucun résultat », pas la liste complète', async () => {
    h.unsafe.mockResolvedValue([]);
    const t = createSearchToken({ accountId: 7, scope: 'documents', ids: [3, 4] });
    const r = await results.GET(new NextRequest(`http://app.test/x?t=${t}`));
    expect(r.headers.get('location')).toBe('http://app.test/documents?resultats=aucun');
  });

  it('agenda : filtré sur les biens revérifiés', async () => {
    h.unsafe.mockResolvedValue([{ id: 10 }]);
    const t = createSearchToken({ accountId: 7, scope: 'agenda', ids: [1, 2], assets: [9, 10] });
    const r = await results.GET(new NextRequest(`http://app.test/x?t=${t}`));
    expect(r.headers.get('location')).toBe('http://app.test/agenda?assetIds=10');
  });
});

describe('POST /api/verebona/usage-events (D-J7)', () => {
  it('204 ; enregistre les événements valides, l’offre seule — jamais compte ni utilisateur', async () => {
    const r = await usage.POST(new NextRequest('http://app.test/x', {
      method: 'POST', body: JSON.stringify({ events: [{ type: 'SOURCE_OPEN', sourceType: 'document' }, { type: 'X' }] }),
    }));
    expect(r.status).toBe(204);
    const [sql, p] = h.unsafe.mock.calls[0];
    expect(sql).toMatch(/verebona_usage_events/);
    expect(p).toEqual([['SOURCE_OPEN'], [null], ['document'], [null], ['PREMIUM'], [null]]);
    expect(JSON.stringify(p)).not.toMatch(/\b70\b|\b7\b/);
  });

  it('lot vide ou illisible : 204 sans écriture', async () => {
    const r = await usage.POST(new NextRequest('http://app.test/x', { method: 'POST', body: 'pas du json' }));
    expect(r.status).toBe(204);
    expect(h.unsafe).not.toHaveBeenCalled();
  });

  it('horodatage arrondi à l’heure (pas d’instant précis)', async () => {
    await usage.POST(new NextRequest('http://app.test/x', { method: 'POST', body: JSON.stringify({ events: [{ type: 'ASSISTANT_OPEN' }] }) }));
    expect(h.unsafe.mock.calls[0][0]).toMatch(/date_trunc\('hour', now\(\)\)/);
  });

  it('corps de plus de 8 Ko : 413 avant analyse, annoncé ou non', async () => {
    const gros = JSON.stringify({ events: [{ type: 'ASSISTANT_OPEN', value: 'x'.repeat(9000) }] });
    let r = await usage.POST(new NextRequest('http://app.test/x', { method: 'POST', body: gros }));
    expect(r.status).toBe(413);
    // Sans Content-Length (flux) : lecture interrompue au dépassement.
    let lus = 0;
    const flux = new ReadableStream<Uint8Array>({
      pull(c) { lus += 1; if (lus > 100) { c.close(); return; } c.enqueue(new Uint8Array(1024).fill(32)); },
    });
    r = await usage.POST(new NextRequest('http://app.test/x', { method: 'POST', body: flux, duplex: 'half' } as never));
    expect(r.status).toBe(413);
    expect(lus).toBeLessThan(12);
    expect(h.unsafe).not.toHaveBeenCalled();
  });
});
