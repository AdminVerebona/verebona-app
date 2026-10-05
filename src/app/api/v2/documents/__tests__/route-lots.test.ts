/**
 * DOC-PERF — route `GET /api/v2/documents` : lots bornés, compte de la
 * session, curseur refusé, observabilité sans contenu.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/db', () => ({ db: {}, pgClient: vi.fn() }));

const session = vi.hoisted(() => ({ current: { userId: 1, currentAccountId: 10 } as { userId: number; currentAccountId: number | null } }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: vi.fn(async () => session.current),
    handleSessionError: () => new Response(null, { status: 401 }),
  },
}));

const svc = vi.hoisted(() => ({ getDocumentFeed: vi.fn() }));
vi.mock('@/services/documents/rubric-query.service', async (orig) => ({
  ...(await orig<typeof import('@/services/documents/rubric-query.service')>()),
  getDocumentFeed: (...a: unknown[]) => svc.getDocumentFeed(...a),
}));

const { GET } = await import('../route');
const { InvalidCursorError } = await import('@/services/documents/rubric-query.service');

const req = (qs: string) => new NextRequest(`http://localhost/api/v2/documents?${qs}`);

describe('GET /api/v2/documents (lots)', () => {
  beforeEach(() => {
    session.current = { userId: 1, currentAccountId: 10 };
    svc.getDocumentFeed.mockReset();
  });

  it('un lot borné, pour le compte de la session ; `pageSize=all` ignoré', async () => {
    svc.getDocumentFeed.mockResolvedValue({ documents: [], nextCursor: null, hasMore: false, limit: 100 });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const res = await GET(req('pageSize=all&limit=5000&accountId=99&sort=title&grouped=1'));
    expect(res.status).toBe(200);
    expect(svc.getDocumentFeed).toHaveBeenCalledWith(expect.objectContaining({ accountId: 10, limit: 100, sort: 'title', grouped: true, cursor: null }));
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ documents: [], nextCursor: null, hasMore: false, limit: 100 });
    info.mockRestore();
  });

  it('fin de liste explicite et mesures sans contenu (ni titre, ni curseur)', async () => {
    svc.getDocumentFeed.mockResolvedValue({
      documents: [{ id: 1, title: 'Bail confidentiel' }], nextCursor: 'CURSEUR-SECRET', hasMore: true, limit: 50,
    });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await GET(req('cursor=PRECEDENT'));
    const ligne = info.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(ligne).toMatch(/\[documents\/feed\].*"phase":"next".*"count":1/);
    expect(ligne).not.toMatch(/Bail|CURSEUR|PRECEDENT/);
    info.mockRestore();
  });

  it('curseur invalide : 400, sans deviner une position', async () => {
    svc.getDocumentFeed.mockRejectedValue(new InvalidCursorError());
    const res = await GET(req('cursor=n-importe-quoi'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'INVALID_CURSOR' });
  });

  it('sans compte sélectionné : 400 ; erreur base : 500 sans détail', async () => {
    session.current = { userId: 1, currentAccountId: null };
    expect((await GET(req(''))).status).toBe(400);
    session.current = { userId: 1, currentAccountId: 10 };
    svc.getDocumentFeed.mockRejectedValue(new Error('connexion perdue vers 10.0.0.1'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET(req(''));
    expect(res.status).toBe(500);
    expect(err.mock.calls.join(' ')).not.toMatch(/10\.0\.0\.1/);
    err.mockRestore();
  });
});
