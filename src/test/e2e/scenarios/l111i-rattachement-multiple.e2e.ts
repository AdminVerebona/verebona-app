/**
 * Lot 111I — rattachement MULTIPLE d'un document (plusieurs biens, pièces,
 * équipements), sur PostgreSQL 16 réel : MÊMES routes que le tiroir et
 * l'ajout de document, déclencheur 0221 réel, contrat de lecture 109A,
 * service TCO réel, service de rapprochement document ↔ équipement réel,
 * transfert de bien (Duo) réel, MÊME orchestrateur de cohérence que la tâche
 * quotidienne (à blanc puis correctif).
 *
 *  L111I-E2E-01  photo de cuisine → Four ET Micro-onde (tiroir) : principal + lien USER, 109A DIRECT pour
 *                chaque équipement, pièce et bien, recherche, liste ; ancien appel à valeur unique inchangé
 *  L111I-E2E-02  facture couvrant deux équipements : dépense comptée UNE fois au niveau du bien
 *  L111I-E2E-03  contrat couvrant deux biens : listes des deux biens, jamais compté deux fois
 *  L111I-E2E-04  retrait d'un lien = dissociation (document conservé, trace de refus), décision USER > T3
 *  L111I-E2E-05  transfert Duo : document partagé avec un autre bien → lien du bien transféré retiré
 *  L111I-E2E-06  autre compte refusé (404, rien écrit), bien verrouillé refusé (409), options bornées
 *  L111I-E2E-07  reprise du stock (COH-DOC-TARGETS) : à blanc, correctif, idempotent
 *  L111I-E2E-08  ajout de document : cibles complémentaires AJOUTÉES (POST), rien retiré, aucune marque
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { runCoherenceFor, proofOf } from '../coherence-run';
import type { AccountRow, AssetRow } from '../factories';
import { cand, cibleEquipement, cible, fh, operationsKit, RECETTE_TODAY } from '../datasets/operations-v1';

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
// Aucune réanalyse en arrière-plan pendant le scénario (la route la déclenche après une correction).
vi.mock('@/services/ai/source-analysis/entrypoint', async (o) => ({ ...(await o<object>()), analyzeFileSources: async () => ({}) }));

const req = (url: string, method = 'GET', body?: unknown) =>
  new NextRequest(`http://localhost${url}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
type Json = Record<string, any>;

scenario('L111I-RATTACHEMENT-MULTIPLE', 'Rattachement multiple d’un document : biens, pièces, équipements (lot 111I)', ({ sql, make }) => {
  const connecter = (a: AccountRow) => { session.userId = a.ownerUserId; session.currentAccountId = a.id; };
  const piece = async (bien: AssetRow, name: string) => (await sql<{ id: number }[]>`INSERT INTO substructures (asset_id, name) VALUES (${bien.id}, ${name}) RETURNING id`)[0].id;
  const equipement = async (bien: AssetRow, name: string, roomId: number | null = null, prixCents: number | null = null) =>
    (await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name, type, substructure_id, key_characteristics, purchase_price_cents)
      VALUES (${bien.id}, ${name}, 'OTHER', ${roomId}, '{}'::jsonb, ${prixCents}) RETURNING id`)[0].id;
  const cuisine = async (a: AccountRow) => {
    const bien = await make.asset(a, { category: 'IMMOBILIER', name: 'Appartement T3 - Annecy' });
    const c = await piece(bien, 'Cuisine');
    const salon = await piece(bien, 'Salon');
    const four = await equipement(bien, 'Four', c);
    const micro = await equipement(bien, 'Micro-onde', c);
    return { bien, cuisine: c, salon, four, micro };
  };
  const putDoc = async (id: number, body: Json) => {
    const { PUT } = await import('@/app/api/documents/[id]/route');
    return PUT(req(`/api/documents/${id}`, 'PUT', { fileName: 'Photo d’une cuisine', ...body }), ctx(id));
  };
  const targets = async (id: number) => {
    const { GET } = await import('@/app/api/documents/[id]/targets/route');
    const r = await GET(req(`/api/documents/${id}/targets`), ctx(id));
    return { status: r.status, body: (await r.json()) as Json };
  };
  const liens = (fileId: number) => sql<{ asset_id: number | null; substructure_id: number | null; equipment_id: number | null; link_role: string; origin: string; status: string }[]>`
    SELECT asset_id, substructure_id, equipment_id, link_role, origin, status FROM document_asset_links WHERE file_id = ${fileId} ORDER BY id`;
  const colonnes = async (fileId: number) => (await sql<{ asset_id: number | null; linked_asset_id: number | null; substructure_id: number | null; equipment_id: number | null; deleted_at: Date | null; marks: Json | null }[]>`
    SELECT asset_id, linked_asset_id, substructure_id, equipment_id, deleted_at, user_edited_fields AS marks FROM asset_files WHERE id = ${fileId}`)[0];
  const docsEquipement = async (a: AccountRow, eq: number) => (await (await import('@/services/relations/read-contract')).listEntityDocuments(a.id, { kind: 'equipment', id: eq }))!;
  const dansBien = async (assetId: number, fileId: number) => {
    const { db } = await import('@/db');
    const { assetFiles } = await import('@/db/schema');
    const { and, eq } = await import('drizzle-orm');
    const { documentInAssetsCondition } = await import('@/services/documents/asset-document-scope');
    return (await db.select({ id: assetFiles.id }).from(assetFiles).where(and(eq(assetFiles.id, fileId), documentInAssetsCondition([assetId])))).length === 1;
  };
  const tco = async (a: AccountRow, assetId: number) => (await import('@/services/business-operations/tco/service')).readAssetTco(a.id, assetId, { today: RECETTE_TODAY });

  it('L111I-E2E-01 — photo de cuisine → Four ET Micro-onde ; 109A DIRECT pour chaque cible ; recherche ; ancien appel unique', async () => {
    const a = await make.account({ plan: 'premium' });
    connecter(a);
    const k = await cuisine(a);
    const photo = (await make.assetFile(a, { assetId: k.bien.id, mimeType: 'image/jpeg' })).id;
    await sql`UPDATE asset_files SET equipment_id = ${k.four}, substructure_id = ${k.cuisine} WHERE id = ${photo}`;

    // Tiroir « Modifier le document » : listes.
    const r = await putDoc(photo, { assetIds: [k.bien.id], substructureIds: [k.cuisine], equipmentIds: [k.four, k.micro] });
    expect(r.status).toBe(200);
    const c = await colonnes(photo);
    expect(c).toMatchObject({ asset_id: k.bien.id, substructure_id: k.cuisine, equipment_id: k.four, deleted_at: null });
    expect(c.marks).toMatchObject({ equipmentId: true });
    const actifs = (await liens(photo)).filter((l) => l.status === 'ACTIVE');
    expect(actifs).toContainEqual({ asset_id: k.bien.id, substructure_id: null, equipment_id: k.micro, link_role: 'SECONDARY', origin: 'USER', status: 'ACTIVE' });
    expect(actifs.filter((l) => l.equipment_id === k.four)).toHaveLength(1);

    // Lecture : deux équipements, pièce, bien — provenance USER.
    const t = await targets(photo);
    expect(t.status).toBe(200);
    expect(t.body.targets.equipments.map((e: Json) => [e.id, e.principal, e.provenance])).toEqual([[k.four, true, 'USER'], [k.micro, false, 'USER']]);
    expect(t.body.targets.rooms.map((x: Json) => x.id)).toEqual([k.cuisine]);
    expect(t.body.targets.assets.map((x: Json) => [x.id, x.principal])).toEqual([[k.bien.id, true]]);

    // Contrat 109A : DIRECT pour CHAQUE équipement (fiche équipement), document une seule fois.
    for (const eq of [k.four, k.micro]) {
      const p = await docsEquipement(a, eq);
      expect(p.items.filter((d) => d.id === photo).map((d) => d.provenance)).toEqual(['DIRECT']);
    }
    const { GET: docsRoute } = await import('@/app/api/equipments/[id]/documents/route');
    const rr = (await (await docsRoute(req(`/api/equipments/${k.micro}/documents`), ctx(k.micro))).json()) as Json;
    expect(rr.documents.find((d: Json) => d.id === photo)).toMatchObject({ provenance: 'DIRECT' });
    // Fiche pièce : une fois ; fiche bien : une fois.
    const { getRoomInAccount, listRoomDocuments } = await import('@/services/rooms/room-scope.service');
    const room = (await getRoomInAccount(a.id, k.cuisine))!;
    expect((await listRoomDocuments(a.id, room)).filter((d) => d.id === photo)).toHaveLength(1);
    expect(await dansBien(k.bien.id, photo)).toBe(true);
    // Recherche (décision PO 05/11) : le nom SEUL d'une cible rattachée (équipement secondaire) trouve le document.
    const { matchingIdsForList } = await import('@/services/search/global-search.service');
    await sql`UPDATE asset_files SET upload_status = 'COMPLETED', is_draft = false, retained_title = 'Photo cuisine moderne' WHERE id = ${photo}`;
    const autre = (await make.assetFile(a, { assetId: k.bien.id, mimeType: 'image/jpeg' })).id;
    await sql`UPDATE asset_files SET retained_title = 'Photo salon' WHERE id = ${autre}`;
    const trouves = (await matchingIdsForList(a.id, 'Micro-onde', 'document')) ?? [];
    expect(trouves).toContain(photo);
    expect(trouves).not.toContain(autre);
    expect((await matchingIdsForList(a.id, 'Four', 'document')) ?? []).toContain(photo);
    expect((await matchingIdsForList(a.id, 'photo micro-onde', 'document')) ?? []).toContain(photo);
    const { globalSearch } = await import('@/services/search/global-search.service');
    const g = JSON.stringify(await globalSearch(a.id, 'Micro-onde'));
    expect(g).toContain('Photo cuisine moderne');
    // Borné au compte : un autre compte avec un équipement homonyme ne voit pas ce document.
    const b = await make.account({ plan: 'premium' });
    await cuisine(b);
    expect((await matchingIdsForList(b.id, 'Micro-onde', 'document')) ?? []).not.toContain(photo);

    // Ancien appelant à valeur unique : chemin historique, les liens USER secondaires ne sont pas retirés.
    const r2 = await putDoc(photo, { assetId: k.bien.id, substructureId: k.cuisine, equipmentId: k.four });
    expect(r2.status).toBe(200);
    expect((await liens(photo)).filter((l) => l.status === 'ACTIVE' && l.equipment_id === k.micro)).toHaveLength(1);
    // Idempotence : même sélection rejouée → aucun nouveau lien.
    const avant = (await liens(photo)).length;
    await putDoc(photo, { assetIds: [k.bien.id], substructureIds: [k.cuisine], equipmentIds: [k.four, k.micro] });
    expect((await liens(photo)).length).toBe(avant);
  });

  it('L111I-E2E-02 — facture couvrant deux équipements : dépense comptée une fois (et prix des fiches non additionnés)', async () => {
    const a = await make.account({ plan: 'premium' });
    connecter(a);
    const kit = operationsKit(sql, make);
    const bien = await make.asset(a, { category: 'IMMOBILIER', name: 'Maison', purchasePriceCents: 30_000_000, keyCharacteristics: { acquisitionDate: '2020-01-01' } });
    const c = await piece(bien, 'Cuisine');
    const four = await equipement(bien, 'Four', c, 60_000);
    const micro = await equipement(bien, 'Micro-onde', c, 40_000);
    const facture = await kit.document(a, bien.id, [cand({
      typeHint: 'ACQUISITION', provider: 'Électro Annecy', targetHints: [cibleEquipement(four), cibleEquipement(micro)],
      financialHints: [fh('REALIZED_COST', 100_000)],
    })], { type: 'ACQUISITION_INVOICE', title: 'Facture four + micro-onde', amountCents: 100_000, date: '2026-03-02' });
    const sans = await tco(a, bien.id);
    const r = await putDoc(facture, { assetIds: [bien.id], equipmentIds: [four, micro] });
    expect(r.status).toBe(200);
    const t = await tco(a, bien.id);
    // UNE ligne comptée pour le document, jamais une par équipement.
    const lignesDoc = t.lines.filter((l) => l.fileId === facture && l.source === 'DOCUMENT' && (l.includedCents ?? 0) > 0);
    expect(lignesDoc).toHaveLength(1);
    expect(lignesDoc[0].includedCents).toBe(100_000);
    // Prix des fiches : doublons de la facture (somme exacte), jamais additionnés (module isolé 111I).
    const prix = t.lines.filter((l) => l.source === 'EQUIPMENT_DATA');
    expect(prix.map((l) => [l.status, l.reason, l.fileId, l.includedCents])).toEqual([
      ['DUPLICATE', 'SAME_AS_EQUIPMENT_DOCUMENT', facture, 0], ['DUPLICATE', 'SAME_AS_EQUIPMENT_DOCUMENT', facture, 0],
    ]);
    const autres = t.lines.filter((l) => l.fileId !== facture && l.source !== 'EQUIPMENT_DATA').reduce((s, l) => s + (l.includedCents ?? 0), 0);
    expect(t.summary.cumulativeCostCents).toBe(autres + 100_000);
    // Avant le rattachement multiple (équipements seulement cités par T1) : jamais plus que la même dépense + fiches.
    expect(sans.summary.cumulativeCostCents).toBeGreaterThanOrEqual(t.summary.cumulativeCostCents);
  });

  it('L111I-E2E-03 — contrat couvrant deux biens : listes des deux biens, montant jamais compté deux fois', async () => {
    const a = await make.account({ plan: 'premium' });
    connecter(a);
    const kit = operationsKit(sql, make);
    const maison = await make.asset(a, { category: 'IMMOBILIER', name: 'Maison', purchasePriceCents: 20_000_000, keyCharacteristics: { acquisitionDate: '2020-01-01' } });
    const garage = await make.asset(a, { category: 'IMMOBILIER', name: 'Garage', purchasePriceCents: 2_000_000, keyCharacteristics: { acquisitionDate: '2020-01-01' } });
    const contrat = await kit.document(a, maison.id, [cand({
      typeHint: 'CONTRACT', sourceRoleHint: 'CONTRACT_DOCUMENT', provider: 'Assur’Habitat', targetHints: [cible(maison.id)],
      financialHints: [fh('REALIZED_COST', 36_000, { amountScope: 'INSTALLMENT', periodStart: '2026-01-01', periodEnd: '2026-12-31' })],
    })], { type: 'INSURANCE_POLICY', title: 'Contrat multirisque', amountCents: 36_000, date: '2026-01-01' });
    const r = await putDoc(contrat, { assetIds: [maison.id, garage.id] });
    expect(r.status).toBe(200);
    expect(await dansBien(maison.id, contrat)).toBe(true);
    expect(await dansBien(garage.id, contrat)).toBe(true);
    expect((await targets(contrat)).body.targets.assets.map((x: Json) => x.id)).toEqual([maison.id, garage.id]);
    const inclus = async (assetId: number) => (await tco(a, assetId)).lines.filter((l) => l.fileId === contrat).reduce((s, l) => s + (l.includedCents ?? 0), 0);
    // Règle existante (lot 75D E) : sans ventilation établie, rien n'est réparti — jamais 2 × le montant.
    expect((await inclus(maison.id)) + (await inclus(garage.id))).toBeLessThanOrEqual(36_000);
  });

  it('L111I-E2E-04 — retrait d’un lien = dissociation ; décision USER prioritaire sur le rapprochement automatique / T3', async () => {
    const a = await make.account({ plan: 'premium' });
    connecter(a);
    const k = await cuisine(a);
    const photo = (await make.assetFile(a, { assetId: k.bien.id, mimeType: 'image/jpeg' })).id;
    // Lien proposé par l'analyse (AI) vers le micro-onde, colonne four.
    await sql`UPDATE asset_files SET equipment_id = ${k.four} WHERE id = ${photo}`;
    await sql`INSERT INTO document_asset_links (account_id, file_id, asset_id, equipment_id, link_role, origin, confidence, status)
              VALUES (${a.id}, ${photo}, ${k.bien.id}, ${k.micro}, 'SECONDARY', 'AI', 0.9, 'ACTIVE')`;
    expect((await targets(photo)).body.targets.equipments.map((e: Json) => [e.id, e.provenance])).toEqual([[k.four, 'HISTORY'], [k.micro, 'AI']]);

    // L'utilisateur retire le Four et garde le Micro-onde.
    const r = await putDoc(photo, { equipmentIds: [k.micro] });
    expect(r.status).toBe(200);
    const c = await colonnes(photo);
    expect(c).toMatchObject({ equipment_id: k.micro, asset_id: k.bien.id, deleted_at: null }); // document conservé
    const ls = await liens(photo);
    expect(ls.filter((l) => l.status === 'ACTIVE' && l.equipment_id === k.four)).toHaveLength(0);
    expect(ls.filter((l) => l.equipment_id === k.four && l.origin === 'USER' && l.status === 'REJECTED')).toHaveLength(1);
    expect((await docsEquipement(a, k.four)).items.some((d) => d.id === photo)).toBe(false);
    const { userRefusedEquipments, syncDocumentEquipmentLinks } = await import('@/services/equipment/document-equipment-link.service');
    expect([...(await userRefusedEquipments(a.id, photo))]).toContain(k.four);
    // Rapprochement automatique (même service que T1 / T3 / cohérence) : la décision utilisateur prime.
    const s = await syncDocumentEquipmentLinks({ accountId: a.id, fileId: photo, allowAi: false, proposeCard: false } as never);
    expect(s.status).toBe('USER_PROTECTED');
    expect((await liens(photo)).filter((l) => l.status === 'ACTIVE' && l.equipment_id === k.four)).toHaveLength(0);
    // Niveau équipement marqué « décision de l'utilisateur » ; le bien, inchangé, ne l'est pas (comme avant 111I).
    expect((await colonnes(photo)).marks).toMatchObject({ equipmentId: true });
    const { readAttachmentState, hasUserDecision } = await import('@/services/ai/reconciliation/document-asset/attachment-state');

    // Tout retirer : document sans rattachement, jamais supprimé.
    const r2 = await putDoc(photo, { assetIds: [], substructureIds: [], equipmentIds: [] });
    expect(r2.status).toBe(200);
    expect(await colonnes(photo)).toMatchObject({ asset_id: null, substructure_id: null, equipment_id: null, deleted_at: null });
    expect((await liens(photo)).filter((l) => l.status === 'ACTIVE' && l.link_role !== 'MENTIONED')).toHaveLength(0);
    expect(await sql`SELECT 1 FROM asset_files WHERE id = ${photo}`).toHaveLength(1);
    // T3 DOCUMENT_ASSET : le détachement du bien est une décision utilisateur (jamais rattaché à nouveau par l'IA).
    expect(hasUserDecision(await readAttachmentState(a.id, photo))).toBe(true);
  });

  it('L111I-E2E-05 — transfert Duo : document partagé avec un autre bien → lien du bien transféré retiré, document conservé', async () => {
    const a = await make.account({ plan: 'premium' });
    const duo = await make.account({ plan: 'premium_duo' });
    connecter(a);
    const k = await cuisine(a);
    const garage = await make.asset(a, { category: 'IMMOBILIER', name: 'Garage' });
    const facture = (await make.assetFile(a, { assetId: k.bien.id })).id;
    expect((await putDoc(facture, { assetIds: [k.bien.id, garage.id], equipmentIds: [k.four] })).status).toBe(200);
    const { db } = await import('@/db');
    const { sql: dsql } = await import('drizzle-orm');
    const { transferAssetDataInTx } = await import('@/services/assets/asset-account-transfer.service');
    const rep = await db.transaction(async (tx) => {
      await tx.execute(dsql`UPDATE assets SET account_id = ${duo.id} WHERE id = ${k.bien.id}`);
      return transferAssetDataInTx(tx, { assetId: k.bien.id, fromAccountId: a.id, toAccountId: duo.id });
    });
    expect(rep.keptFileIds).toContain(facture);
    expect(await colonnes(facture)).toMatchObject({ asset_id: garage.id, equipment_id: null, deleted_at: null });
    const actifs = (await liens(facture)).filter((l) => l.status === 'ACTIVE');
    expect(actifs.every((l) => l.asset_id === garage.id && l.equipment_id === null)).toBe(true);
    expect((await targets(facture)).body.targets).toMatchObject({ assets: [{ id: garage.id }], rooms: [], equipments: [] });
  });

  it('L111I-E2E-06 — autre compte refusé (404, rien écrit) ; bien verrouillé refusé (409) ; options bornées au compte', async () => {
    const a = await make.account({ plan: 'premium' });
    const b = await make.account({ plan: 'premium' });
    const ka = await cuisine(a);
    const kb = await cuisine(b);
    const fa = (await make.assetFile(a, { assetId: ka.bien.id })).id;
    const fb = (await make.assetFile(b, { assetId: kb.bien.id })).id;
    connecter(a);
    const avant = await liens(fa);
    for (const body of [{ equipmentIds: [ka.four, kb.micro] }, { assetIds: [ka.bien.id, kb.bien.id] }, { substructureIds: [kb.cuisine] }]) {
      const r = await putDoc(fa, body);
      expect(r.status).toBe(404);
      expect(((await r.json()) as Json).message).toBe('Bien, pièce ou équipement introuvable');
    }
    const { PUT, POST } = await import('@/app/api/documents/[id]/targets/route');
    expect((await PUT(req(`/api/documents/${fa}/targets`, 'PUT', { equipmentIds: [kb.four] }), ctx(fa))).status).toBe(404);
    expect((await POST(req(`/api/documents/${fa}/targets`, 'POST', { assetIds: [kb.bien.id] }), ctx(fa))).status).toBe(404);
    expect(await liens(fa)).toEqual(avant);
    // Document d'un autre compte : introuvable.
    expect((await targets(fb)).status).toBe(404);
    expect((await PUT(req(`/api/documents/${fb}/targets`, 'PUT', { assetIds: [] }), ctx(fb))).status).toBe(404);
    // Entrée invalide : 400.
    expect((await PUT(req(`/api/documents/${fa}/targets`, 'PUT', { equipmentIds: ['x'] }), ctx(fa))).status).toBe(400);
    // Bien verrouillé (déplacement Duo en cours) : aucun NOUVEAU lien.
    const verrou = await make.asset(a, { category: 'IMMOBILIER', name: 'En déplacement' });
    await sql`UPDATE assets SET lock_state = 'SOFT' WHERE id = ${verrou.id}`;
    expect((await PUT(req(`/api/documents/${fa}/targets`, 'PUT', { assetIds: [ka.bien.id, verrou.id] }), ctx(fa))).status).toBe(409);
    // Options : biens du compte seulement, pièces et équipements groupés.
    const { GET } = await import('@/app/api/document-targets/options/route');
    const o = (await (await GET(req('/api/document-targets/options'))).json()) as Json;
    const ids = o.groups.map((g: Json) => g.asset.id);
    expect(ids).toContain(ka.bien.id);
    expect(ids).not.toContain(kb.bien.id);
    const g = o.groups.find((x: Json) => x.asset.id === ka.bien.id);
    expect(g.equipments.map((e: Json) => [e.name, e.roomId])).toEqual([['Four', ka.cuisine], ['Micro-onde', ka.cuisine]]);
    expect(o.groups.find((x: Json) => x.asset.id === verrou.id).asset.writable).toBe(false);
  });

  it('L111I-E2E-07 — reprise du stock : COH-DOC-TARGETS à blanc (rien écrit) puis correctif, idempotent', async () => {
    const a = await make.account({ plan: 'premium' });
    const k = await cuisine(a);
    const autre = await make.asset(a, { category: 'IMMOBILIER', name: 'Chalet' });
    // Stock ancien : colonne équipement sans lien (antérieur au déclencheur), lien USER au bien périmé (équipement déplacé).
    const vieux = (await make.assetFile(a, { assetId: k.bien.id })).id;
    await sql`UPDATE asset_files SET equipment_id = ${k.four} WHERE id = ${vieux}`;
    // Stock antérieur au déclencheur : AUCUNE ligne de lien (un lien REMOVED est un retrait qui fait foi, jamais recréé — L83E-E2E-05).
    await sql`DELETE FROM document_asset_links WHERE file_id = ${vieux} AND equipment_id = ${k.four}`;
    const deplace = (await make.assetFile(a, { assetId: k.bien.id })).id;
    await sql`INSERT INTO document_asset_links (account_id, file_id, asset_id, equipment_id, link_role, origin, status)
              VALUES (${a.id}, ${deplace}, ${k.bien.id}, ${k.micro}, 'SECONDARY', 'USER', 'ACTIVE')`;
    await sql`UPDATE equipments SET asset_id = ${autre.id}, substructure_id = NULL WHERE id = ${k.micro}`;
    const sain = (await make.assetFile(a, { assetId: k.bien.id })).id;
    const etat = async () => sql`SELECT id, file_id, asset_id, equipment_id, status, origin FROM document_asset_links WHERE file_id = ANY(${[vieux, deplace, sain]}::int[]) ORDER BY id`;

    const avant = await etat();
    await runCoherenceFor(sql, [a.id], { mode: 'DRY_RUN', today: RECETTE_TODAY });
    expect((await proofOf(sql, a.id, 'COH-DOC-TARGETS', vieux))?.last_result).toBe('WOULD_REPAIR');
    expect((await proofOf(sql, a.id, 'COH-DOC-TARGETS', deplace))?.last_result).toBe('WOULD_REPAIR');
    expect((await proofOf(sql, a.id, 'COH-DOC-TARGETS', sain))?.last_result).toBe('CONSISTENT');
    expect(await etat()).toEqual(avant);

    await runCoherenceFor(sql, [a.id], { mode: 'CORRECTIVE', today: RECETTE_TODAY });
    expect((await proofOf(sql, a.id, 'COH-DOC-TARGETS', vieux))?.last_result).toBe('REPAIRED');
    expect((await proofOf(sql, a.id, 'COH-DOC-TARGETS', deplace))?.last_result).toBe('REPAIRED');
    expect((await liens(vieux)).filter((l) => l.status === 'ACTIVE' && l.equipment_id === k.four)).toHaveLength(1);
    expect((await liens(deplace)).filter((l) => l.status === 'ACTIVE' && l.equipment_id === k.micro).map((l) => [l.asset_id, l.origin])).toEqual([[autre.id, 'USER']]);
    expect(await dansBien(autre.id, deplace)).toBe(true);
    const apres = await etat();
    await runCoherenceFor(sql, [a.id], { mode: 'CORRECTIVE', today: RECETTE_TODAY });
    expect(await etat()).toEqual(apres);
    expect((await proofOf(sql, a.id, 'COH-DOC-TARGETS', vieux))?.last_result).toBe('CONSISTENT');
  });

  it('L111I-E2E-08 — ajout de document : cibles complémentaires AJOUTÉES (rien retiré, aucune marque de décision)', async () => {
    const a = await make.account({ plan: 'premium' });
    connecter(a);
    const k = await cuisine(a);
    const garage = await make.asset(a, { category: 'IMMOBILIER', name: 'Garage' });
    // Le dépôt a posé le principal (bien, cuisine, four) — comme /api/files/confirm.
    const f = (await make.assetFile(a, { assetId: k.bien.id })).id;
    await sql`UPDATE asset_files SET substructure_id = ${k.cuisine}, equipment_id = ${k.four} WHERE id = ${f}`;
    const { POST } = await import('@/app/api/documents/[id]/targets/route');
    const r = await POST(req(`/api/documents/${f}/targets`, 'POST', { assetIds: [k.bien.id, garage.id], substructureIds: [k.cuisine], equipmentIds: [k.four, k.micro] }), ctx(f));
    expect(r.status).toBe(200);
    const j = (await r.json()) as Json;
    expect(j.targets.equipments.map((e: Json) => e.id)).toEqual([k.four, k.micro]);
    expect(j.targets.assets.map((x: Json) => x.id)).toEqual([k.bien.id, garage.id]);
    const c = await colonnes(f);
    expect(c).toMatchObject({ asset_id: k.bien.id, substructure_id: k.cuisine, equipment_id: k.four });
    expect(c.marks?.equipmentId).not.toBe(true);
    // Rejoué : rien de plus.
    const n = (await liens(f)).length;
    await POST(req(`/api/documents/${f}/targets`, 'POST', { equipmentIds: [k.micro] }), ctx(f));
    expect((await liens(f)).length).toBe(n);
  });
});
