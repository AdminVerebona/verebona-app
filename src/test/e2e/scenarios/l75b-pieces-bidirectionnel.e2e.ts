/**
 * Lot 75 (75B) — Pièces : gestion bidirectionnelle des équipements et des
 * documents, filtres Pièce / Équipement de « Mes documents » et « Mon
 * agenda », sur PostgreSQL 16 réel.
 *
 * Appelle les VRAIES routes (`/api/substructures/[id]/…`, `/api/agenda`) et
 * le vrai service du fil de documents (`getDocumentFeed`, celui de
 * `/api/v2/documents`) ; seule la session est simulée.
 *
 * Exemple du ticket : Maison → Cuisine → Réfrigérateur → facture, garantie ;
 * Four → manuel ; facture de rénovation liée à Cuisine. Couvre associations
 * directes, indirectes, multiples (déduplication), dissociations,
 * réaffectations (confirmation), déplacement d'un équipement (Cuisine →
 * Cellier : documents et échéances suivent sans écrire de lien), absence de
 * lien artificiel, persistance, droits (autre compte, autre bien, lecture
 * seule), pagination.
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import type { FeedFilters } from '@/lib/documents/document-feed';

const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0 as number | null }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

scenario('L75B-PIECES', 'Pièces bidirectionnelles : tiroir, Mes documents, Mon agenda', ({ sql, make }) => {
  const ids: Record<string, number> = {};
  let moi = { id: 0, ownerUserId: 0 };
  let autre = { id: 0, ownerUserId: 0 };
  const as = (acc: { id: number; ownerUserId: number }) => { session.userId = acc.ownerUserId; session.currentAccountId = acc.id; };
  const tri = (...v: number[]) => [...v].sort((a, b) => a - b);

  const room = async (assetId: number, name: string, order = 0) => {
    const [r] = await sql<{ id: number }[]>`INSERT INTO substructures (asset_id, name, order_index) VALUES (${assetId}, ${name}, ${order}) RETURNING id`;
    return r.id;
  };
  const equipment = async (assetId: number, name: string, roomId: number | null) => {
    const [e] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name, substructure_id) VALUES (${assetId}, ${name}, ${roomId}) RETURNING id`;
    return e.id;
  };
  const doc = async (acc: { id: number; ownerUserId: number }, assetId: number | null, title: string, cols: { equipmentId?: number; roomId?: number; rubric?: string } = {}) => {
    const f = await make.assetFile(acc as never, { assetId });
    await sql`UPDATE asset_files SET retained_title = ${title}, equipment_id = ${cols.equipmentId ?? null},
                                     substructure_id = ${cols.roomId ?? null}, rubric_code = ${cols.rubric ?? null},
                                     document_date = '2026-02-01'
               WHERE id = ${f.id}`;
    return f.id;
  };
  const link = async (fileId: number, target: { assetId: number; equipmentId?: number; roomId?: number }, role: string, origin = 'USER') => {
    await sql`INSERT INTO document_asset_links (account_id, file_id, asset_id, equipment_id, substructure_id, link_role, origin, status)
              VALUES (${moi.id}, ${fileId}, ${target.assetId}, ${target.equipmentId ?? null}, ${target.roomId ?? null}, ${role}, ${origin}, 'ACTIVE')`;
  };
  const evt = async (title: string, links: { assets?: number[]; rooms?: number[]; equipments?: number[]; files?: number[] }) => {
    const i = await make.agendaItem(moi as never, { title, startDate: '2026-05-10', assetIds: links.assets ?? [] });
    for (const r of links.rooms ?? []) await sql`INSERT INTO agenda_room_links (agenda_item_id, substructure_id) VALUES (${i.id}, ${r})`;
    for (const e of links.equipments ?? []) await sql`INSERT INTO agenda_equipment_links (agenda_item_id, equipment_id) VALUES (${i.id}, ${e})`;
    for (const f of links.files ?? []) await sql`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id) VALUES (${i.id}, ${f})`;
    return i.id;
  };
  const linkCounts = async () => {
    const [r] = await sql<{ dal: number; arl: number; ael: number; afl: number }[]>`
      SELECT (SELECT COUNT(*) FROM document_asset_links WHERE account_id = ${moi.id} AND status = 'ACTIVE' AND origin <> 'LEGACY_COLUMN')::int AS dal,
             (SELECT COUNT(*) FROM agenda_room_links)::int AS arl,
             (SELECT COUNT(*) FROM agenda_equipment_links)::int AS ael,
             (SELECT COUNT(*) FROM agenda_file_links)::int AS afl`;
    return r;
  };

  // ── Lectures, exactement comme les écrans ────────────────────────────────
  async function feed(opts: { biens?: number[]; assetIds?: number[]; piece?: number; equipment?: string; rubrics?: string[]; limit?: number }) {
    const { getDocumentFeed } = await import('@/services/documents/rubric-query.service');
    const filters: FeedFilters = {
      biens: (opts.biens ?? []).map(String), rubrics: opts.rubrics ?? [], types: [],
      ...(opts.equipment ? { equipment: opts.equipment } : {}),
      ...(opts.piece ? { piece: String(opts.piece) } : {}),
    };
    const vus: number[] = [];
    let cursor: string | null = null;
    let meta;
    let tours = 0;
    do {
      const page = await getDocumentFeed({
        accountId: moi.id, assetIds: opts.assetIds ?? [], sort: 'title', direction: 'asc', grouped: false,
        filters, ids: null, limit: opts.limit ?? 100, cursor,
      });
      meta ??= page.meta;
      vus.push(...page.documents.map((d) => d.id));
      cursor = page.nextCursor;
      tours += 1;
      expect(tours).toBeLessThan(50);
    } while (cursor);
    expect(new Set(vus).size).toBe(vus.length); // jamais de doublon d'un lot à l'autre
    return { vus: vus.sort((a, b) => a - b), meta: meta! };
  }
  async function agenda(extra: Record<string, string>) {
    const { GET } = await import('@/app/api/agenda/route');
    const params = new URLSearchParams({ period: 'all', includeCancelled: 'false', includeUndated: 'true', equipmentFacet: '1', ...extra });
    const res = await GET(new NextRequest(`http://localhost/api/agenda?${params}`));
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ id: number }>; roomFacet: { items: Array<{ id: number; count: number }> } | null; equipmentFacet: { items: Array<{ id: number; count: number }> } | null };
    const vus = body.items.map((i) => i.id);
    expect(new Set(vus).size).toBe(vus.length);
    return { vus: vus.sort((a, b) => a - b), roomFacet: body.roomFacet, equipmentFacet: body.equipmentFacet };
  }
  async function drawer(roomId: number) {
    const { GET } = await import('@/app/api/substructures/[id]/associations/route');
    const res = await GET(new NextRequest(`http://localhost/api/substructures/${roomId}/associations`), { params: Promise.resolve({ id: String(roomId) }) });
    return { status: res.status, body: res.status === 200 ? await res.json() as {
      equipments: Array<{ id: number; name: string }>;
      documents: Array<{ id: number; title: string; direct: boolean; via: Array<{ id: number; name: string }> }>;
    } : null };
  }
  async function write(method: 'POST' | 'DELETE', path: string, body?: unknown) {
    const segs = path.split('/');
    const roomId = segs[0];
    let mod: { POST?: Function; DELETE?: Function };
    let params: Record<string, string>;
    if (segs[1] === 'equipments' && segs[2]) { mod = await import('@/app/api/substructures/[id]/equipments/[equipmentId]/route'); params = { id: roomId, equipmentId: segs[2] }; }
    else if (segs[1] === 'equipments') { mod = await import('@/app/api/substructures/[id]/equipments/route'); params = { id: roomId }; }
    else if (segs[2]) { mod = await import('@/app/api/substructures/[id]/documents/[fileId]/route'); params = { id: roomId, fileId: segs[2] }; }
    else { mod = await import('@/app/api/substructures/[id]/documents/route'); params = { id: roomId }; }
    const req = new NextRequest(`http://localhost/api/substructures/${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    const res = await (mod[method] as (r: NextRequest, c: unknown) => Promise<Response>)(req, { params: Promise.resolve(params) });
    return { status: res.status, body: await res.json().catch(() => null) as Record<string, unknown> | null };
  }

  it('prépare Maison (Cuisine, Cellier), Studio, leurs équipements, documents, échéances, et un autre compte', async () => {
    moi = await make.account({ plan: 'premium' });
    autre = await make.account({ plan: 'premium' });
    ids.maison = (await make.asset(moi as never, { name: 'Maison', category: 'IMMOBILIER' })).id;
    ids.studio = (await make.asset(moi as never, { name: 'Studio', category: 'IMMOBILIER' })).id;
    ids.cuisine = await room(ids.maison, 'Cuisine', 0);
    ids.cellier = await room(ids.maison, 'Cellier', 1);
    ids.salon = await room(ids.studio, 'Salon');
    ids.frigo = await equipment(ids.maison, 'Réfrigérateur', ids.cuisine);
    ids.four = await equipment(ids.maison, 'Four', ids.cuisine);
    ids.chaudiere = await equipment(ids.maison, 'Chaudière', null);
    ids.tv = await equipment(ids.studio, 'Télévision', ids.salon);
    ids.bienAutre = (await make.asset(autre as never, { name: 'Maison autre', category: 'IMMOBILIER' })).id;
    ids.pieceAutre = await room(ids.bienAutre, 'Cuisine');
    ids.eqAutre = await equipment(ids.bienAutre, 'Réfrigérateur', ids.pieceAutre);

    // Documents de Maison
    ids.dReno = await doc(moi, ids.maison, 'Facture rénovation', { roomId: ids.cuisine });              // direct (colonne)
    ids.dFactFrigo = await doc(moi, ids.maison, 'Facture réfrigérateur', { equipmentId: ids.frigo });     // via (colonne)
    ids.dGarFrigo = await doc(moi, ids.maison, 'Garantie réfrigérateur');                                 // via (lien N-N IA)
    await link(ids.dGarFrigo, { assetId: ids.maison, equipmentId: ids.frigo }, 'SECONDARY', 'AI');
    ids.dManuelFour = await doc(moi, ids.maison, 'Manuel four', { equipmentId: ids.four, roomId: ids.cuisine }); // deux chemins
    ids.dMulti = await doc(moi, ids.maison, 'Facture intervention');                                       // deux équipements
    await link(ids.dMulti, { assetId: ids.maison, equipmentId: ids.frigo }, 'SECONDARY', 'AI');
    await link(ids.dMulti, { assetId: ids.maison, equipmentId: ids.four }, 'SECONDARY', 'AI');
    ids.dPieceLien = await doc(moi, ids.maison, 'Plan cuisine');                                           // direct (lien N-N)
    await link(ids.dPieceLien, { assetId: ids.maison, roomId: ids.cuisine }, 'SECONDARY');
    ids.dCite = await doc(moi, ids.maison, 'Devis cité');                                                  // seulement CITÉ : exclu
    await link(ids.dCite, { assetId: ids.maison, equipmentId: ids.frigo }, 'MENTIONED', 'AI');
    ids.dChaud = await doc(moi, ids.maison, 'Entretien chaudière', { equipmentId: ids.chaudiere });
    ids.dMaison = await doc(moi, ids.maison, 'Taxe foncière', { rubric: 'TAXES' });
    ids.dCellier = await doc(moi, ids.maison, 'Bon cellier', { roomId: ids.cellier });
    ids.dTv = await doc(moi, ids.studio, 'Notice TV', { equipmentId: ids.tv });
    ids.dAutre = await doc(autre, ids.bienAutre, 'Secret', { equipmentId: ids.eqAutre });

    // Échéances
    ids.aPiece = await evt('Peinture cuisine', { rooms: [ids.cuisine] });                // pièce seule, sans lien au bien
    ids.aFrigo = await evt('Dégivrage', { assets: [ids.maison], equipments: [ids.frigo] });
    ids.aDocFrigo = await evt('Fin de garantie', { files: [ids.dGarFrigo] });            // via document de l'équipement
    ids.aDouble = await evt('Nettoyage four', { assets: [ids.maison], rooms: [ids.cuisine], equipments: [ids.four] });
    ids.aMaison = await evt('Taxe', { assets: [ids.maison] });
    ids.aChaud = await evt('Ramonage', { assets: [ids.maison], equipments: [ids.chaudiere] });
    ids.aCellier = await evt('Rangement', { assets: [ids.maison], rooms: [ids.cellier] });
    as(moi);
  });

  // ── Tiroir Pièce ──────────────────────────────────────────────────────────

  it('L75B-E2E-01 — tiroir Cuisine : équipements, documents directs ET « Via », chacun une fois, provenance exacte', async () => {
    const r = await drawer(ids.cuisine);
    expect(r.status).toBe(200);
    expect(r.body!.equipments.map((e) => e.name)).toEqual(['Four', 'Réfrigérateur']);
    const parId = new Map(r.body!.documents.map((d) => [d.id, d]));
    expect(tri(...parId.keys())).toEqual(tri(ids.dReno, ids.dFactFrigo, ids.dGarFrigo, ids.dManuelFour, ids.dMulti, ids.dPieceLien));
    expect(parId.get(ids.dReno)).toMatchObject({ direct: true, via: [] });
    expect(parId.get(ids.dPieceLien)).toMatchObject({ direct: true, via: [] });
    expect(parId.get(ids.dFactFrigo)).toMatchObject({ direct: false, via: [{ id: ids.frigo, name: 'Réfrigérateur' }] });
    expect(parId.get(ids.dGarFrigo)).toMatchObject({ direct: false, via: [{ id: ids.frigo, name: 'Réfrigérateur' }] });
    // Deux chemins (pièce + four) : une seule entrée, deux provenances.
    expect(parId.get(ids.dManuelFour)).toMatchObject({ direct: true, via: [{ id: ids.four, name: 'Four' }] });
    // Deux équipements de la pièce : une entrée, les deux équipements d'origine.
    expect(parId.get(ids.dMulti)!.via.map((v) => v.name)).toEqual(['Four', 'Réfrigérateur']);
    expect(parId.has(ids.dCite)).toBe(false);
    expect(parId.has(ids.dChaud)).toBe(false);
  });

  // ── Mes documents ─────────────────────────────────────────────────────────

  it('L75B-E2E-02 — filtre Bien + Pièce : documents directs et indirects, dédupliqués, compteurs exacts', async () => {
    const cuisine = [ids.dReno, ids.dFactFrigo, ids.dGarFrigo, ids.dManuelFour, ids.dMulti, ids.dPieceLien];
    const r = await feed({ biens: [ids.maison], piece: ids.cuisine });
    expect(r.vus).toEqual(tri(...cuisine));
    expect(r.meta.total).toBe(cuisine.length);
    const facette = Object.fromEntries(r.meta.roomFacet!.items.map((x) => [x.name, x.count]));
    expect(facette).toEqual({ Cuisine: 6, Cellier: 1 });
    // Pagination par lots de 1 : ni doublon ni oubli.
    expect((await feed({ biens: [ids.maison], piece: ids.cuisine, limit: 1 })).vus).toEqual(tri(...cuisine));
    // Onglet Documents du bien : même résultat.
    expect((await feed({ assetIds: [ids.maison], piece: ids.cuisine })).vus).toEqual(tri(...cuisine));
    // Sans bien retenu : pas de facette, filtre ignoré.
    const sansBien = await feed({ piece: ids.cuisine });
    expect(sansBien.meta.roomFacet).toBeUndefined();
    expect(sansBien.vus).toContain(ids.dTv);
  });

  it('L75B-E2E-03 — Bien + Équipement ; Bien + Pièce + Équipement = intersection ; combinaison avec Rubrique', async () => {
    expect((await feed({ biens: [ids.maison], equipment: String(ids.frigo) })).vus).toEqual(tri(ids.dFactFrigo, ids.dGarFrigo, ids.dMulti));
    expect((await feed({ biens: [ids.maison], piece: ids.cuisine, equipment: String(ids.four) })).vus).toEqual(tri(ids.dManuelFour, ids.dMulti));
    expect((await feed({ biens: [ids.maison], piece: ids.cellier, equipment: String(ids.frigo) })).vus).toEqual([]);
    // « Bien uniquement » dans Cuisine : documents directs sans équipement.
    expect((await feed({ biens: [ids.maison], piece: ids.cuisine, equipment: 'asset' })).vus).toEqual(tri(ids.dReno, ids.dPieceLien));
    // Compteurs d'équipement sous le filtre Pièce : intersection.
    const r = await feed({ biens: [ids.maison], piece: ids.cuisine });
    const eq = Object.fromEntries(r.meta.equipmentFacet!.items.map((e) => [e.name, e.count]));
    expect(eq).toMatchObject({ 'Réfrigérateur': 3, Four: 2, 'Chaudière': 0 });
    expect((await feed({ biens: [ids.maison], piece: ids.cuisine, rubrics: ['TAXES'] })).vus).toEqual([]);
  });

  it('L75B-E2E-04 — isolation : pièce d’un autre compte ou d’un bien non retenu → aucun document', async () => {
    expect((await feed({ biens: [ids.maison], piece: ids.pieceAutre })).vus).toEqual([]);
    expect((await feed({ biens: [ids.maison], piece: ids.salon })).vus).toEqual([]);
    expect((await feed({ biens: [ids.studio], piece: ids.salon })).vus).toEqual([ids.dTv]);
    expect((await drawer(ids.pieceAutre)).status).toBe(404);
  });

  // ── Mon agenda ────────────────────────────────────────────────────────────

  it('L75B-E2E-05 — agenda : Pièce = directes + équipements + documents de la pièce, sans doublon ; facettes', async () => {
    const tous = await agenda({ assetIds: String(ids.maison) });
    // Une échéance liée seulement à une pièce du bien appartient au bien.
    expect(tous.vus).toEqual(expect.arrayContaining([ids.aPiece, ids.aFrigo, ids.aDouble, ids.aMaison, ids.aChaud, ids.aCellier, ids.aDocFrigo]));
    const cuisine = await agenda({ assetIds: String(ids.maison), piece: String(ids.cuisine) });
    expect(cuisine.vus).toEqual(tri(ids.aPiece, ids.aFrigo, ids.aDocFrigo, ids.aDouble));
    const rf = Object.fromEntries(cuisine.roomFacet!.items.map((x) => [x.id, x.count]));
    expect(rf).toEqual({ [ids.cuisine]: 4, [ids.cellier]: 1 });
    // Pièce + Équipement : intersection.
    expect((await agenda({ assetIds: String(ids.maison), piece: String(ids.cuisine), equipment: String(ids.four) })).vus).toEqual([ids.aDouble]);
    expect((await agenda({ assetIds: String(ids.maison), equipment: String(ids.frigo) })).vus).toEqual([ids.aFrigo]);
    // Pièce d'un autre compte : rien.
    expect((await agenda({ assetIds: String(ids.maison), piece: String(ids.pieceAutre) })).vus).toEqual([]);
  });

  // ── Réaffectation et déplacement ─────────────────────────────────────────

  it('L75B-E2E-06 — réaffectation : 409 sans confirmation (rien écrit) ; confirmée, le réfrigérateur passe de Cuisine à Cellier', async () => {
    const avant = await linkCounts();
    const [{ name: nomAvant }] = await sql<{ name: string }[]>`SELECT name FROM equipments WHERE id = ${ids.frigo}`;
    const r1 = await write('POST', `${ids.cellier}/equipments`, { equipmentIds: [ids.frigo] });
    expect(r1.status).toBe(409);
    expect((r1.body!.details as { conflicts: unknown[] }).conflicts).toEqual([
      { id: ids.frigo, title: 'Réfrigérateur', currentRoom: { id: ids.cuisine, name: 'Cuisine' } },
    ]);
    expect((await sql`SELECT substructure_id FROM equipments WHERE id = ${ids.frigo}`)[0].substructure_id).toBe(ids.cuisine);
    const r2 = await write('POST', `${ids.cellier}/equipments`, { equipmentIds: [ids.frigo], confirmReassign: true });
    expect(r2.status).toBe(200);
    const [eq] = await sql<{ substructure_id: number; name: string }[]>`SELECT substructure_id, name FROM equipments WHERE id = ${ids.frigo}`;
    expect(eq).toEqual({ substructure_id: ids.cellier, name: nomAvant });
    // Aucun lien créé ni modifié pour suivre le déplacement.
    expect(await linkCounts()).toEqual(avant);
  });

  it('L75B-E2E-07 — après déplacement : tiroirs, Mes documents et Mon agenda suivent ; un document d’une autre association reste', async () => {
    const cuisine = await drawer(ids.cuisine);
    expect(cuisine.body!.equipments.map((e) => e.name)).toEqual(['Four']);
    const docsCuisine = cuisine.body!.documents.map((d) => d.id);
    expect(docsCuisine).not.toContain(ids.dFactFrigo);
    expect(docsCuisine).not.toContain(ids.dGarFrigo);
    // Facture intervention : aussi liée au four (toujours en Cuisine).
    expect(cuisine.body!.documents.find((d) => d.id === ids.dMulti)!.via.map((v) => v.name)).toEqual(['Four']);
    const cellier = await drawer(ids.cellier);
    expect(cellier.body!.equipments.map((e) => e.name)).toEqual(['Réfrigérateur']);
    expect(tri(...cellier.body!.documents.map((d) => d.id))).toEqual(tri(ids.dCellier, ids.dFactFrigo, ids.dGarFrigo, ids.dMulti));

    expect((await feed({ biens: [ids.maison], piece: ids.cuisine })).vus).toEqual(tri(ids.dReno, ids.dManuelFour, ids.dMulti, ids.dPieceLien));
    expect((await feed({ biens: [ids.maison], piece: ids.cellier })).vus).toEqual(tri(ids.dCellier, ids.dFactFrigo, ids.dGarFrigo, ids.dMulti));
    expect((await agenda({ assetIds: String(ids.maison), piece: String(ids.cuisine) })).vus).toEqual(tri(ids.aPiece, ids.aDouble));
    expect((await agenda({ assetIds: String(ids.maison), piece: String(ids.cellier) })).vus).toEqual(tri(ids.aCellier, ids.aFrigo, ids.aDocFrigo));
  });

  it('L75B-E2E-08 — dissocier un équipement : il reste (pièce → aucune), ses documents quittent la pièce', async () => {
    const r = await write('DELETE', `${ids.cuisine}/equipments/${ids.four}`);
    expect(r.status).toBe(200);
    const [eq] = await sql<{ substructure_id: number | null }[]>`SELECT substructure_id FROM equipments WHERE id = ${ids.four}`;
    expect(eq.substructure_id).toBeNull();
    // Manuel four : reste dans Cuisine par son lien DIRECT seulement.
    const d = (await drawer(ids.cuisine)).body!.documents.find((x) => x.id === ids.dManuelFour)!;
    expect(d).toMatchObject({ direct: true, via: [] });
    // Déjà hors de la pièce : 409, rien d'écrit.
    expect((await write('DELETE', `${ids.cuisine}/equipments/${ids.four}`)).status).toBe(409);
    // Réassocier depuis la pièce (sans pièce actuelle : aucune confirmation).
    expect((await write('POST', `${ids.cuisine}/equipments`, { equipmentIds: [ids.four] })).status).toBe(200);
    expect((await sql`SELECT substructure_id FROM equipments WHERE id = ${ids.four}`)[0].substructure_id).toBe(ids.cuisine);
  });

  it('L75B-E2E-09 — documents : associer (colonne du tiroir Document), réaffecter avec confirmation, dissocier sans supprimer', async () => {
    // Associer la taxe foncière à Cuisine.
    expect((await write('POST', `${ids.cuisine}/documents`, { fileIds: [ids.dMaison] })).status).toBe(200);
    expect((await sql`SELECT substructure_id FROM asset_files WHERE id = ${ids.dMaison}`)[0].substructure_id).toBe(ids.cuisine);
    expect((await feed({ biens: [ids.maison], piece: ids.cuisine })).vus).toContain(ids.dMaison);
    // Bon cellier (déjà dans Cellier) : confirmation, puis réaffectation.
    const r1 = await write('POST', `${ids.cuisine}/documents`, { fileIds: [ids.dCellier] });
    expect(r1.status).toBe(409);
    expect((await sql`SELECT substructure_id FROM asset_files WHERE id = ${ids.dCellier}`)[0].substructure_id).toBe(ids.cellier);
    expect((await write('POST', `${ids.cuisine}/documents`, { fileIds: [ids.dCellier], confirmReassign: true })).status).toBe(200);
    expect((await sql`SELECT substructure_id FROM asset_files WHERE id = ${ids.dCellier}`)[0].substructure_id).toBe(ids.cuisine);
    // Dissocier : colonne remise à NULL, document conservé.
    expect((await write('DELETE', `${ids.cuisine}/documents/${ids.dMaison}`)).status).toBe(200);
    const [f] = await sql<{ substructure_id: number | null; deleted_at: Date | null; asset_id: number }[]>`
      SELECT substructure_id, deleted_at, asset_id FROM asset_files WHERE id = ${ids.dMaison}`;
    expect(f).toEqual({ substructure_id: null, deleted_at: null, asset_id: ids.maison });
    // Lien N-N direct : passé en REMOVED (jamais supprimé physiquement).
    expect((await write('DELETE', `${ids.cuisine}/documents/${ids.dPieceLien}`)).status).toBe(200);
    expect((await sql`SELECT status FROM document_asset_links WHERE file_id = ${ids.dPieceLien} AND substructure_id = ${ids.cuisine}`)
      .map((x) => x.status)).toEqual(['REMOVED']);
    // Document seulement « Via » : pas de dissociation directe.
    const viaSeul = await write('DELETE', `${ids.cellier}/documents/${ids.dFactFrigo}`);
    expect(viaSeul.status).toBe(409);
    expect(viaSeul.body!.error).toBe('NOT_DIRECT');
    expect((await sql`SELECT equipment_id FROM asset_files WHERE id = ${ids.dFactFrigo}`)[0].equipment_id).toBe(ids.frigo);
  });

  it('L75B-E2E-10 — droits : autre bien, autre compte, compte en lecture seule ; candidats du même bien seulement', async () => {
    // Équipement d'un autre bien du compte : refusé.
    expect((await write('POST', `${ids.cuisine}/equipments`, { equipmentIds: [ids.tv] })).status).toBe(400);
    // Équipement / document / pièce d'un autre compte : introuvable.
    expect((await write('POST', `${ids.cuisine}/equipments`, { equipmentIds: [ids.eqAutre] })).status).toBe(404);
    expect((await write('POST', `${ids.cuisine}/documents`, { fileIds: [ids.dAutre] })).status).toBe(404);
    expect((await write('POST', `${ids.pieceAutre}/equipments`, { equipmentIds: [ids.frigo] })).status).toBe(404);
    // Document d'un autre bien : refusé.
    expect((await write('POST', `${ids.cuisine}/documents`, { fileIds: [ids.dTv] })).status).toBe(400);
    expect((await sql`SELECT substructure_id FROM equipments WHERE id = ${ids.eqAutre}`)[0].substructure_id).toBe(ids.pieceAutre);

    const { GET } = await import('@/app/api/substructures/[id]/candidates/route');
    const cands = async (kind: string, q = '') => {
      const res = await GET(new NextRequest(`http://localhost/api/substructures/${ids.cuisine}/candidates?kind=${kind}&q=${encodeURIComponent(q)}`), { params: Promise.resolve({ id: String(ids.cuisine) }) });
      return (await res.json() as { candidates: Array<{ id: number; currentRoom: { id: number; name: string } | null }> }).candidates;
    };
    const eqs = await cands('equipment');
    expect(eqs.map((c) => c.id).sort()).toEqual(tri(ids.frigo, ids.chaudiere));
    expect(eqs.find((c) => c.id === ids.frigo)!.currentRoom).toEqual({ id: ids.cellier, name: 'Cellier' });
    const docs = (await cands('document')).map((c) => c.id);
    expect(docs).not.toContain(ids.dReno);   // déjà directement dans la pièce
    expect(docs).not.toContain(ids.dTv);     // autre bien
    expect(docs).not.toContain(ids.dAutre);  // autre compte
    expect(docs).toContain(ids.dChaud);
    expect((await cands('document', 'chaudière')).map((c) => c.id)).toEqual([ids.dChaud]);

    // Compte sans abonnement (lecture seule) : écriture refusée, lecture permise.
    const lecteur = await make.account({ plan: null });
    const bien = (await make.asset(lecteur as never, { name: 'Lecture', category: 'IMMOBILIER' })).id;
    const piece = await room(bien, 'Entrée');
    const eqL = await equipment(bien, 'Portail', null);
    as(lecteur);
    const refus = await write('POST', `${piece}/equipments`, { equipmentIds: [eqL] });
    expect(refus.status).toBe(403);
    expect((await sql`SELECT substructure_id FROM equipments WHERE id = ${eqL}`)[0].substructure_id).toBeNull();
    expect((await drawer(piece)).status).toBe(200);
    as(moi);
  });

  it('L75B-E2E-11 — persistance : relu « après rechargement », mêmes données des deux côtés (tiroir Équipement, tiroir Document)', async () => {
    const { GET: getEq } = await import('@/app/api/equipments/[id]/route');
    const res = await getEq(new NextRequest(`http://localhost/api/equipments/${ids.frigo}`), { params: Promise.resolve({ id: String(ids.frigo) }) });
    expect(((await res.json()) as { equipment: { substructureId: number } }).equipment.substructureId).toBe(ids.cellier);
    const cuisine = await drawer(ids.cuisine);
    expect(cuisine.body!.documents.map((d) => d.id)).toContain(ids.dCellier);
    // Le tiroir Document lit la même colonne (`asset_files.substructure_id`).
    expect((await sql`SELECT substructure_id FROM asset_files WHERE id = ${ids.dCellier}`)[0].substructure_id).toBe(ids.cuisine);
  });
});
