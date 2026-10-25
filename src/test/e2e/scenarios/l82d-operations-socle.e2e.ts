/**
 * Lot 82D — CDC « Opérations, Agenda, Timeline, Sinistres v5 », lot O-1
 * (socle) et arbitrage V-Q6 — PostgreSQL 16 réel.
 *
 * Chaînes de PRODUCTION : persistance T1 réelle des candidats, consolidation
 * T3 (`consolidateAccountOperations`, `reconsolidateOperations`), service
 * unique de regroupement, agenda manuel (`AgendaWriteService`), projection T4
 * (`projectAccountOperations`), consolidation 76H, invariants du registre.
 * Aucun appel IA (M3 coupé). Assertions limitées aux comptes créés ici.
 *
 *   L82D-E01  reprise 0652 / 0654 / 0655 : rôles, provenances, appartenance — rejouable sans effet
 *   L82D-E02  unicité du principal (base et service) ; autorité de l'utilisateur
 *   L82D-E03  intégrité Opération ↔ AgendaItem du même compte ; 0..1 Opération ; déplacement explicite
 *   L82D-E04  provenance des liens Document ↔ Agenda ; propagation vers le principal, transfert, refus
 *   L82D-E05  appartenance d'un document ≠ provenance ; document multi-Opérations sans duplication
 *   L82D-E06  Pièce existante réutilisée sans duplication (T1 → T3) ; équipements ; refus utilisateur
 *   L82D-E07  lien Agenda ↔ Agenda : quatre cas, fusion existante, un seul principal, idempotence
 *   L82D-E08  dissociation utilisateur mémorisée ; Opération injustifiée invalidée (AC33)
 *   L82D-E09  anti-cartésien : constat sans réparation ; garde des liens directs
 *   L82D-E10  invariants : détection, réparation par le service, idempotence
 *   L82D-E11  déplacement d'un bien : aucun regroupement intercomptes
 *   L82D-E12  76H (V-Q4) : jamais d'absorption du principal ni d'une étape rattachée par l'utilisateur
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import type { AccountRow, AssetRow } from '../factories';
import { RECETTE_TODAY, cand, cible, cibleEquipement, operationsKit, ref, type OperationsKit } from '../datasets/operations-v1';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
const MIG = join(process.cwd(), 'src/db/migrations');
const grouping = () => import('@/services/business-operations/grouping/service');
const invariants = () => import('@/services/business-operations/grouping/invariants');
const runner = () => import('@/services/business-operations/grouping/runner');
const ecriture = () => import('@/services/business-operations/write');
const bus = () => import('@/services/business-operations/events');
const piece = (entityId: number) => ({ type: 'ROOM' as const, entityId, rawLabel: null, confidence: 'certain' as const });

scenario('L82D', 'Opérations v5 — socle O-1 : principal, intégrité, provenance, Pièces, service unique de regroupement, invariants', ({ sql, make }) => {
  let k: OperationsKit;
  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
    k = operationsKit(sql, make);
  });
  afterEach(async () => {
    (await bus()).resetBusinessOperationEventBusForTests();
  });

  async function contexte(): Promise<{ compte: AccountRow & { owner: { id: number } }; maison: AssetRow }> {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    return { compte, maison };
  }
  /** Opération créée par le dépôt (même chemin que T3), source DOCUMENT. */
  async function operation(compte: AccountRow, assetId: number, fileId: number, type = 'INTERVENTION'): Promise<number> {
    const { withBusinessOperationWrite } = await ecriture();
    return (await withBusinessOperationWrite(compte.id, (repo) => repo.create({
      type: { code: type as 'INTERVENTION' }, status: 'REALIZED', realizedDate: '2026-03-12', technicalLabel: 'Dégât des eaux',
      source: { kind: 'DOCUMENT', entityKey: fileId, authority: 'DOCUMENT', confidence: 'certain' },
      assets: [{ assetId, role: 'PRIMARY', authority: 'DOCUMENT' }], reasonCode: 'E2E',
    }))).id;
  }
  async function ajouterDocument(compte: AccountRow, opId: number, fileId: number): Promise<void> {
    const { withBusinessOperationWrite } = await ecriture();
    await withBusinessOperationWrite(compte.id, (repo) => repo.addSource(opId, { kind: 'DOCUMENT', entityKey: fileId, authority: 'DOCUMENT' }));
  }
  const g = async <T>(compte: AccountRow, fn: (ctx: import('@/services/business-operations/grouping/service').GroupingContext) => Promise<T>, actorUserId: number | null = null) =>
    (await grouping()).withGroupingWrite(compte.id, fn, { actorUserId });
  const role = async (itemId: number) => (await sql<Json[]>`
    SELECT business_operation_id::int AS op, operation_role AS role, operation_role_origin AS origin FROM agenda_items WHERE id = ${itemId}`)[0];
  const liensDe = (itemId: number) => sql<{ file: number; prov: string[] }[]>`
    SELECT asset_file_id AS file, provenances AS prov FROM agenda_file_links WHERE agenda_item_id = ${itemId} ORDER BY asset_file_id`;
  const membres = (opId: number) => sql<{ file_id: number; origins: string[]; active: boolean }[]>`
    SELECT file_id, origins, active FROM business_operation_documents WHERE operation_id = ${opId} ORDER BY file_id`;
  const decisions = (compte: AccountRow) => sql<Json[]>`
    SELECT source_kind AS kind, source_entity_key AS key, candidate_operation_id::int AS op, decision FROM business_operation_match_decisions
     WHERE account_id = ${compte.id} AND active ORDER BY id`;
  const evenementT4 = async (compte: AccountRow, assetId: number, fileId: number, date = '2026-03-12', type = 'repair') => (await sql<{ id: number }[]>`
    INSERT INTO agenda_items (account_id, title, start_date, is_automatic, origin_type, origin_ref_type, origin_ref_id, event_nature, business_type)
    VALUES (${compte.id}, 'Réparation — Maison', ${date}, true, 'qualified_document', 'asset_file', ${fileId}, 'HISTORICAL', ${type}) RETURNING id`)[0].id;

  // ══ Reprise ══════════════════════════════════════════════════════════════

  it('L82D-E01 — reprise 0652 / 0654 / 0655 : rôle principal de la représentation T4 d’un événement, échéance de contrat liée, provenances, appartenance ; rejouée : aucun effet', async () => {
    const c = await contexte();
    const f1 = await make.assetFile(c.compte, { assetId: c.maison.id });
    const f2 = await make.assetFile(c.compte, { assetId: c.maison.id });
    const inter = await operation(c.compte, c.maison.id, f1.id);
    const contrat = await operation(c.compte, c.maison.id, f2.id, 'CONTRACT');
    const saisi = await make.agendaItem(c.compte, { title: 'Dégât des eaux', startDate: '2026-03-12', assetIds: [c.maison.id] });
    const projete = (await sql<{ id: number }[]>`
      INSERT INTO agenda_items (account_id, title, start_date, is_automatic, projection_origin) VALUES (${c.compte.id}, 'Intervention', '2026-03-12', true, 'OPERATION') RETURNING id`)[0].id;
    const echeance = (await sql<{ id: number }[]>`
      INSERT INTO agenda_items (account_id, title, start_date, is_automatic, projection_origin) VALUES (${c.compte.id}, 'Fin de contrat', '2027-01-31', true, 'OPERATION') RETURNING id`)[0].id;
    // État HISTORIQUE (avant 0652 / 0654 / 0655), injecté hors déclencheurs.
    await sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE agenda_items SET business_operation_id = ${inter}, operation_role = NULL, operation_role_origin = NULL WHERE id IN (${saisi.id}, ${projete})`;
      await tx`UPDATE agenda_items SET business_operation_id = ${contrat}, operation_role = NULL, operation_role_origin = NULL WHERE id = ${echeance}`;
      await tx`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id, provenances) VALUES (${saisi.id}, ${f1.id}, '{}'), (${projete}, ${f1.id}, '{}'), (${echeance}, ${f2.id}, '{}')`;
      await tx`DELETE FROM business_operation_documents WHERE operation_id IN (${inter}, ${contrat})`;
    });
    const rejouer = async () => {
      for (const f of ['0652_l82d_agenda_operation_role.sql', '0654_l82d_agenda_file_link_provenances.sql', '0655_l82d_operation_rooms_documents.sql']) {
        await sql.begin((tx) => tx.unsafe(readFileSync(join(MIG, f), 'utf8')));
      }
    };
    await rejouer();
    // Saisi avant projeté (règle de la projection) : principal ; la projection et l'échéance sont liées.
    expect(await role(saisi.id)).toEqual({ op: inter, role: 'PRINCIPAL', origin: 'SYSTEM' });
    expect(await role(projete)).toEqual({ op: inter, role: 'RELATED', origin: 'SYSTEM' });
    expect(await role(echeance)).toEqual({ op: contrat, role: 'RELATED', origin: 'SYSTEM' });
    expect(await liensDe(saisi.id)).toEqual([{ file: f1.id, prov: ['MANUAL_DIRECT'] }]);
    expect(await liensDe(projete)).toEqual([{ file: f1.id, prov: ['AI_DIRECT'] }]);
    expect(await membres(inter)).toEqual([{ file_id: f1.id, origins: ['SOURCE'], active: true }]);
    const avant = await sql`SELECT id, operation_role, operation_role_origin, updated_at FROM agenda_items WHERE account_id = ${c.compte.id} ORDER BY id`;
    await rejouer();
    expect(await sql`SELECT id, operation_role, operation_role_origin, updated_at FROM agenda_items WHERE account_id = ${c.compte.id} ORDER BY id`).toEqual(avant);
    const fk = await sql<Json[]>`SELECT condeferrable, condeferred, convalidated FROM pg_constraint WHERE conname = 'agenda_items_business_operation_account_fk'`;
    expect(fk).toEqual([{ condeferrable: true, condeferred: true, convalidated: true }]);
  });

  // ══ Principal ════════════════════════════════════════════════════════════

  it('L82D-E02 — au plus un principal (index unique, service) ; T4 ne remplace jamais le principal choisi par l’utilisateur', async () => {
    const c = await contexte();
    const f = await make.assetFile(c.compte, { assetId: c.maison.id });
    const op = await operation(c.compte, c.maison.id, f.id);
    const a = await make.agendaItem(c.compte, { title: 'Dégât des eaux', startDate: '2026-03-12' });
    const b = await make.agendaItem(c.compte, { title: 'Sinistre cuisine', startDate: '2026-03-12' });
    const { designatePrincipal, attachAgendaItem } = await grouping();
    expect(await g(c.compte, (ctx) => designatePrincipal(ctx, { operationId: op, itemId: a.id, origin: 'T4', reasonCode: 'E2E' }))).toMatchObject({ changed: true, role: 'PRINCIPAL' });
    // Base : un second principal est refusé (23505) ; un chemin hors service qui déplace un élément n'hérite jamais du rôle.
    await g(c.compte, (ctx) => attachAgendaItem(ctx, { operationId: op, itemId: b.id, origin: 'T3', reasonCode: 'E2E' }));
    await expect(sql`UPDATE agenda_items SET operation_role = 'PRINCIPAL' WHERE id = ${b.id}`).rejects.toMatchObject({ code: '23505' });
    const legacy = await make.agendaItem(c.compte, { title: 'Chemin historique' });
    await sql`UPDATE agenda_items SET business_operation_id = ${op}, operation_role = 'PRINCIPAL' WHERE id = ${legacy.id}`;
    expect(await role(legacy.id)).toEqual({ op, role: 'RELATED', origin: null });
    // Choix de l'utilisateur : remplace celui de T4, qui redevient lié.
    await g(c.compte, (ctx) => designatePrincipal(ctx, { operationId: op, itemId: b.id, origin: 'USER', reasonCode: 'E2E' }));
    expect([await role(a.id), await role(b.id)]).toEqual([{ op, role: 'RELATED', origin: 'T4' }, { op, role: 'PRINCIPAL', origin: 'USER' }]);
    // T4 ne le remplace pas ; ni ne le rétrograde.
    expect(await g(c.compte, (ctx) => designatePrincipal(ctx, { operationId: op, itemId: a.id, origin: 'T4', reasonCode: 'E2E' }))).toMatchObject({ changed: false, role: 'RELATED', skipped: 'PRINCIPAL_PROTECTED' });
    expect(await g(c.compte, (ctx) => attachAgendaItem(ctx, { operationId: op, itemId: b.id, role: 'RELATED', origin: 'T4', reasonCode: 'E2E' }))).toMatchObject({ changed: false, skipped: 'PRINCIPAL_PROTECTED' });
    expect((await sql`SELECT id FROM agenda_items WHERE business_operation_id = ${op} AND operation_role = 'PRINCIPAL'`).map((r) => r.id)).toEqual([b.id]);
    // Rejoué : aucune écriture.
    expect(await g(c.compte, (ctx) => designatePrincipal(ctx, { operationId: op, itemId: b.id, origin: 'USER', reasonCode: 'E2E' }))).toMatchObject({ changed: false });
  });

  it('L82D-E03 — même compte (clé composée différée) ; 0..1 Opération : jamais un élément d’une autre Opération active, sauf déplacement explicite de l’utilisateur (mémorisé)', async () => {
    const c = await contexte();
    const autre = await contexte();
    const f = await make.assetFile(c.compte, { assetId: c.maison.id });
    const g1 = await make.assetFile(c.compte, { assetId: c.maison.id });
    const op1 = await operation(c.compte, c.maison.id, f.id);
    const op2 = await operation(c.compte, c.maison.id, g1.id);
    const etranger = await make.agendaItem(autre.compte, { title: 'Agenda autre compte' });
    // Base : relation intercomptes refusée à la validation de la transaction.
    await expect(sql.begin((tx) => tx`UPDATE agenda_items SET business_operation_id = ${op1} WHERE id = ${etranger.id}`)).rejects.toMatchObject({ code: '23503' });
    const { attachAgendaItem } = await grouping();
    await expect(g(c.compte, (ctx) => attachAgendaItem(ctx, { operationId: op1, itemId: etranger.id, origin: 'USER', reasonCode: 'E2E' }))).rejects.toThrow(/CROSS_ACCOUNT/);
    const it1 = await make.agendaItem(c.compte, { title: 'Visite expert', startDate: '2026-03-21' });
    await g(c.compte, (ctx) => attachAgendaItem(ctx, { operationId: op1, itemId: it1.id, origin: 'T3', reasonCode: 'E2E' }));
    expect(await g(c.compte, (ctx) => attachAgendaItem(ctx, { operationId: op2, itemId: it1.id, origin: 'T4', reasonCode: 'E2E' }))).toMatchObject({ changed: false, skipped: 'LINKED_ELSEWHERE' });
    expect(await role(it1.id)).toMatchObject({ op: op1 });
    // Déplacement (§8.4) : geste utilisateur, mémorisé des deux côtés.
    await g(c.compte, (ctx) => attachAgendaItem(ctx, { operationId: op2, itemId: it1.id, origin: 'USER', move: true, reasonCode: 'E2E_MOVE' }), c.compte.owner.id);
    expect(await role(it1.id)).toEqual({ op: op2, role: 'RELATED', origin: 'USER' });
    expect(await decisions(c.compte)).toEqual(expect.arrayContaining([
      { kind: 'AGENDA', key: String(it1.id), op: op1, decision: 'REJECTED' }, { kind: 'AGENDA', key: String(it1.id), op: op2, decision: 'CONFIRMED' },
    ]));
  });

  // ══ Provenance et propagation ════════════════════════════════════════════

  it('L82D-E04 — provenances MANUAL_DIRECT / AI_DIRECT / OPERATION_PRINCIPAL : propagation (AC05, AC06), lien précis conservé (AC08), changement de principal (AC07), refus de l’utilisateur (§10)', async () => {
    const c = await contexte();
    const constat = await make.assetFile(c.compte, { assetId: c.maison.id });
    const rapport = await make.assetFile(c.compte, { assetId: c.maison.id });
    const facture = await make.assetFile(c.compte, { assetId: c.maison.id });
    const op = await operation(c.compte, c.maison.id, constat.id, 'CLAIM');
    await ajouterDocument(c.compte, op, rapport.id);
    const { createAgendaItem, updateAgendaItem } = await import('@/services/agenda/AgendaWriteService');
    const visite = await createAgendaItem({ title: 'Visite expert', startDate: '2026-03-21', assetIds: [c.maison.id], fileIds: [rapport.id], homeCategory: 'information' }, c.compte.id, c.compte.ownerUserId);
    const degat = await createAgendaItem({ title: 'Dégât des eaux', startDate: '2026-03-12', assetIds: [c.maison.id], homeCategory: 'information' }, c.compte.id, c.compte.ownerUserId);
    expect(await liensDe(visite.id)).toEqual([{ file: rapport.id, prov: ['MANUAL_DIRECT'] }]);
    const { attachAgendaItem, designatePrincipal, detachAgendaItem, recomputePrincipal } = await grouping();
    await g(c.compte, (ctx) => attachAgendaItem(ctx, { operationId: op, itemId: visite.id, origin: 'USER', reasonCode: 'E2E' }));
    // Sans principal : aucun lien artificiel (§7.2).
    expect(await liensDe(visite.id)).toEqual([{ file: rapport.id, prov: ['MANUAL_DIRECT'] }]);
    // Principal désigné (T4) : TOUS les documents de l'Opération lui sont liés, rétroactivement (AC05, AC06).
    await g(c.compte, (ctx) => designatePrincipal(ctx, { operationId: op, itemId: degat.id, origin: 'T4', reasonCode: 'E2E' }));
    expect(await liensDe(degat.id)).toEqual([{ file: constat.id, prov: ['OPERATION_PRINCIPAL'] }, { file: rapport.id, prov: ['OPERATION_PRINCIPAL'] }]);
    expect(await liensDe(visite.id)).toEqual([{ file: rapport.id, prov: ['MANUAL_DIRECT'] }]);
    // Nouveau document de l'Opération : propagé (idempotent).
    await ajouterDocument(c.compte, op, facture.id);
    expect(await g(c.compte, (ctx) => recomputePrincipal(ctx, op))).toMatchObject({ added: 1, removed: 0 });
    expect(await g(c.compte, (ctx) => recomputePrincipal(ctx, op))).toMatchObject({ added: 0, removed: 0 });
    // Changement de principal (AC07) : la propagation suit ; le lien précis de la visite est conservé et cumule (AC08).
    await g(c.compte, (ctx) => designatePrincipal(ctx, { operationId: op, itemId: visite.id, origin: 'USER', reasonCode: 'E2E' }));
    expect(await liensDe(degat.id)).toEqual([]);
    expect(await liensDe(visite.id)).toEqual([
      { file: constat.id, prov: ['OPERATION_PRINCIPAL'] }, { file: rapport.id, prov: ['MANUAL_DIRECT', 'OPERATION_PRINCIPAL'] }, { file: facture.id, prov: ['OPERATION_PRINCIPAL'] },
    ]);
    // Modifier l'intitulé ne s'approprie pas les liens propagés.
    await updateAgendaItem(visite.id, { title: 'Visite de l’expert' }, c.compte.id, c.compte.ownerUserId);
    expect((await liensDe(visite.id)).find((l) => l.file === constat.id)).toEqual({ file: constat.id, prov: ['OPERATION_PRINCIPAL'] });
    // L'utilisateur retire la facture de l'élément : lien supprimé, refus mémorisé, jamais recréé.
    await updateAgendaItem(visite.id, { fileIds: [constat.id, rapport.id] }, c.compte.id, c.compte.ownerUserId);
    expect((await liensDe(visite.id)).map((l) => l.file)).toEqual([constat.id, rapport.id]);
    expect(await decisions(c.compte)).toContainEqual({ kind: 'PRINCIPAL_LINK', key: String(facture.id), op, decision: 'REJECTED' });
    expect(await g(c.compte, (ctx) => recomputePrincipal(ctx, op))).toMatchObject({ added: 0, removed: 0 });
    // Fin de preuve T4 : seule AI_DIRECT est retirée.
    const { addFileLinkProvenance, removeFileLinkProvenance } = await import('@/services/business-operations/grouping/provenance');
    const { postgresRunner } = await runner();
    await addFileLinkProvenance(postgresRunner(sql), visite.id, [rapport.id], 'AI_DIRECT');
    await removeFileLinkProvenance(postgresRunner(sql), [visite.id], [rapport.id], 'AI_DIRECT');
    expect((await liensDe(visite.id)).find((l) => l.file === rapport.id)).toEqual({ file: rapport.id, prov: ['MANUAL_DIRECT', 'OPERATION_PRINCIPAL'] });
    // Dissociation : la propagation quitte l'élément, son lien précis reste.
    await g(c.compte, (ctx) => detachAgendaItem(ctx, { itemId: visite.id, origin: 'USER', reasonCode: 'E2E' }));
    expect(await liensDe(visite.id)).toEqual([{ file: rapport.id, prov: ['MANUAL_DIRECT'] }]);
  });

  it('L82D-E05 — appartenance ≠ provenance (§27.3) : SOURCE tenue par les sources, USER par le geste ; un document dans deux Opérations sans duplication (AC09) ; document sans lien Agenda (AC04)', async () => {
    const c = await contexte();
    const devis = await make.assetFile(c.compte, { assetId: c.maison.id });
    const f1 = await make.assetFile(c.compte, { assetId: c.maison.id });
    const f2 = await make.assetFile(c.compte, { assetId: c.maison.id });
    const photo = await make.assetFile(c.compte, { assetId: c.maison.id });
    const op1 = await operation(c.compte, c.maison.id, f1.id);
    const op2 = await operation(c.compte, c.maison.id, f2.id, 'CLAIM');
    await ajouterDocument(c.compte, op1, devis.id);
    await ajouterDocument(c.compte, op2, devis.id);
    expect((await membres(op1)).map((m) => m.file_id)).toEqual([devis.id, f1.id].sort((a, b) => a - b));
    expect((await membres(op2)).map((m) => m.file_id)).toEqual([devis.id, f2.id].sort((a, b) => a - b));
    expect(await sql`SELECT count(*)::int AS n FROM asset_files WHERE id = ${devis.id}`).toEqual([{ n: 1 }]);
    const { attachDocument, detachDocument } = await grouping();
    // Photo sans candidat ni lien d'agenda : rejoint l'Opération par geste (aucune source créée).
    expect(await g(c.compte, (ctx) => attachDocument(ctx, { operationId: op2, fileId: photo.id, reasonCode: 'E2E' }))).toBe(true);
    expect((await membres(op2)).find((m) => m.file_id === photo.id)).toEqual({ file_id: photo.id, origins: ['USER'], active: true });
    expect(await sql`SELECT count(*)::int AS n FROM business_operation_sources WHERE source_entity_key = ${String(photo.id)}`).toEqual([{ n: 0 }]);
    // Source désactivée : l'appartenance SOURCE s'éteint (déclencheur), quel que soit le chemin.
    await sql`UPDATE business_operation_sources SET active = false, superseded_at = now() WHERE operation_id = ${op1} AND source_entity_key = ${String(devis.id)}`;
    expect((await membres(op1)).find((m) => m.file_id === devis.id)).toEqual({ file_id: devis.id, origins: [], active: false });
    expect((await membres(op2)).find((m) => m.file_id === devis.id)?.active).toBe(true);
    // Dissociation utilisateur : refus mémorisé, preuves retirées de CETTE Opération seulement.
    await g(c.compte, (ctx) => detachDocument(ctx, { operationId: op2, fileId: devis.id, reasonCode: 'E2E' }));
    expect((await membres(op2)).find((m) => m.file_id === devis.id)?.active).toBe(false);
    expect(await decisions(c.compte)).toContainEqual({ kind: 'DOCUMENT', key: String(devis.id), op: op2, decision: 'REJECTED' });
    expect(await sql`SELECT count(*)::int AS n FROM business_operations WHERE id = ${op2} AND invalidated_at IS NULL`).toEqual([{ n: 1 }]);
  });

  // ══ Pièces et équipements existants ══════════════════════════════════════

  it('L82D-E06 — V-Q6 / V-Q8 : la Pièce EXISTANTE est rattachée par T3 sans duplication ; rejoué sans écriture ; Pièce d’un autre compte ignorée ; refus utilisateur respecté (Pièce, équipement)', async () => {
    const c = await contexte();
    const autre = await contexte();
    const [cuisine] = await sql<{ id: number }[]>`INSERT INTO substructures (asset_id, name) VALUES (${c.maison.id}, 'Cuisine') RETURNING id`;
    const [ailleurs] = await sql<{ id: number }[]>`INSERT INTO substructures (asset_id, name) VALUES (${autre.maison.id}, 'Cuisine') RETURNING id`;
    const chaudiere = await k.equipement(c.maison, 'Chaudière');
    const pieces = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM substructures WHERE asset_id = ${c.maison.id}`)[0].n;
    const f = await k.document(c.compte, c.maison.id, [cand({
      summary: 'Réparation fuite cuisine', provider: 'Plomberie Durand',
      targetHints: [cible(c.maison.id), piece(cuisine.id), piece(ailleurs.id), cibleEquipement(chaudiere)],
      businessReferences: [ref('INVOICE', 'F-2026-31')], temporalHints: { realizedDate: '2026-03-12' },
    })], { type: 'REPAIR_INVOICE', title: 'Facture fuite', date: '2026-03-12' });
    await k.passer(c.compte);
    const [op] = await k.actives(c.compte);
    const liensPiece = () => sql<Json[]>`SELECT substructure_id, asset_id, authority, active FROM business_operation_room_links WHERE operation_id = ${op.id} ORDER BY substructure_id`;
    expect(await liensPiece()).toEqual([{ substructure_id: cuisine.id, asset_id: c.maison.id, authority: 'DOCUMENT', active: true }]);
    expect(await pieces()).toBe(1);
    expect(await k.liensEquipement(op.id)).toEqual([{ equipment_id: chaudiere, asset_id: c.maison.id }]);
    // Rejoué : aucune écriture, aucune Pièce créée.
    const h = await k.historique(c.compte);
    const { reconsolidateOperations } = await import('@/services/business-operations/consolidation/consolidator');
    await reconsolidateOperations(c.compte.id, [op.id], { today: RECETTE_TODAY });
    expect(await k.historique(c.compte)).toBe(h);
    expect(await pieces()).toBe(1);
    // Refus utilisateur : la Pièce et l'équipement ne sont plus reliés par T3.
    const { detachRoom, detachEquipment } = await grouping();
    await g(c.compte, (ctx) => detachRoom(ctx, { operationId: op.id, substructureId: cuisine.id, origin: 'USER', reasonCode: 'E2E' }));
    await g(c.compte, (ctx) => detachEquipment(ctx, { operationId: op.id, equipmentId: chaudiere, origin: 'USER', reasonCode: 'E2E' }));
    await reconsolidateOperations(c.compte.id, [op.id], { today: RECETTE_TODAY });
    expect((await liensPiece()).map((l) => l.active)).toEqual([false]);
    expect(await k.liensEquipement(op.id)).toEqual([]);
    expect(await decisions(c.compte)).toEqual(expect.arrayContaining([
      { kind: 'ROOM', key: String(cuisine.id), op: op.id, decision: 'REJECTED' }, { kind: 'EQUIPMENT', key: String(chaudiere), op: op.id, decision: 'REJECTED' },
    ]));
    expect(f).toBeGreaterThan(0);
  });

  // ══ Agenda ↔ Agenda ══════════════════════════════════════════════════════

  it('L82D-E07 — lien Agenda ↔ Agenda (§8.3, AC02, E2E-08 / E2E-09) : création, rattachement, no-op, fusion existante — un seul principal, éléments distincts, idempotent', async () => {
    const c = await contexte();
    const { linkAgendaItems, designatePrincipal } = await grouping();
    const degat = await make.agendaItem(c.compte, { title: 'Dégât des eaux', startDate: '2026-03-12' });
    const visite = await make.agendaItem(c.compte, { title: 'Visite expert', startDate: '2026-03-21' });
    const reparation = await make.agendaItem(c.compte, { title: 'Réparation plafond', startDate: '2026-04-18' });
    const cree = await g(c.compte, (ctx) => linkAgendaItems(ctx, { itemA: degat.id, itemB: visite.id }), c.compte.owner.id);
    expect(cree.case).toBe('CREATE');
    const [op] = await k.actives(c.compte);
    expect(op).toMatchObject({ id: cree.operationId, type_code: null });
    expect([await role(degat.id), await role(visite.id)]).toEqual([{ op: op.id, role: 'RELATED', origin: 'USER' }, { op: op.id, role: 'RELATED', origin: 'USER' }]);
    expect(await g(c.compte, (ctx) => linkAgendaItems(ctx, { itemA: visite.id, itemB: reparation.id }))).toEqual({ case: 'ATTACH', operationId: op.id });
    expect(await g(c.compte, (ctx) => linkAgendaItems(ctx, { itemA: degat.id, itemB: reparation.id }))).toEqual({ case: 'NOOP', operationId: op.id });
    // Deux regroupements, chacun avec son principal, liés par l'utilisateur : fusion existante, un seul principal.
    const constat = await make.agendaItem(c.compte, { title: 'Constat amiable', startDate: '2026-03-13' });
    const devis = await make.agendaItem(c.compte, { title: 'Devis peintre', startDate: '2026-03-30' });
    const autre = await g(c.compte, (ctx) => linkAgendaItems(ctx, { itemA: constat.id, itemB: devis.id }));
    await g(c.compte, (ctx) => designatePrincipal(ctx, { operationId: op.id, itemId: degat.id, origin: 'T4', reasonCode: 'E2E' }));
    await g(c.compte, (ctx) => designatePrincipal(ctx, { operationId: autre.operationId, itemId: constat.id, origin: 'T4', reasonCode: 'E2E' }));
    const fusion = await g(c.compte, (ctx) => linkAgendaItems(ctx, { itemA: devis.id, itemB: reparation.id }));
    expect(fusion).toEqual({ case: 'MERGE', operationId: Math.min(op.id, autre.operationId) });
    const restants = await sql<Json[]>`SELECT id, operation_role AS role FROM agenda_items WHERE business_operation_id = ${fusion.operationId} ORDER BY id`;
    expect(restants.map((r) => r.id)).toEqual([degat.id, visite.id, reparation.id, constat.id, devis.id]);
    expect(restants.filter((r) => r.role === 'PRINCIPAL').map((r) => r.id)).toEqual([degat.id]);
    expect((await k.actives(c.compte)).map((o) => o.id)).toEqual([fusion.operationId]);
    // Rejoué : aucun changement.
    expect(await g(c.compte, (ctx) => linkAgendaItems(ctx, { itemA: devis.id, itemB: reparation.id }))).toEqual({ case: 'NOOP', operationId: fusion.operationId });
    // Types incompatibles : refus explicite (qualification = T3, V-Q5), rien n'est écrit.
    const f1 = await make.assetFile(c.compte, { assetId: c.maison.id });
    const f2 = await make.assetFile(c.compte, { assetId: c.maison.id });
    const opA = await operation(c.compte, c.maison.id, f1.id, 'INTERVENTION');
    const opB = await operation(c.compte, c.maison.id, f2.id, 'CONTRACT');
    const x = await make.agendaItem(c.compte, { title: 'x' });
    const y = await make.agendaItem(c.compte, { title: 'y' });
    const { attachAgendaItem } = await grouping();
    await g(c.compte, (ctx) => attachAgendaItem(ctx, { operationId: opA, itemId: x.id, origin: 'USER', reasonCode: 'E2E' }));
    await g(c.compte, (ctx) => attachAgendaItem(ctx, { operationId: opB, itemId: y.id, origin: 'USER', reasonCode: 'E2E' }));
    await expect(g(c.compte, (ctx) => linkAgendaItems(ctx, { itemA: x.id, itemB: y.id }))).rejects.toThrow(/MERGE_REFUSED/);
    expect([await role(x.id), await role(y.id)].map((r) => r.op)).toEqual([opA, opB]);
  });

  it('L82D-E08 — décision utilisateur prioritaire (§10, E2E-10) : élément dissocié jamais rattaché à nouveau par T3 / T4 ; regroupement devenu injustifié invalidé, éléments conservés (AC33)', async () => {
    const c = await contexte();
    const { linkAgendaItems, detachAgendaItem, attachAgendaItem } = await grouping();
    const a = await make.agendaItem(c.compte, { title: 'Dégât des eaux' });
    const b = await make.agendaItem(c.compte, { title: 'Visite expert' });
    const { operationId } = await g(c.compte, (ctx) => linkAgendaItems(ctx, { itemA: a.id, itemB: b.id }));
    await g(c.compte, (ctx) => detachAgendaItem(ctx, { itemId: b.id, origin: 'USER', reasonCode: 'E2E' }));
    expect(await role(b.id)).toEqual({ op: null, role: null, origin: null });
    expect(await g(c.compte, (ctx) => attachAgendaItem(ctx, { operationId, itemId: b.id, origin: 'T4', reasonCode: 'E2E' }))).toMatchObject({ changed: false, skipped: 'USER_REJECTED' });
    expect(await g(c.compte, (ctx) => attachAgendaItem(ctx, { operationId, itemId: b.id, origin: 'T3', reasonCode: 'E2E' }))).toMatchObject({ changed: false, skipped: 'USER_REJECTED' });
    // Dernier élément dissocié : plus aucune justification → invalidée ; les éléments restent.
    await g(c.compte, (ctx) => detachAgendaItem(ctx, { itemId: a.id, origin: 'USER', reasonCode: 'E2E' }));
    expect(await sql`SELECT invalidation_reason FROM business_operations WHERE id = ${operationId}`).toEqual([{ invalidation_reason: 'E2E_UNSUPPORTED' }]);
    expect(await sql`SELECT count(*)::int AS n FROM agenda_items WHERE id IN (${a.id}, ${b.id})`).toEqual([{ n: 2 }]);
    // Un nouveau geste explicite de l'utilisateur lève le refus.
    const c2 = await make.agendaItem(c.compte, { title: 'Réparation' });
    const r = await g(c.compte, (ctx) => linkAgendaItems(ctx, { itemA: b.id, itemB: c2.id }));
    expect(r.case).toBe('CREATE');
  });

  // ══ Anti-cartésien, invariants ═══════════════════════════════════════════

  it('L82D-E09 — anti-cartésien (P19, AC50, E2E-25) : produit Documents × Équipements automatique constaté sans réparation ; un lien de l’utilisateur ne fait pas constat', async () => {
    const c = await contexte();
    const e1 = await k.equipement(c.maison, 'Alarme');
    const e2 = await k.equipement(c.maison, 'Caméra');
    const f1 = await make.assetFile(c.compte, { assetId: c.maison.id });
    const f2 = await make.assetFile(c.compte, { assetId: c.maison.id });
    const op = await operation(c.compte, c.maison.id, f1.id, 'CONTRACT');
    await ajouterDocument(c.compte, op, f2.id);
    const { attachEquipment } = await grouping();
    for (const e of [e1, e2]) await g(c.compte, (ctx) => attachEquipment(ctx, { operationId: op, equipmentId: e, origin: 'USER', reasonCode: 'E2E' }));
    const { postgresRunner } = await runner();
    const { OPERATIONS_GROUPING_INVARIANTS } = await invariants();
    const anti = OPERATIONS_GROUPING_INVARIANTS.find((i) => i.id === 'O1-ANTI-CARTESIAN')!;
    expect(await anti.detect(postgresRunner(sql), c.compte.id)).toEqual([]);
    for (const f of [f1.id, f2.id]) for (const e of [e1, e2]) {
      await sql`INSERT INTO document_asset_links (account_id, file_id, asset_id, equipment_id, link_role, origin, confidence, status)
                VALUES (${c.compte.id}, ${f}, ${c.maison.id}, ${e}, 'SECONDARY', 'AI', 1, 'ACTIVE')
                ON CONFLICT DO NOTHING`;
    }
    const constats = await anti.detect(postgresRunner(sql), c.compte.id);
    expect(constats).toEqual([expect.objectContaining({ objectKey: `operation:${op}`, nature: 'CARTESIAN_DOCUMENT_EQUIPMENT', repairable: false })]);
    const { repairGroupingFinding } = await invariants();
    expect(await g(c.compte, (ctx) => repairGroupingFinding(ctx, constats[0]))).toEqual({ repaired: false, changed: false });
    await sql`UPDATE document_asset_links SET origin = 'USER' WHERE account_id = ${c.compte.id} AND file_id = ${f1.id} AND equipment_id = ${e1}`;
    expect(await anti.detect(postgresRunner(sql), c.compte.id)).toEqual([]);
  });

  it('L82D-E10 — invariants O-1 (registre 82B) : chaque écart injecté est détecté, réparé par le service de regroupement, puis plus rien ; réparation rejouée sans effet', async () => {
    const c = await contexte();
    const f1 = await make.assetFile(c.compte, { assetId: c.maison.id });
    const f2 = await make.assetFile(c.compte, { assetId: c.maison.id });
    const op = await operation(c.compte, c.maison.id, f1.id, 'CLAIM');
    await ajouterDocument(c.compte, op, f2.id);
    const absorbee = await operation(c.compte, c.maison.id, (await make.assetFile(c.compte, { assetId: c.maison.id })).id, 'CLAIM');
    const p = await make.agendaItem(c.compte, { title: 'Dégât des eaux' });
    const s = await make.agendaItem(c.compte, { title: 'Visite expert' });
    const orphelin = await make.agendaItem(c.compte, { title: 'Ancienne étape' });
    const { designatePrincipal, attachAgendaItem } = await grouping();
    await g(c.compte, (ctx) => designatePrincipal(ctx, { operationId: op, itemId: p.id, origin: 'T4', reasonCode: 'E2E' }));
    await g(c.compte, (ctx) => attachAgendaItem(ctx, { operationId: op, itemId: s.id, origin: 'T3', reasonCode: 'E2E' }));
    const { detectGroupingFindings, repairGroupingFinding } = await invariants();
    const { postgresRunner } = await runner();
    const detecter = () => detectGroupingFindings(postgresRunner(sql), c.compte.id);
    expect(await detecter()).toEqual([]);
    // Écarts injectés hors déclencheurs (état historique ou chemin défaillant).
    await sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`DELETE FROM agenda_file_links WHERE agenda_item_id = ${p.id} AND asset_file_id = ${f2.id}`;           // propagation manquante
      await tx`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id, provenances) VALUES (${s.id}, ${f1.id}, '{OPERATION_PRINCIPAL}')`; // propagation errante
      await tx`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id, provenances) VALUES (${s.id}, ${f2.id}, '{}')`; // provenance vide
      await tx`UPDATE business_operation_documents SET origins = '{}' WHERE operation_id = ${op} AND file_id = ${f2.id}`;   // appartenance perdue
      await tx`UPDATE business_operations SET merged_into_operation_id = ${op}, invalidated_at = now(), invalidation_reason = 'MERGED' WHERE id = ${absorbee}`;
      await tx`UPDATE agenda_items SET business_operation_id = ${absorbee}, operation_role = 'RELATED' WHERE id = ${orphelin.id}`; // lié à une fusionnée
    });
    const constats = await detecter();
    expect(constats.map((f) => [f.invariantId, f.nature]).sort()).toEqual([
      ['O1-AGENDA-ONE-OPERATION', 'MERGED_OPERATION'],
      ['O1-DOCUMENT-MEMBERSHIP', 'MISSING_SOURCE_MEMBERSHIP'],
      ['O1-LINK-PROVENANCE', 'EMPTY_PROVENANCE'],
      ['O1-PRINCIPAL-DOCUMENTS', 'STRAY_PRINCIPAL_LINK'],
    ]);
    for (const f of constats) {
      expect(await g(c.compte, (ctx) => repairGroupingFinding(ctx, f))).toMatchObject({ repaired: true });
    }
    expect(await detecter()).toEqual([]);
    expect(await role(orphelin.id)).toMatchObject({ op, role: 'RELATED' });
    expect((await liensDe(p.id)).map((l) => [l.file, l.prov])).toEqual([[f1.id, ['OPERATION_PRINCIPAL']], [f2.id, ['OPERATION_PRINCIPAL']]]);
    expect(await liensDe(s.id)).toEqual([{ file: f2.id, prov: ['MANUAL_DIRECT'] }]);
    // Réparation rejouée : aucune écriture.
    for (const f of constats) {
      expect(await g(c.compte, (ctx) => repairGroupingFinding(ctx, f))).toMatchObject({ repaired: true, changed: false });
    }
    expect(await detecter()).toEqual([]);
  });

  // ══ Transfert, 76H ═══════════════════════════════════════════════════════

  it('L82D-E11 — §28 : un regroupement ne franchit jamais deux comptes (élément, appartenance USER, Pièce)', async () => {
    const c = await contexte();
    const cible = await make.account({ plan: 'premium' });
    const f = await make.assetFile(c.compte, { assetId: c.maison.id });
    const photo = await make.assetFile(c.compte, { assetId: c.maison.id });
    const op = await operation(c.compte, c.maison.id, f.id);
    const [cuisine] = await sql<{ id: number }[]>`INSERT INTO substructures (asset_id, name) VALUES (${c.maison.id}, 'Cuisine') RETURNING id`;
    const item = await make.agendaItem(c.compte, { title: 'Dégât des eaux' });
    const { attachAgendaItem, attachDocument, attachRoom, detachCrossAccountGroupingInTx } = await grouping();
    await g(c.compte, async (ctx) => {
      await attachAgendaItem(ctx, { operationId: op, itemId: item.id, role: 'PRINCIPAL', origin: 'T4', reasonCode: 'E2E' });
      await attachDocument(ctx, { operationId: op, fileId: photo.id, reasonCode: 'E2E' });
      await attachRoom(ctx, { operationId: op, substructureId: cuisine.id, origin: 'USER', reasonCode: 'E2E' });
    });
    const { postgresRunner } = await runner();
    // L'Opération change de compte, le bien, l'élément et la photo restent : tout lien est retiré à la validation.
    const r = await sql.begin(async (tx) => {
      await tx`UPDATE business_operations SET account_id = ${cible.id} WHERE id = ${op}`;
      return detachCrossAccountGroupingInTx(postgresRunner(tx), [c.compte.id, cible.id]);
    });
    expect(r).toEqual({ agendaItems: 1, documents: 1, rooms: 1 });
    expect(await role(item.id)).toEqual({ op: null, role: null, origin: null });
    expect(await liensDe(item.id)).toEqual([]);
  });

  it('L82D-E12 — 76H restreint (V-Q4) : ni le principal d’une Opération ni une étape rattachée par l’utilisateur ne sont absorbés ; une vraie représentation dupliquée l’est', async () => {
    const c = await contexte();
    const f = await make.assetFile(c.compte, { assetId: c.maison.id });
    const op = await operation(c.compte, c.maison.id, f.id);
    const autreOp = await operation(c.compte, c.maison.id, (await make.assetFile(c.compte, { assetId: c.maison.id })).id);
    const principal = await evenementT4(c.compte, c.maison.id, f.id);
    const doublon = await evenementT4(c.compte, c.maison.id, f.id, '2026-03-12', 'maintenance');
    const etape = await evenementT4(c.compte, c.maison.id, f.id, '2026-03-13');
    const principalAilleurs = await evenementT4(c.compte, c.maison.id, f.id, '2026-03-12');
    const { attachAgendaItem, designatePrincipal } = await grouping();
    await g(c.compte, async (ctx) => {
      await designatePrincipal(ctx, { operationId: op, itemId: principal, origin: 'T4', reasonCode: 'E2E' });
      await attachAgendaItem(ctx, { operationId: op, itemId: etape, origin: 'USER', reasonCode: 'E2E' });
      await designatePrincipal(ctx, { operationId: autreOp, itemId: principalAilleurs, origin: 'T4', reasonCode: 'E2E' });
    });
    await sql`UPDATE business_operations SET invalidated_at = now(), invalidation_reason = 'E2E' WHERE id = ${autreOp}`;
    // Lot 87B : le moteur d'absorption (gardes inchangées) n'est plus appelé par la projection, seulement dans la
    // transaction d'application d'une décision T4 (`semantic/apply.ts`) — même moteur, testé ici directement.
    const { consolidateInTx } = await import('@/services/business-operations/agenda-projection/consolidation');
    const r = await sql.begin((tx) => consolidateInTx(tx, {
      accountId: c.compte.id, operationId: op, principalId: principal, absorbedIds: [doublon, etape, principalAilleurs], linkPrincipal: false,
      reason: 'T4_SEMANTIC_SAME_OCCURRENCE', origin: 'PROJECTION',
    }));
    expect(r.absorbed).toEqual([doublon]);
    expect(r.protectedIds.sort((a, b) => a - b)).toEqual([etape, principalAilleurs].sort((a, b) => a - b));
    expect((await sql`SELECT id FROM agenda_items WHERE id IN (${etape}, ${principalAilleurs}) ORDER BY id`).length).toBe(2);
    expect(await role(principal)).toMatchObject({ op, role: 'PRINCIPAL' });
  });
});
