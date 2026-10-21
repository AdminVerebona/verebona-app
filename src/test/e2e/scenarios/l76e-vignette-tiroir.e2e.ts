/**
 * Lot 76E — « À traiter » : la vignette ouvre le tiroir du document (PG16).
 *
 * Avant d'ouvrir le tiroir, le client revalide le document par la route
 * existante `POST /api/home/mascot/check` (compte de la SESSION). Base réelle :
 *
 *   L76E-E2E-01 document du compte, non supprimé → `ok` (le tiroir s'ouvre) ;
 *   L76E-E2E-02 isolation : le même identifiant demandé depuis un AUTRE
 *               compte → `gone` (pas d'ouverture) ;
 *   L76E-E2E-03 document supprimé (corbeille) → `gone` (pas d'ouverture) ;
 *   L76E-E2E-04 aucune écriture : la revalidation ne touche ni la carte ni
 *               le document.
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';

const session = vi.hoisted(() => ({ currentAccountId: 0, userId: 0 }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: () => new Response(null, { status: 401 }),
  },
}));

scenario('L76E', 'Vignette « À traiter » → tiroir document : revalidation par compte (PG16)', ({ sql, make }) => {
  function as(c: { id: number; ownerUserId: number }) {
    session.currentAccountId = c.id;
    session.userId = c.ownerUserId;
  }
  async function check(id: number): Promise<{ status: number; body: { status?: string } }> {
    const { POST } = await import('@/app/api/home/mascot/check/route');
    // Corps exact envoyé par `checkDocumentAccessible` (document-preview.ts).
    const res = await POST(new NextRequest('http://x/api/home/mascot/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: { kind: 'drawer', drawer: 'document', id } }),
    }));
    return { status: res.status, body: await res.json() };
  }

  it('L76E-E2E-01 — document du compte : ok', async () => {
    const a = await make.account();
    const f = await make.assetFile(a);
    as(a);
    expect(await check(f.id)).toEqual({ status: 200, body: { status: 'ok' } });
  });

  it('L76E-E2E-02 — isolation : document d’un autre compte → gone', async () => {
    const a = await make.account();
    const b = await make.account();
    const f = await make.assetFile(a);
    as(b);
    expect((await check(f.id)).body.status).toBe('gone');
    as(a);
    expect((await check(f.id)).body.status).toBe('ok');
  });

  it('L76E-E2E-03 / 04 — document supprimé → gone ; aucune écriture', async () => {
    const a = await make.account();
    const f = await make.assetFile(a);
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${f.id}`;
    const avant = await sql`SELECT * FROM asset_files WHERE id = ${f.id}`;
    as(a);
    expect((await check(f.id)).body.status).toBe('gone');
    const apres = await sql`SELECT * FROM asset_files WHERE id = ${f.id}`;
    expect(apres).toEqual(avant);
  });
});
