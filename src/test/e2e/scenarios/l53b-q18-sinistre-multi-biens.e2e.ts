/**
 * Lot 53 (53B) — retour PO Q18 « Sélecteur multi-biens » (validé) : dans un
 * sinistre qui concerne plusieurs biens, le formulaire propose aussi les
 * pièces et photos des AUTRES biens concernés, uniquement ceux accessibles à
 * l'utilisateur (compte courant, bien non supprimé) — isolation entre
 * comptes testée (cohérence D3 / D23), sur PostgreSQL réel :
 *
 *   PO-Q18-01  références d'un sinistre multi-biens : pièces et photos du
 *              bien de la fiche ET des autres biens concernés, étiquetées par
 *              bien, dédoublonnées ; jamais celles d'un bien hors sinistre ;
 *   PO-Q18-02  droits : un bien concerné supprimé, un bien d'un autre compte
 *              (même relié à tort) ou un sinistre d'un autre compte
 *              n'apportent rien ;
 *   PO-Q18-03  enregistrement : citer la photo / la pièce d'un autre bien
 *              concerné est accepté ; celle d'un bien hors sinistre ou d'un
 *              autre compte est refusée (422), rien n'est stocké ;
 *   PO-Q18-04  sans `claimId` (ancien appel) : comportement inchangé (bien de
 *              la fiche seulement).
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';

const session = vi.hoisted(() => ({ currentAccountId: 0, userId: 0 }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, unknown>;
type Refs = { documents: Array<{ id: number; assetId?: number; assetName?: string | null }>; photos: Array<{ id: number; assetId?: number; assetName?: string | null }> };

scenario('L53B-Q18', 'Sinistre multi-biens : pièces et photos des autres biens concernés, selon les droits', ({ sql, make }) => {
  const routeList = () => import('@/app/api/assets/[id]/claims/route');
  const routeOne = () => import('@/app/api/assets/[id]/claims/[claimId]/route');
  const connecter = (c: AccountRow) => { session.currentAccountId = c.id; session.userId = c.ownerUserId; };
  const req = (method: string, path: string, body?: unknown) =>
    new NextRequest(`http://x${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
  const refs = async (assetId: number, claimId?: number) => {
    const r = await (await routeList()).GET(req('GET', `/api/assets/${assetId}/claims?include=references${claimId ? `&claimId=${claimId}` : ''}`), { params: Promise.resolve({ id: String(assetId) }) });
    expect(r.status).toBe(200);
    return (await r.json() as { references: Refs }).references;
  };
  const modifier = async (assetId: number, claimId: number, body: Json) => {
    const r = await (await routeOne()).PATCH(req('PATCH', `/api/assets/${assetId}/claims/${claimId}`, body), { params: Promise.resolve({ id: String(assetId), claimId: String(claimId) }) });
    return { status: r.status, body: await r.json() as Json };
  };

  let A: AccountRow;
  let B: AccountRow;
  const bien: Record<string, number> = {};
  const piece: Record<string, number> = {};
  const photo: Record<string, number> = {};
  let partagee = 0;
  let claimId = 0;
  let claimB = 0;

  const document = async (acc: AccountRow, assetId: number, nom: string) => {
    const f = await make.assetFile(acc, { assetId, name: `${nom}.pdf` });
    await sql`UPDATE asset_files SET upload_status = 'COMPLETED', document_type = 'FACTURE', original_filename = ${`${nom}.pdf`},
                retained_title = ${nom}, document_date = '2026-03-10', s3_bucket = 'e2e-bucket' WHERE id = ${f.id}`;
    return f.id;
  };
  const galerie = async (acc: AccountRow, assetId: number, nom: string) => {
    const f = await make.assetFile(acc, { assetId, name: `${nom}.jpg`, mimeType: 'image/jpeg' });
    await sql`UPDATE asset_files SET upload_status = 'COMPLETED' WHERE id = ${f.id}`;
    const [p] = await sql<{ id: number }[]>`INSERT INTO asset_photos (asset_id, user_id, file_id, caption) VALUES (${assetId}, ${acc.ownerUserId}, ${f.id}, ${nom}) RETURNING id`;
    return p.id;
  };

  beforeAll(async () => {
    A = await make.account({ plan: 'premium' });
    B = await make.account({ plan: 'premium' });
    for (const [k, acc] of [['maison', A], ['garage', A], ['hors', A], ['supprime', A], ['autre', B]] as const) {
      bien[k] = (await make.asset(acc, { category: 'IMMOBILIER', name: `Q18-${k}` })).id;
      piece[k] = await document(acc, bien[k], `Q18-piece-${k}`);
      photo[k] = await galerie(acc, bien[k], `Q18-photo-${k}`);
    }
    // Un document commun aux deux biens du sinistre : proposé une seule fois.
    partagee = await document(A, bien.maison, 'Q18-piece-commune');
    await sql`UPDATE asset_files SET linked_asset_id = ${bien.garage} WHERE id = ${partagee}`;

    connecter(A);
    const r = await (await routeList()).POST(req('POST', `/api/assets/${bien.maison}/claims`, { assetIds: [bien.maison, bien.garage, bien.supprime], claim: { claimType: 'DEGAT_DES_EAUX', occurredOn: '2026-03-12' } }), { params: Promise.resolve({ id: String(bien.maison) }) });
    expect(r.status).toBe(201);
    claimId = (await r.json() as { id: number }).id;
    await sql`UPDATE assets SET deleted_at = now() WHERE id = ${bien.supprime}`;

    connecter(B);
    const rb = await (await routeList()).POST(req('POST', `/api/assets/${bien.autre}/claims`, { claim: { claimType: 'INCENDIE', occurredOn: '2026-03-01' } }), { params: Promise.resolve({ id: String(bien.autre) }) });
    expect(rb.status).toBe(201);
    claimB = (await rb.json() as { id: number }).id;
  });

  it('PO-Q18-01 — pièces et photos du bien de la fiche ET des autres biens concernés, étiquetées par bien, dédoublonnées ; jamais hors sinistre', async () => {
    connecter(A);
    const r = await refs(bien.maison, claimId);
    const docIds = r.documents.map((d) => d.id);
    const photoIds = r.photos.map((p) => p.id);
    expect(docIds).toEqual(expect.arrayContaining([piece.maison, piece.garage, partagee]));
    expect(photoIds).toEqual(expect.arrayContaining([photo.maison, photo.garage]));
    expect(docIds.filter((id) => id === partagee)).toHaveLength(1);
    // Éléments du bien de la fiche : sans étiquette ; ceux du garage : étiquetés.
    expect(r.documents.find((d) => d.id === piece.maison)?.assetId).toBeUndefined();
    expect(r.documents.find((d) => d.id === piece.garage)).toMatchObject({ assetId: bien.garage, assetName: 'Q18-garage' });
    expect(r.photos.find((p) => p.id === photo.garage)).toMatchObject({ assetId: bien.garage, assetName: 'Q18-garage' });
    // Bien du compte HORS sinistre : rien.
    expect(docIds).not.toContain(piece.hors);
    expect(photoIds).not.toContain(photo.hors);
    // Même sinistre ouvert depuis l'autre bien : symétrique.
    const g = await refs(bien.garage, claimId);
    expect(g.documents.map((d) => d.id)).toEqual(expect.arrayContaining([piece.maison, piece.garage]));
    expect(g.documents.find((d) => d.id === piece.maison)).toMatchObject({ assetId: bien.maison, assetName: 'Q18-maison' });
  });

  it('PO-Q18-02 — droits : bien concerné supprimé, bien d’un autre compte (même lié à tort) et sinistre d’un autre compte n’apportent rien', async () => {
    // Relation intercomptes héritée : le sinistre de A cite à tort le bien de B.
    const [op] = await sql<{ id: number }[]>`SELECT id FROM business_operations WHERE id = ${claimId}`;
    expect(op).toBeDefined();
    await sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`INSERT INTO business_operation_asset_links (operation_id, account_id, asset_id, link_role, authority, active)
               VALUES (${claimId}, ${A.id}, ${bien.autre}, 'CONCERNED', 'USER', true)`;
    });
    connecter(A);
    const r = await refs(bien.maison, claimId);
    const ids = [...r.documents.map((d) => d.id), ...r.photos.map((p) => p.id)];
    for (const k of ['supprime', 'autre'] as const) {
      expect(ids, k).not.toContain(piece[k]);
      expect(ids, k).not.toContain(photo[k]);
    }
    expect(JSON.stringify(r)).not.toContain('Q18-autre');
    // Sinistre d'un autre compte passé en paramètre : rien d'élargi.
    const x = await refs(bien.maison, claimB);
    expect(x.documents.map((d) => d.id)).not.toContain(piece.autre);
    expect(x.documents.map((d) => d.id)).not.toContain(piece.garage);
    // B ne voit rien de A, même avec l'identifiant du sinistre de A.
    connecter(B);
    const y = await refs(bien.autre, claimId);
    expect(JSON.stringify(y)).not.toMatch(/Q18-(maison|garage|piece-commune)/);
    // Fin du cas : la relation héritée est retirée (les écritures d'une Opération
    // portant un lien intercomptes sont refusées par le contrôle des Opérations).
    await sql`DELETE FROM business_operation_asset_links WHERE operation_id = ${claimId} AND asset_id = ${bien.autre}`;
  });

  it('PO-Q18-03 — enregistrement : pièce / photo d’un autre bien concerné acceptée ; hors sinistre ou autre compte refusée (422), rien stocké', async () => {
    connecter(A);
    // Le bien « supprimé » de PO-Q18-02 l'était par simple marquage (une vraie
    // suppression retire le bien du sinistre) : il est rétabli puis retiré du sinistre.
    await sql`UPDATE assets SET deleted_at = NULL WHERE id = ${bien.supprime}`;
    expect((await modifier(bien.maison, claimId, { assetIds: [bien.maison, bien.garage] })).status).toBe(200);
    const lu = await (await routeOne()).GET(req('GET', `/api/assets/${bien.maison}/claims/${claimId}`), { params: Promise.resolve({ id: String(bien.maison), claimId: String(claimId) }) });
    let version = (await lu.json() as { version: number }).version;
    const ok = await modifier(bien.maison, claimId, { version, claim: { damages: [{ id: 'd1', zone: 'Garage', photoIds: [photo.garage], documentIds: [piece.garage] }] } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    version = ok.body.version as number;
    expect((ok.body.claim as Json).damages).toEqual([expect.objectContaining({ photoIds: [photo.garage], documentIds: [piece.garage] })]);
    for (const [k, attendu] of [['hors', 'du compte, hors sinistre'], ['autre', 'd’un autre compte']] as const) {
      const ko = await modifier(bien.maison, claimId, { version, claim: { damages: [{ id: 'd1', zone: 'Garage', photoIds: [photo[k]] }] } });
      expect(ko.status, attendu).toBe(422);
      const ko2 = await modifier(bien.maison, claimId, { version, claim: { damages: [{ id: 'd1', zone: 'Garage', documentIds: [piece[k]] }] } });
      expect(ko2.status, attendu).toBe(422);
    }
    const lu2 = await (await routeOne()).GET(req('GET', `/api/assets/${bien.maison}/claims/${claimId}`), { params: Promise.resolve({ id: String(bien.maison), claimId: String(claimId) }) });
    expect(((await lu2.json() as { claim: Json }).claim).damages).toEqual([expect.objectContaining({ photoIds: [photo.garage] })]);
  });

  it('PO-Q18-04 — sans claimId (ancien appel) : bien de la fiche seulement, comportement inchangé', async () => {
    connecter(A);
    const r = await refs(bien.maison);
    expect(r.documents.map((d) => d.id)).toContain(piece.maison);
    expect(r.documents.map((d) => d.id)).not.toContain(piece.garage);
    expect(r.photos.map((p) => p.id)).not.toContain(photo.garage);
  });
});
