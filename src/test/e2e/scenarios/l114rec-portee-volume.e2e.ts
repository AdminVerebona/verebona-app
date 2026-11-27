/**
 * Carte Trello #744 — RECETTE du CDC « Opérations / Agenda V2.0 » : PORTÉE
 * des suppressions (§19 ; AC60), EXHAUSTIVITÉ des lectures sans limite
 * silencieuse (§13, §20, §23 ; AC39, AC74) et objets AUTONOMES (§2, §12 ;
 * AC07). Sur PostgreSQL 16 réel, par les chemins de PRODUCTION : suppression
 * d'un document (route `DELETE /api/files/:id`), suppression complète d'un
 * bien (`deleteAssetCompletely`), effacement terminal d'un compte (cascade
 * des clés étrangères), lecteurs de la page et de la Timeline du bien,
 * contrôle du graphe (`auditOperationGraph`). Aucune IA, aucun appel réseau.
 * Dates fixes : aucune dépendance au jour.
 *
 *   L114REC-E07  AC60, AC44 : suppression d'un JUSTIFICATIF — le lien à l'événement de référence part, l'événement,
 *                ses autres justificatifs, ses événements d'Agenda et sa relation restent ; graphe sans anomalie ;
 *                aucune ligne d'un autre compte touchée
 *   L114REC-E08  AC60 : suppression complète d'un BIEN (et de ses équipements) — événements de référence détachés,
 *                sources désactivées, événement sans aucune preuve invalidé (jamais supprimé), aucun lien orphelin,
 *                aucune anomalie de graphe ; l'autre compte est intact
 *   L114REC-E09  AC60 : effacement d'un COMPTE — toutes les lignes du graphe partent avec lui (relations, liens
 *                d'Agenda, déclarations, journal) ; le second compte garde les siennes
 *   L114REC-E10  AC39, AC74 : 210 justificatifs et 30 événements d'Agenda sur un même événement de référence, 240
 *                éléments et 40 événements de référence sur le bien — page et Timeline rendent TOUT (aucune limite
 *                cachée de 200, aucun groupe coupé, aucune répétition, aucune omission), en temps mesuré
 *   L114REC-E11  AC07, AC08 (partiel) : un justificatif autonome et un événement d'Agenda autonome n'engendrent
 *                AUCUN événement de référence et AUCUNE carte « À traiter » ; relier deux événements d'Agenda
 *                entre eux n'en crée pas non plus
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import type { OperationWriteContext } from '@/services/business-operations/operation-write.facade';

const session = vi.hoisted(() => ({ currentAccountId: 0 as number | null, userId: 0, role: 'USER' as string }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId, role: session.role }),
    requireAdmin: async () => session.userId,
    tryGetSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId, role: session.role }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
const AUJOURDHUI = '2026-10-12';
const facade = () => import('@/services/business-operations/operation-write.facade');

scenario('L114REC-P', 'Opérations / Agenda CDC V2.0 — recette : portée des suppressions, exhaustivité sans limite cachée, objets autonomes', ({ sql, make }) => {
  const user = (c: AccountRow): OperationWriteContext => ({ accountId: c.id, actor: { kind: 'USER', userId: c.ownerUserId, channel: 'UI' } });
  const asUser = (c: AccountRow) => { session.currentAccountId = c.id; session.userId = c.ownerUserId; session.role = 'USER'; };

  /** Événement de référence créé par le dépôt, avec sa source documentaire (jamais sans fondement). */
  async function evenement(compte: AccountRow, type: string, over: { label?: string; fileId?: number; assetId?: number; realized?: string } = {}): Promise<number> {
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    return withBusinessOperationWrite(compte.id, async (repo) => (await repo.create({
      type: { code: type } as never, status: 'REALIZED', technicalLabel: over.label ?? null, ...(over.realized ? { realizedDate: over.realized } : {}),
      source: over.fileId
        ? { kind: 'DOCUMENT', entityKey: over.fileId, role: 'INVOICE', authority: 'DOCUMENT', confidence: 'certain', locator: { e2e: 'recette' } }
        : { kind: 'MIGRATION', entityKey: `l114rec-${Math.random().toString(36).slice(2)}`, authority: 'STRUCTURED' },
      ...(over.assetId ? { assets: [{ assetId: over.assetId, role: 'PRIMARY' as const, authority: 'DOCUMENT' as const }] } : {}),
      reasonCode: 'L114REC_E2E',
    })).id);
  }
  const lier = async (compte: AccountRow, operationId: number, agendaItemId: number) =>
    (await facade()).linkAgendaItem(user(compte), { operationId, agendaItemId, reasonCode: 'L114REC_E2E' });
  const lierDocument = async (compte: AccountRow, operationId: number, fileId: number) =>
    (await facade()).linkDocument(user(compte), { operationId, fileId, reasonCode: 'L114REC_E2E' });
  const audit = async (compte: AccountRow) => {
    const { auditOperationGraph } = await import('@/services/business-operations/graph/store');
    const { postgresRunner } = await import('@/services/business-operations/grouping/runner');
    return auditOperationGraph(postgresRunner(sql as never), compte.id);
  };
  const grapheDuCompte = (compte: AccountRow) => sql<Json[]>`
    SELECT (SELECT count(*)::int FROM business_operation_relations WHERE account_id = ${compte.id}) AS relations,
           (SELECT count(*)::int FROM business_operation_agenda_links WHERE account_id = ${compte.id}) AS liens,
           (SELECT count(*)::int FROM business_operation_declarations WHERE account_id = ${compte.id}) AS declarations,
           (SELECT count(*)::int FROM business_operation_graph_history WHERE account_id = ${compte.id}) AS journal,
           (SELECT count(*)::int FROM business_operations WHERE account_id = ${compte.id}) AS evenements`;
  /** Liens qui pointeraient vers un objet disparu : jamais aucun (le CDC §19 interdit la référence orpheline). */
  const orphelins = (compte: AccountRow) => sql<Json[]>`
    SELECT 'lien' AS quoi, l.id::int AS id FROM business_operation_agenda_links l
     WHERE l.account_id = ${compte.id}
       AND (NOT EXISTS (SELECT 1 FROM agenda_items i WHERE i.id = l.agenda_item_id)
         OR NOT EXISTS (SELECT 1 FROM business_operations o WHERE o.id = l.operation_id))
    UNION ALL
    SELECT 'relation', r.id::int FROM business_operation_relations r
     WHERE r.account_id = ${compte.id}
       AND (NOT EXISTS (SELECT 1 FROM business_operations o WHERE o.id = r.from_operation_id)
         OR NOT EXISTS (SELECT 1 FROM business_operations o WHERE o.id = r.to_operation_id))
    UNION ALL
    SELECT 'document', d.id::int FROM business_operation_documents d
     WHERE d.account_id = ${compte.id} AND d.active
       AND NOT EXISTS (SELECT 1 FROM asset_files f WHERE f.id = d.file_id)`;

  // ══ AC60 : suppression d'un justificatif ═══════════════════════════════════

  it('L114REC-E07 — suppression d’un justificatif : l’opération, ses autres justificatifs, ses événements d’Agenda et sa relation restent ; aucun lien orphelin ; autre compte intact (AC60, AC44)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const autre = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const f1 = await make.assetFile(compte, { assetId: maison.id });
    const f2 = await make.assetFile(compte, { assetId: maison.id });
    const op = await evenement(compte, 'INTERVENTION', { label: 'Réparation de la toiture', fileId: f1.id, assetId: maison.id });
    const sinistre = await evenement(compte, 'CLAIM', { label: 'Dégât des eaux', assetId: maison.id });
    expect(await lierDocument(compte, op, f2.id)).toMatchObject({ status: 'APPLIED' });
    const element = await make.agendaItem(compte, { title: 'Intervention du couvreur', startDate: '2026-05-04', assetIds: [maison.id] });
    expect(await lier(compte, op, element.id)).toMatchObject({ status: 'APPLIED' });
    expect(await (await facade()).associateOperations(user(compte), { fromOperationId: sinistre, toOperationId: op, nature: 'CLAIM_REPAIR' }))
      .toMatchObject({ status: 'APPLIED' });
    const avantAutre = await grapheDuCompte(autre);

    // Suppression par la VRAIE route (écriture : droits et compte revérifiés).
    asUser(compte);
    const { DELETE } = await import('@/app/api/files/[id]/route');
    const rep = await DELETE(new NextRequest(`http://local/api/files/${f2.id}`, { method: 'DELETE' }), { params: Promise.resolve({ id: String(f2.id) }) });
    expect(rep.status).toBe(200);

    // Le fichier part ; l'événement de référence reste, avec son autre justificatif, son événement et sa relation.
    expect(await sql`SELECT 1 FROM asset_files WHERE id = ${f2.id} AND deleted_at IS NULL`).toHaveLength(0);
    const { readReferenceEventPage } = await import('@/services/business-operations/graph/reference-event-page');
    const vue = await readReferenceEventPage(compte.id, op);
    expect(vue!.documents.map((d) => d.fileId)).toEqual([f1.id]);
    expect(vue!.agendaItems.map((a) => a.id)).toEqual([element.id]);
    expect(vue!.relations.map((r) => r.operationId)).toEqual([sinistre]);
    // Aucun lien orphelin, aucune anomalie de graphe, autre compte inchangé.
    expect(await orphelins(compte)).toEqual([]);
    expect(await audit(compte)).toEqual([]);
    expect(await grapheDuCompte(autre)).toEqual(avantAutre);
  });

  // ══ AC60 : suppression complète d'un bien ══════════════════════════════════

  it('L114REC-E08 — suppression complète d’un bien : opérations détachées, sources désactivées, événement sans preuve invalidé (jamais supprimé), aucun lien orphelin, autre compte intact (AC60)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const autre = await make.account({ plan: 'premium' });
    const voiture = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const [equip] = await sql<{ id: number }[]>`
      INSERT INTO equipments (asset_id, name) VALUES (${voiture.id}, 'Autoradio') RETURNING id`;
    const fVoiture = await make.assetFile(compte, { assetId: voiture.id });
    const fMaison = await make.assetFile(compte, { assetId: maison.id });
    // A : fondé uniquement sur un justificatif de la voiture ; B : fondé sur la maison, relié à A.
    const a = await evenement(compte, 'INTERVENTION', { label: 'Révision de la Clio', fileId: fVoiture.id, assetId: voiture.id });
    const b = await evenement(compte, 'CONTRACT', { label: 'Contrat d’entretien', fileId: fMaison.id, assetId: maison.id });
    await sql`INSERT INTO business_operation_equipment_links (account_id, operation_id, equipment_id, asset_id, authority, active)
              VALUES (${compte.id}, ${a}, ${equip.id}, ${voiture.id}, 'DOCUMENT', true)`;
    const elementVoiture = await make.agendaItem(compte, { title: 'Révision annuelle', startDate: '2026-04-02', assetIds: [voiture.id] });
    expect(await lier(compte, a, elementVoiture.id)).toMatchObject({ status: 'APPLIED' });
    expect(await (await facade()).associateOperations(user(compte), { fromOperationId: a, toOperationId: b, nature: 'ASSOCIATED' }))
      .toMatchObject({ status: 'APPLIED' });
    const avantAutre = await grapheDuCompte(autre);

    const { deleteAssetCompletely } = await import('@/services/assets/asset-deletion.service');
    await deleteAssetCompletely({ id: voiture.id, thumbnailUrl: null });

    // Le bien, son équipement, ses documents et ses éléments d'Agenda sont partis.
    expect(await sql`SELECT 1 FROM assets WHERE id = ${voiture.id}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM equipments WHERE id = ${equip.id}`).toHaveLength(0);
    // Carte #849 (B2) — constat remplacé par la décision PO (« élément d'Agenda du bien survit sans bien ») :
    // l'élément d'Agenda qui n'appartenait qu'au bien supprimé est SUPPRIMÉ avec lui ; aucune référence pendante.
    expect(await sql`SELECT 1 FROM agenda_items WHERE id = ${elementVoiture.id}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM agenda_asset_links WHERE agenda_item_id = ${elementVoiture.id}`).toHaveLength(0);
    // L'événement de référence RELIÉ à celui d'un autre bien n'est pas supprimé (#849 : l'historique de l'autre bien
    // reste identique) : il est détaché, ses sources désactivées, et invalidé faute de preuve.
    const [etatA] = await sql<Json[]>`
      SELECT invalidated_at IS NOT NULL AS invalide, invalidation_reason AS motif FROM business_operations WHERE id = ${a}`;
    expect(etatA).toMatchObject({ invalide: true });
    expect(String(etatA.motif)).toContain('ASSET_DELETED');
    expect(await sql`SELECT 1 FROM business_operation_asset_links WHERE operation_id = ${a} AND active`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM business_operation_sources WHERE operation_id = ${a} AND active`).toHaveLength(0);
    // L'autre événement de référence du compte est intact et consultable.
    const { readReferenceEventPage } = await import('@/services/business-operations/graph/reference-event-page');
    expect(await readReferenceEventPage(compte.id, b)).toMatchObject({ id: b, typeCode: 'CONTRACT' });
    // Aucun lien orphelin, aucune anomalie de graphe, aucune fuite vers l'autre compte.
    expect(await orphelins(compte)).toEqual([]);
    expect(await audit(compte)).toEqual([]);
    expect(await grapheDuCompte(autre)).toEqual(avantAutre);
  });

  // ══ AC60 : effacement d'un compte ══════════════════════════════════════════

  it('L114REC-E09 — effacement d’un compte : toutes les lignes du graphe partent avec lui ; le second compte garde les siennes (AC60)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const autre = await make.account({ plan: 'premium' });
    for (const c of [compte, autre]) {
      const bien = await make.asset(c, { category: 'IMMOBILIER', name: 'Maison' });
      const f = await make.assetFile(c, { assetId: bien.id });
      const x = await evenement(c, 'INTERVENTION', { label: 'Travaux', fileId: f.id, assetId: bien.id });
      const y = await evenement(c, 'FINANCING', { label: 'Prêt', assetId: bien.id });
      const el = await make.agendaItem(c, { title: 'Échéance', startDate: '2031-03-01', assetIds: [bien.id] });
      expect(await lier(c, x, el.id)).toMatchObject({ status: 'APPLIED' });
      expect(await (await facade()).associateOperations(user(c), { fromOperationId: y, toOperationId: x, nature: 'FINANCING' }))
        .toMatchObject({ status: 'APPLIED' });
      expect(await (await facade()).createOperation(
        { accountId: c.id, actor: { kind: 'USER', userId: c.ownerUserId, channel: 'ASSISTANT' } },
        { declaration: 'Je vais faire remplacer la chaudière', type: { code: 'INTERVENTION' }, status: 'ENVISAGED' },
      )).toMatchObject({ status: 'APPLIED' });
    }
    const avantAutre = await grapheDuCompte(autre);
    expect(avantAutre[0]).toMatchObject({ relations: 1, liens: 1, declarations: 1 });

    // Effacement TERMINAL du compte (effet final de la purge : cascade des clés étrangères).
    await sql`DELETE FROM accounts WHERE id = ${compte.id}`;

    expect((await grapheDuCompte(compte))[0]).toEqual({ relations: 0, liens: 0, declarations: 0, journal: 0, evenements: 0 });
    expect(await grapheDuCompte(autre)).toEqual(avantAutre);
    expect(await orphelins(autre)).toEqual([]);
    expect(await audit(autre)).toEqual([]);
  });

  // ══ AC39, AC74 : exhaustivité et volume ════════════════════════════════════

  it('L114REC-E10 — 210 justificatifs et 30 événements d’Agenda sur une même opération, 240 éléments et 40 opérations sur le bien : page et Timeline rendent tout, sans limite cachée (AC39, AC74)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Immeuble' });
    const gros = await evenement(compte, 'INTERVENTION', { label: 'Réhabilitation complète', assetId: bien.id, realized: '2026-06-01' });

    // 210 justificatifs (au-delà de l'ancienne limite de 200) et 30 événements d'Agenda sur le MÊME événement de référence.
    const fichiers: number[] = [];
    for (let k = 0; k < 210; k++) {
      const f = await make.assetFile(compte, { assetId: bien.id });
      await sql`UPDATE asset_files SET retained_title = ${`Pièce ${String(k).padStart(3, '0')}`}, document_date = ${'2026-06-01'} WHERE id = ${f.id}`;
      fichiers.push(f.id);
      await sql`INSERT INTO business_operation_documents (account_id, operation_id, file_id, origins)
                VALUES (${compte.id}, ${gros}, ${f.id}, ARRAY['USER']::text[])`;
    }
    const elements: number[] = [];
    for (let k = 0; k < 30; k++) {
      const el = await make.agendaItem(compte, { title: `Étape ${k}`, startDate: '2026-06-01', assetIds: [bien.id] });
      elements.push(el.id);
      expect(await lier(compte, gros, el.id)).toMatchObject({ status: 'APPLIED' });
    }
    // Autour : 39 autres événements de référence et 210 éléments autonomes, tous du même bien et à la même date.
    const autresOps: number[] = [];
    for (let k = 0; k < 39; k++) {
      const op = await evenement(compte, 'INTERVENTION', { label: `Lot ${k}`, assetId: bien.id, realized: '2026-06-01' });
      autresOps.push(op);
      const el = await make.agendaItem(compte, { title: `Membre ${k}`, startDate: '2026-06-01', assetIds: [bien.id] });
      expect(await lier(compte, op, el.id)).toMatchObject({ status: 'APPLIED' });
    }
    const autonomes: number[] = [];
    for (let k = 0; k < 210; k++) autonomes.push((await make.agendaItem(compte, { title: `Autonome ${k}`, startDate: '2026-06-01', assetIds: [bien.id] })).id);

    // La page rend TOUT : aucune limite cachée de 200 justificatifs, tous les événements à leur date.
    const t0 = Date.now();
    const { readReferenceEventPage } = await import('@/services/business-operations/graph/reference-event-page');
    const vue = await readReferenceEventPage(compte.id, gros);
    const msPage = Date.now() - t0;
    expect(vue!.documents).toHaveLength(210);
    expect(new Set(vue!.documents.map((d) => d.fileId))).toEqual(new Set(fichiers));
    expect(vue!.agendaItems).toHaveLength(30);
    expect(new Set(vue!.agendaItems.map((a) => a.id))).toEqual(new Set(elements));

    // La Timeline regroupée pagine SANS omission, SANS répétition et SANS couper un groupe.
    const { readAssetTimelinePage } = await import('@/services/agenda/timeline/read');
    const { decodeTimelineCursor } = await import('@/services/agenda/timeline/model');
    const q = (s: string, p: unknown[] = []) => sql.unsafe(s, p as never[]) as unknown as Promise<Array<Record<string, unknown>>>;
    const t1 = Date.now();
    const vus: string[] = [];
    const membresVus: number[] = [];
    let curseur: string | null = null;
    let pages = 0;
    do {
      const page = await readAssetTimelinePage({
        accountId: compte.id, assetId: bien.id, mode: 'grouped', today: AUJOURDHUI,
        limit: 25, cursor: curseur ? (decodeTimelineCursor(curseur, 'grouped') as never) : null, q,
      });
      for (const e of page.entries) {
        vus.push(`${e.kind}:${e.id}`);
        if (e.kind === 'group') for (const m of e.members ?? []) membresVus.push(Number(m.id));
      }
      curseur = page.nextCursor;
      pages++;
      expect(pages).toBeLessThan(80);
    } while (curseur);
    const msTimeline = Date.now() - t1;

    // 40 groupes + 210 éléments autonomes, chacun une fois exactement.
    expect(new Set(vus).size).toBe(vus.length);
    expect(vus.filter((v) => v.startsWith('group:'))).toHaveLength(40);
    expect(vus.filter((v) => v.startsWith('item:'))).toHaveLength(210);
    expect(new Set(vus.filter((v) => v.startsWith('item:')).map((v) => Number(v.slice(5))))).toEqual(new Set(autonomes));
    // Aucun groupe coupé : les 30 membres du gros groupe sont tous rendus avec lui.
    expect(elements.every((id) => membresVus.includes(id))).toBe(true);
    // Mesure indicative (le seuil de recette se fixe sur la préproduction, CDC §23).
    console.info(`[L114REC-E10] page : ${msPage} ms · Timeline paginée (${pages} pages) : ${msTimeline} ms`);
    expect(msPage).toBeLessThan(20000);
    expect(msTimeline).toBeLessThan(40000);
  }, 180000);

  // ══ AC07 : objets autonomes ════════════════════════════════════════════════

  it('L114REC-E11 — justificatif autonome et événement d’Agenda autonome : aucune opération, aucune carte « À traiter », tous deux visibles à leur place (AC07)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const f = await make.assetFile(compte, { assetId: bien.id });
    await sql`UPDATE asset_files SET retained_title = 'Notice de la chaudière' WHERE id = ${f.id}`;
    const a = await make.agendaItem(compte, { title: 'Contrôle technique', startDate: '2027-02-10', assetIds: [bien.id] });
    const b = await make.agendaItem(compte, { title: 'Rappel de contrôle', startDate: '2027-02-01', assetIds: [bien.id] });

    // Aucun traitement : les deux objets vivent seuls.
    expect(await sql`SELECT 1 FROM business_operations WHERE account_id = ${compte.id}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM to_process_actions WHERE account_id = ${compte.id} AND resolved_at IS NULL`).toHaveLength(0);

    // Le justificatif reste consultable et n'est membre d'aucun événement de référence.
    expect(await sql`SELECT 1 FROM business_operation_documents WHERE account_id = ${compte.id}`).toHaveLength(0);

    // Les éléments autonomes restent visibles dans la Timeline du bien, à leur date, sans groupe ni carte.
    const { readAssetTimelineAll } = await import('@/services/agenda/timeline/read');
    const q = (s: string, p: unknown[] = []) => sql.unsafe(s, p as never[]) as unknown as Promise<Array<Record<string, unknown>>>;
    const entrees = await readAssetTimelineAll({ accountId: compte.id, assetId: bien.id, mode: 'grouped', today: AUJOURDHUI, q });
    expect(entrees.filter((e) => e.kind === 'group')).toEqual([]);
    expect(entrees.map((e) => Number(e.id)).sort((x, y) => x - y)).toEqual([a.id, b.id].sort((x, y) => x - y));
    expect(await sql`SELECT 1 FROM to_process_actions WHERE account_id = ${compte.id} AND resolved_at IS NULL`).toHaveLength(0);
  });

  // ══ AC60 : retrait d'un équipement seul ════════════════════════════════════

  it('L114REC-E17 — retrait d’un ÉQUIPEMENT seul (archivage logique par la vraie route) : il quitte la fiche de l’opération, tout le reste est conservé, aucun lien orphelin (AC60)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const [equip] = await sql<{ id: number }[]>`
      INSERT INTO equipments (asset_id, name) VALUES (${bien.id}, 'Chaudière') RETURNING id`;
    const fichier = await make.assetFile(compte, { assetId: bien.id });
    const op = await evenement(compte, 'INTERVENTION', { label: 'Entretien de la chaudière', fileId: fichier.id, assetId: bien.id });
    await sql`INSERT INTO business_operation_equipment_links (account_id, operation_id, equipment_id, asset_id, authority, active)
              VALUES (${compte.id}, ${op}, ${equip.id}, ${bien.id}, 'DOCUMENT', true)`;
    const element = await make.agendaItem(compte, { title: 'Entretien annuel', startDate: '2027-01-12', assetIds: [bien.id] });
    expect(await lier(compte, op, element.id)).toMatchObject({ status: 'APPLIED' });

    const { readReferenceEventPage } = await import('@/services/business-operations/graph/reference-event-page');
    expect((await readReferenceEventPage(compte.id, op))!.equipments.map((e) => e.id)).toEqual([equip.id]);

    asUser(compte);
    const { DELETE } = await import('@/app/api/assets/[id]/equipments/[equipId]/route');
    const rep = await DELETE(
      new NextRequest(`http://local/api/assets/${bien.id}/equipments/${equip.id}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: String(bien.id), equipId: String(equip.id) }) },
    );
    expect(rep.status).toBe(200);

    // L'équipement est archivé (jamais effacé) : il quitte la fiche ; l'événement de référence garde tout le reste.
    expect((await sql<Json[]>`SELECT archived_at IS NOT NULL AS archive FROM equipments WHERE id = ${equip.id}`)[0]).toEqual({ archive: true });
    const vue = await readReferenceEventPage(compte.id, op);
    expect(vue!.equipments).toEqual([]);
    expect(vue!.documents.map((d) => d.fileId)).toEqual([fichier.id]);
    expect(vue!.agendaItems.map((a) => a.id)).toEqual([element.id]);
    expect(vue!.assets.map((a) => a.id)).toEqual([bien.id]);
    expect(await sql`SELECT 1 FROM business_operations WHERE id = ${op} AND invalidated_at IS NULL`).toHaveLength(1);
    expect(await orphelins(compte)).toEqual([]);
    expect(await audit(compte)).toEqual([]);
  });

  // ══ AC66, AC73 : rejeu des contrôles de cohérence ══════════════════════════

  it('L114REC-E18 — rejeu des CONTRÔLES de cohérence (orchestrateur réel, mode correctif) : aucune association refusée recréée, aucune opération supprimée ressuscité, aucun lien du graphe réparé de force (AC66, AC73)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const f1 = await make.assetFile(compte, { assetId: bien.id });
    const f2 = await make.assetFile(compte, { assetId: bien.id });
    const a = await evenement(compte, 'INTERVENTION', { label: 'Réparation de la toiture', fileId: f1.id, assetId: bien.id });
    const b = await evenement(compte, 'CLAIM', { label: 'Dégât des eaux', fileId: f2.id, assetId: bien.id });
    const element = await make.agendaItem(compte, { title: 'Passage de l’expert', startDate: '2026-07-08', assetIds: [bien.id] });
    expect(await lier(compte, b, element.id)).toMatchObject({ status: 'APPLIED' });
    const fa = await facade();
    // 1. Une association posée puis REFUSÉE par l'utilisateur.
    expect(await fa.associateOperations(user(compte), { fromOperationId: b, toOperationId: a, nature: 'CLAIM_REPAIR' })).toMatchObject({ status: 'APPLIED' });
    expect(await fa.dissociateOperations(user(compte), { operationAId: b, operationBId: a, reasonCode: 'L114REC_E18' })).toMatchObject({ status: 'APPLIED' });
    // 2. Un troisième événement de référence SUPPRIMÉ par l'utilisateur (invalidation logique).
    const c = await evenement(compte, 'INTERVENTION', { label: 'Travaux créés à tort', assetId: bien.id });
    expect(await fa.invalidateOperation(user(compte), { operationId: c, reasonCode: 'L114REC_E18' })).toMatchObject({ status: 'APPLIED' });

    const avant = await sql<Json[]>`
      SELECT from_operation_id::int AS f, to_operation_id::int AS t, state, version FROM business_operation_relations
       WHERE account_id = ${compte.id} ORDER BY id`;
    const avantEtats = await sql<Json[]>`
      SELECT id::int AS id, invalidated_at IS NOT NULL AS invalide FROM business_operations WHERE account_id = ${compte.id} ORDER BY id`;
    const avantLiens = await sql<Json[]>`
      SELECT operation_id::int AS op, agenda_item_id::int AS el, state FROM business_operation_agenda_links WHERE account_id = ${compte.id} ORDER BY id`;

    // Campagne RÉELLE de contrôle de cohérence, mode correctif, bornée à ce compte.
    const { runCoherenceFor } = await import('../coherence-run');
    const run = await runCoherenceFor(sql, [compte.id], { mode: 'CORRECTIVE', today: AUJOURDHUI });
    expect(run.status).toBe('COMPLETE');

    // Rien n'est revenu : le refus tient, l'événement supprimé reste supprimé, les liens du graphe sont intacts.
    expect(await sql<Json[]>`
      SELECT from_operation_id::int AS f, to_operation_id::int AS t, state, version FROM business_operation_relations
       WHERE account_id = ${compte.id} ORDER BY id`).toEqual(avant);
    expect(await sql<Json[]>`
      SELECT id::int AS id, invalidated_at IS NOT NULL AS invalide FROM business_operations WHERE account_id = ${compte.id} ORDER BY id`).toEqual(avantEtats);
    // Les liens EXISTANTS sont intacts (le contrôle peut, lui, projeter de nouveaux événements d'Agenda : c'est
    // son métier ; ce qui est interdit, c'est de défaire une décision de l'utilisateur).
    const apresLiens = await sql<Json[]>`
      SELECT operation_id::int AS op, agenda_item_id::int AS el, state FROM business_operation_agenda_links WHERE account_id = ${compte.id} ORDER BY id`;
    for (const l of avantLiens) expect(apresLiens).toEqual(expect.arrayContaining([l]));
    // Aucun lien, aucun événement d'Agenda n'est posé sur l'événement de référence SUPPRIMÉ par l'utilisateur.
    expect(apresLiens.filter((l) => Number(l.op) === c)).toEqual([]);
    expect(await orphelins(compte)).toEqual([]);
    expect(await audit(compte)).toEqual([]);
    // Règle remplacée (carte #806) : « le contrôle du graphe n'est enregistré dans AUCUN contrôle de la campagne »
    // (constat AC73 du passage « recette » #744) devient « la campagne produit la PREUVE du contrôle du graphe » —
    // `COH-OPERATION-GRAPH` raccorde `auditOperationGraph` au registre, en constat seul (aucune réparation).
    expect(run.results['COH-OPERATION-GRAPH']).toEqual({ CONSISTENT: 1 });
  }, 180000);
});
