/**
 * Lot 71 (71C) — filtre « Équipement » de « Mes documents » et « Mon
 * agenda », sur PostgreSQL réel.
 *
 * Prouve que le filtrage repose sur les associations PERSISTÉES :
 *   · document ↔ équipement : colonne `asset_files.equipment_id` (reflétée
 *     par le déclencheur 0221) ou lien N-N `document_asset_links` ACTIF
 *     PRIMARY / SECONDARY ; un équipement seulement CITÉ (MENTIONED) ne
 *     compte pas ;
 *   · événement ↔ équipement : `agenda_equipment_links`.
 * Jamais le titre : un document « Facture Chaudière » sans association
 * reste un document du bien. Couvre : bien sans équipement, avec un, avec
 * plusieurs ; élément lié au bien ou à l'équipement ; « Tous », « Bien
 * uniquement », un équipement ; plusieurs biens ; combinaison avec les
 * autres filtres ; pagination ; isolation entre comptes.
 */
import { expect, it } from 'vitest';
import { scenario } from '../scenario';
import type { FeedFilters } from '@/lib/documents/document-feed';

scenario('L71C-FILT', 'Filtre Équipement : documents et agenda fondés sur les associations en base', ({ sql, make }) => {
  const ids: Record<string, number> = {};
  let accountId = 0;

  const equipment = async (assetId: number, name: string, archived = false) => {
    const [e] = await sql<{ id: number }[]>`
      INSERT INTO equipments (asset_id, name, archived_at) VALUES (${assetId}, ${name}, ${archived ? sql`now()` : null})
      RETURNING id`;
    return e.id;
  };
  const doc = async (account: { id: number; ownerUserId: number }, assetId: number | null, title: string, extra: { equipmentId?: number; rubric?: string } = {}) => {
    const f = await make.assetFile(account as never, { assetId });
    await sql`UPDATE asset_files SET retained_title = ${title}, equipment_id = ${extra.equipmentId ?? null},
                                     rubric_code = ${extra.rubric ?? null}
               WHERE id = ${f.id}`;
    return f.id;
  };
  const link = async (fileId: number, assetId: number, equipmentId: number, role: 'PRIMARY' | 'SECONDARY' | 'MENTIONED') => {
    await sql`INSERT INTO document_asset_links (account_id, file_id, asset_id, equipment_id, link_role, origin, status)
              VALUES (${accountId}, ${fileId}, ${assetId}, ${equipmentId}, ${role}, 'USER', 'ACTIVE')`;
  };
  const evt = async (account: { id: number; ownerUserId: number }, title: string, assetIds: number[], equipmentIds: number[] = [], cancelled = false) => {
    const i = await make.agendaItem(account as never, { title, startDate: '2026-03-10', assetIds });
    for (const e of equipmentIds) await sql`INSERT INTO agenda_equipment_links (agenda_item_id, equipment_id) VALUES (${i.id}, ${e})`;
    if (cancelled) await sql`UPDATE agenda_items SET manual_status = 'annule' WHERE id = ${i.id}`;
    return i.id;
  };

  it('prépare trois biens (0, 1 et 2 équipements), leurs documents et événements, et un autre compte', async () => {
    const compte = await make.account();
    const autre = await make.account();
    accountId = compte.id;
    ids.sansEq = (await make.asset(compte, { name: 'Garage' })).id;
    ids.maison = (await make.asset(compte, { name: 'Maison' })).id;
    ids.studio = (await make.asset(compte, { name: 'Studio' })).id;
    ids.chaudiere = await equipment(ids.maison, 'Chaudière');
    ids.robot = await equipment(ids.studio, 'Robot aspirateur');
    ids.chaudiereStudio = await equipment(ids.studio, 'Chaudière');
    ids.autreBien = (await make.asset(autre, { name: 'Maison (autre compte)' })).id;
    ids.eqAutre = await equipment(ids.autreBien, 'Chaudière');

    // Documents — Maison
    ids.dBien = await doc(compte, ids.maison, 'Taxe foncière');
    ids.dEqColonne = await doc(compte, ids.maison, 'Entretien annuel', { equipmentId: ids.chaudiere, rubric: 'MAINTENANCE_WORKS' });
    // Rattaché SEULEMENT à l'équipement (aucun bien en colonne) : le
    // déclencheur 0221 pose le lien vers l'équipement ET son bien.
    ids.dEqSeul = await doc(compte, null, 'Garantie', { equipmentId: ids.chaudiere });
    // Le titre cite l'équipement, aucune association : document du bien.
    ids.dNomTrompeur = await doc(compte, ids.maison, 'Facture Chaudière');
    // Documents — Studio
    ids.dStudio = await doc(compte, ids.studio, 'Bail');
    ids.dRobotLien = await doc(compte, ids.studio, 'Notice robot');
    await link(ids.dRobotLien, ids.studio, ids.robot, 'SECONDARY');
    ids.dCite = await doc(compte, ids.studio, 'Devis cuisine');
    await link(ids.dCite, ids.studio, ids.chaudiereStudio, 'MENTIONED');
    // Garage (sans équipement)
    ids.dGarage = await doc(compte, ids.sansEq, 'Assurance');
    // Autre compte
    ids.dAutre = await doc(autre, ids.autreBien, 'Secret', { equipmentId: ids.eqAutre });

    // Événements
    ids.aBien = await evt(compte, 'Taxe foncière', [ids.maison]);
    ids.aBienEq = await evt(compte, 'Entretien chaudière', [ids.maison], [ids.chaudiere]);
    ids.aEqSeul = await evt(compte, 'Ramonage', [], [ids.chaudiere]);
    ids.aNomTrompeur = await evt(compte, 'Chaudière : rappel', [ids.maison]);
    ids.aAnnule = await evt(compte, 'Visite annulée', [ids.maison], [ids.chaudiere], true);
    ids.aRobot = await evt(compte, 'Brosses robot', [ids.studio], [ids.robot]);
    ids.aGarage = await evt(compte, 'Contrôle', [ids.sansEq]);
    ids.aAutre = await evt(autre, 'Autre compte', [ids.autreBien], [ids.eqAutre]);
  });

  async function feed(opts: { biens?: number[]; assetIds?: number[]; equipment?: string; rubrics?: string[]; limit?: number }) {
    const { getDocumentFeed } = await import('@/services/documents/rubric-query.service');
    const filters: FeedFilters = {
      biens: (opts.biens ?? []).map(String), rubrics: opts.rubrics ?? [], types: [],
      ...(opts.equipment ? { equipment: opts.equipment } : {}),
    };
    const vus: number[] = [];
    let cursor: string | null = null;
    let meta;
    let tours = 0;
    do {
      const page = await getDocumentFeed({
        accountId, assetIds: opts.assetIds ?? [], sort: 'title', direction: 'asc', grouped: false,
        filters, ids: null, limit: opts.limit ?? 100, cursor,
      });
      meta ??= page.meta;
      vus.push(...page.documents.map((d) => d.id));
      cursor = page.nextCursor;
      tours += 1;
      expect(tours).toBeLessThan(50);
    } while (cursor);
    return { vus: vus.sort((a, b) => a - b), meta: meta! };
  }
  const tri = (...xs: number[]) => [...xs].sort((a, b) => a - b);

  // ── Documents ─────────────────────────────────────────────────────────────

  it('FILT-E01 — bien sans équipement : aucune facette, filtre sans effet', async () => {
    const r = await feed({ biens: [ids.sansEq] });
    expect(r.meta.equipmentFacet).toBeUndefined();
    expect(r.vus).toEqual([ids.dGarage]);
    expect((await feed({ biens: [ids.sansEq], equipment: 'asset' })).vus).toEqual([ids.dGarage]);
  });

  it('FILT-E02 — un équipement : « Tous » inclut ses documents (même sans bien en colonne)', async () => {
    const r = await feed({ biens: [ids.maison] });
    expect(r.vus).toEqual(tri(ids.dBien, ids.dEqColonne, ids.dEqSeul, ids.dNomTrompeur));
    expect(r.meta.equipmentFacet).toMatchObject({ all: 4, assetOnly: 2 });
    expect(r.meta.equipmentFacet!.items).toEqual([
      expect.objectContaining({ id: ids.chaudiere, name: 'Chaudière', assetId: ids.maison, assetName: 'Maison', count: 2 }),
    ]);
  });

  it('FILT-E03 — « Bien uniquement » exclut les documents d’équipement ; le nom ne crée pas d’association', async () => {
    expect((await feed({ biens: [ids.maison], equipment: 'asset' })).vus).toEqual(tri(ids.dBien, ids.dNomTrompeur));
    const eq = await feed({ biens: [ids.maison], equipment: String(ids.chaudiere) });
    expect(eq.vus).toEqual(tri(ids.dEqColonne, ids.dEqSeul));
    expect(eq.meta.total).toBe(2);
    expect(eq.meta.scopeTotal).toBeGreaterThanOrEqual(4);
  });

  it('FILT-E04 — plusieurs équipements : lien N-N compté, équipement seulement CITÉ non compté (0 visible)', async () => {
    const r = await feed({ biens: [ids.studio] });
    const parId = Object.fromEntries(r.meta.equipmentFacet!.items.map((e) => [e.id, e.count]));
    expect(parId).toEqual({ [ids.robot]: 1, [ids.chaudiereStudio]: 0 });
    expect((await feed({ biens: [ids.studio], equipment: String(ids.robot) })).vus).toEqual([ids.dRobotLien]);
    expect((await feed({ biens: [ids.studio], equipment: String(ids.chaudiereStudio) })).vus).toEqual([]);
    expect((await feed({ biens: [ids.studio], equipment: 'asset' })).vus).toEqual(tri(ids.dStudio, ids.dCite));
  });

  it('FILT-E05 — plusieurs biens : équipements des deux biens, chacun avec son bien ; sélection exclusive', async () => {
    const r = await feed({ biens: [ids.maison, ids.studio] });
    expect(r.meta.equipmentFacet!.items.map((e) => `${e.assetName}/${e.name}`)).toEqual(['Maison/Chaudière', 'Studio/Chaudière', 'Studio/Robot aspirateur']);
    expect((await feed({ biens: [ids.maison, ids.studio], equipment: String(ids.chaudiere) })).vus).toEqual(tri(ids.dEqColonne, ids.dEqSeul));
    expect((await feed({ biens: [ids.maison, ids.studio], equipment: 'asset' })).vus)
      .toEqual(tri(ids.dBien, ids.dNomTrompeur, ids.dStudio, ids.dCite));
  });

  it('FILT-E06 — combinaison avec Rubrique, onglet d’un bien, pagination par lots', async () => {
    expect((await feed({ biens: [ids.maison], equipment: String(ids.chaudiere), rubrics: ['MAINTENANCE_WORKS'] })).vus).toEqual([ids.dEqColonne]);
    // Onglet Documents du bien : même résultat que le filtre Bien.
    expect((await feed({ assetIds: [ids.maison], equipment: String(ids.chaudiere) })).vus).toEqual(tri(ids.dEqColonne, ids.dEqSeul));
    expect((await feed({ assetIds: [ids.maison] })).meta.equipmentFacet?.items).toHaveLength(1);
    // Lots de 1 : ni doublon ni oubli sous filtre Équipement.
    expect((await feed({ biens: [ids.maison], equipment: 'asset', limit: 1 })).vus).toEqual(tri(ids.dBien, ids.dNomTrompeur));
  });

  it('FILT-E07 — isolation : équipement d’un autre compte ou d’un bien non retenu → aucun document ; sans bien → ignoré', async () => {
    expect((await feed({ biens: [ids.maison], equipment: String(ids.eqAutre) })).vus).toEqual([]);
    expect((await feed({ biens: [ids.maison], equipment: String(ids.robot) })).vus).toEqual([]);
    const tout = await feed({ equipment: String(ids.chaudiere) });
    expect(tout.meta.equipmentFacet).toBeUndefined();
    expect(tout.vus).not.toContain(ids.dAutre);
    expect(tout.vus).toContain(ids.dGarage);
  });

  it('FILT-E08 — document lié à des équipements UNIQUEMENT par liens N-N (SECONDARY, origine AI, lot 71A)', async () => {
    // Aucun bien ni équipement en colonne : seuls deux liens N-N vers deux
    // équipements du Studio (avec leur bien, comme les écrit le service de liens).
    const compte = { id: accountId, ownerUserId: (await sql<{ u: number }[]>`SELECT owner_user_id AS u FROM accounts WHERE id = ${accountId}`)[0].u };
    const fileId = await doc(compte, null, 'Facture intervention');
    for (const e of [ids.robot, ids.chaudiereStudio]) {
      await sql`INSERT INTO document_asset_links (account_id, file_id, asset_id, equipment_id, link_role, origin, status, confidence)
                VALUES (${accountId}, ${fileId}, ${ids.studio}, ${e}, 'SECONDARY', 'AI', 'ACTIVE', 0.9)`;
    }
    // Dans « Tous » du bien parent, sous CHACUN des deux équipements, jamais dans « Bien uniquement ».
    expect((await feed({ biens: [ids.studio] })).vus).toContain(fileId);
    expect((await feed({ biens: [ids.studio], equipment: String(ids.robot) })).vus).toEqual(tri(ids.dRobotLien, fileId));
    expect((await feed({ biens: [ids.studio], equipment: String(ids.chaudiereStudio) })).vus).toEqual([fileId]);
    expect((await feed({ biens: [ids.studio], equipment: 'asset' })).vus).not.toContain(fileId);
    const facette = (await feed({ biens: [ids.studio] })).meta.equipmentFacet!;
    expect(Object.fromEntries(facette.items.map((e) => [e.id, e.count]))).toEqual({ [ids.robot]: 2, [ids.chaudiereStudio]: 1 });
    // Même lecture des deux sources pour `GET /api/documents/browse?equipmentId=`.
    const { listDocumentsGrouped } = await import('@/services/documents/document-query.service');
    const browse = await listDocumentsGrouped({ accountId, equipmentIds: [ids.chaudiereStudio] } as never);
    expect(browse.groups.flatMap((g: { documents: Array<{ id: number }> }) => g.documents.map((d) => d.id))).toEqual([fileId]);
    const colonne = await listDocumentsGrouped({ accountId, equipmentIds: [ids.chaudiere] } as never);
    expect(colonne.groups.flatMap((g: { documents: Array<{ id: number }> }) => g.documents.map((d) => d.id)).sort((x: number, y: number) => x - y))
      .toEqual(tri(ids.dEqColonne, ids.dEqSeul));
    // Retrait du lien (REMOVED) : le document quitte l'équipement.
    await sql`UPDATE document_asset_links SET status = 'REMOVED', removed_at = now() WHERE file_id = ${fileId} AND equipment_id = ${ids.chaudiereStudio}`;
    expect((await feed({ biens: [ids.studio], equipment: String(ids.chaudiereStudio) })).vus).toEqual([]);
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${fileId}`;
  });

  // ── Agenda ────────────────────────────────────────────────────────────────

  const agenda = async (assetIds: number[] | undefined, equipment?: string, includeCancelled = false) => {
    const { getAgendaItemsWithEquipmentFacet } = await import('@/services/agenda/AgendaQueryService');
    const r = await getAgendaItemsWithEquipmentFacet({ accountId, assetIds, period: 'all', includeCancelled, equipment });
    return { ids: r.items.map((i) => i.id).sort((a, b) => a - b), facet: r.equipmentFacet };
  };

  it('FILT-A01 — un événement lié seulement à un équipement figure dans les résultats du bien parent', async () => {
    const r = await agenda([ids.maison]);
    expect(r.ids).toEqual(tri(ids.aBien, ids.aBienEq, ids.aEqSeul, ids.aNomTrompeur));
    // Même règle pour l'onglet Agenda du bien et l'accueil (`getAgendaItems`).
    const { getAgendaItems } = await import('@/services/agenda/AgendaQueryService');
    expect((await getAgendaItems({ accountId, assetIds: [ids.maison] })).map((i) => i.id)).toContain(ids.aEqSeul);
  });

  it('FILT-A02 — « Bien uniquement », un équipement ; compteurs ; le titre ne compte pas', async () => {
    expect((await agenda([ids.maison], 'asset')).ids).toEqual(tri(ids.aBien, ids.aNomTrompeur));
    const eq = await agenda([ids.maison], String(ids.chaudiere));
    expect(eq.ids).toEqual(tri(ids.aBienEq, ids.aEqSeul));
    expect(eq.facet).toMatchObject({ all: 4, assetOnly: 2 });
    expect(eq.facet!.items).toEqual([expect.objectContaining({ id: ids.chaudiere, count: 2, assetName: 'Maison' })]);
  });

  it('FILT-A03 — combinaison avec le statut « annulés » (règle métier inchangée)', async () => {
    expect((await agenda([ids.maison], String(ids.chaudiere), true)).ids).toEqual(tri(ids.aBienEq, ids.aEqSeul, ids.aAnnule));
    expect((await agenda([ids.maison], String(ids.chaudiere), false)).ids).not.toContain(ids.aAnnule);
  });

  it('FILT-A04 — bien sans équipement : pas de facette, filtre ignoré ; sans bien : ignoré', async () => {
    const r = await agenda([ids.sansEq], 'asset');
    expect(r.facet).toBeNull();
    expect(r.ids).toEqual([ids.aGarage]);
    const tout = await agenda(undefined, String(ids.chaudiere));
    expect(tout.facet).toBeNull();
    expect(tout.ids).toContain(ids.aGarage);
  });

  it('FILT-A05 — plusieurs biens et isolation entre comptes', async () => {
    const r = await agenda([ids.maison, ids.studio]);
    expect(r.facet!.items.map((e) => `${e.assetName}/${e.name}`)).toEqual(['Maison/Chaudière', 'Studio/Chaudière', 'Studio/Robot aspirateur']);
    expect((await agenda([ids.maison, ids.studio], String(ids.robot))).ids).toEqual([ids.aRobot]);
    expect((await agenda([ids.maison], String(ids.eqAutre))).ids).toEqual([]);
    // Bien d'un autre compte demandé : rien n'en sort.
    const etranger = await agenda([ids.autreBien]);
    expect(etranger.ids).toEqual([]);
    expect(etranger.facet).toBeNull();
  });
});
