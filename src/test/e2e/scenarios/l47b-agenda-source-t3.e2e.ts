/**
 * Lot 47B — l'Agenda comme source T3 (point 1) et faits historiques passés
 * affichés réalisés (point 2) — base PostgreSQL réelle.
 *
 * CDC Opérations V1 ch. 3.1, 17, B4, B9, B16, C2, C4 TRG-012 à TRG-014, C5,
 * C7.2, C8, C16.1, C16.2, C19 ; recette F-020 à F-022, F-085 à F-087 ;
 * décision PO du 12/10 (historique « réalisé », aucun statut écrit).
 *
 * Agenda par `AgendaWriteService` / la primitive (gestes de production) ;
 * T3 par `consolidateAgendaItems` / `consolidateAccountOperations`
 * (moteur de production, sans M3) ; projection par
 * `OperationAgendaProjectionService`. Aucun appel IA.
 */
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
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
vi.mock('@/services/coherence/impact-propagation.service', async (o) => ({
  ...(await o<object>()), emitAgendaItemCreated: async () => {},
}));

const AUJOURDHUI = new Date().toISOString().slice(0, 10);
const plus = (jours: number) => new Date(Date.now() + jours * 86_400_000).toISOString().slice(0, 10);
const bus = () => import('@/services/business-operations/events');
const ecriture = () => import('@/services/business-operations/write');
const projection = () => import('@/services/business-operations/agenda-projection/service');
const agendaWrite = () => import('@/services/agenda/AgendaWriteService');
const t3Agenda = () => import('@/services/business-operations/consolidation/agenda-source-consolidator');

type Json = Record<string, unknown>;
type Op = { id: number; type_code: string | null; status: string; planned_date: string | null; realized_date: string | null; invalidated: boolean };

scenario('L47B', 'Agenda source T3 (TRG-012 à 014) et historique passé affiché réalisé', ({ sql, make }) => {
  afterEach(async () => {
    (await bus()).resetBusinessOperationEventBusForTests();
  });
  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
  });

  const ops = (compte: AccountRow) => sql<Op[]>`
    SELECT id::int, type_code, status, planned_date::text AS planned_date, realized_date::text AS realized_date,
           invalidated_at IS NOT NULL AS invalidated
      FROM business_operations WHERE account_id = ${compte.id} AND merged_into_operation_id IS NULL ORDER BY id`;
  const sourcesAgenda = (opId: number) => sql<{ entity: string; active: boolean; authority: string }[]>`
    SELECT source_entity_key AS entity, active, authority FROM business_operation_sources
     WHERE operation_id = ${opId} AND source_kind = 'AGENDA' ORDER BY id`;
  const items = (compte: AccountRow) => sql<{ id: number; op: number | null; projection_origin: string | null; manual_status: string | null; start_date: string | null }[]>`
    SELECT id, business_operation_id::int AS op, projection_origin, manual_status, start_date::text AS start_date
      FROM agenda_items WHERE account_id = ${compte.id} ORDER BY id`;
  const historique = (opId: number) => sql<{ event_type: string; reason_code: string; after: Json | null }[]>`
    SELECT event_type, reason_code, after_json AS after FROM business_operation_history WHERE operation_id = ${opId} ORDER BY id`;
  const t3 = async (compte: AccountRow, itemIds: number[]) => (await t3Agenda()).consolidateAgendaItems(compte.id, itemIds, { today: AUJOURDHUI });
  const projeter = async (compte: AccountRow, ids?: number[]) =>
    (await projection()).projectAccountOperations(compte.id, ids ? { operationIds: ids, correlationId: 'corr-47b' } : { all: true, correlationId: 'corr-47b' });

  async function jobsT3(compte: AccountRow) {
    return sql<{ id: number; target_type: string; payload: Json }[]>`
      SELECT id, target_type, payload FROM ai_job_queue WHERE treatment = 'T3' AND account_id = ${compte.id} ORDER BY id`;
  }
  async function attendreJobAgenda(compte: AccountRow, itemId: number) {
    for (let i = 0; i < 40; i++) {
      const j = (await jobsT3(compte)).find((x) => x.target_type === 'business_operations'
        && ((x.payload.events as Array<{ trigger: string; agendaItemId?: number }> | undefined) ?? []).some((e) => e.trigger === 'agenda_changed' && e.agendaItemId === itemId));
      if (j) return j;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }
  async function opDocument(compte: AccountRow, p: { status: string; planned?: string | null; realized?: string | null; assetId: number; fileId: number; label: string }) {
    const { withBusinessOperationWrite } = await ecriture();
    return (await withBusinessOperationWrite(compte.id, (repo) => repo.create({
      type: { code: 'INTERVENTION' }, status: p.status as never, plannedDate: p.planned ?? null, realizedDate: p.realized ?? null,
      technicalLabel: p.label, provider: 'Chauffage SA',
      source: { kind: 'DOCUMENT', entityKey: p.fileId, role: p.status === 'REALIZED' ? 'INVOICE' : 'QUOTE', authority: 'DOCUMENT', confidence: 'certain' },
      assets: [{ assetId: p.assetId, role: 'PRIMARY', authority: 'DOCUMENT' }], reasonCode: 'E2E',
    }))).id;
  }

  // ══ Création depuis l'agenda (TRG-012, C5) ═════════════════════════════════

  it('F-021 / TRG-012 — « remplacement chaudière prévu » saisi → INTERVENTION ENVISAGED (source AGENDA, USER), élément relié ; projection : aucun second événement ; rejoué : no-op', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    const { createAgendaItem } = await agendaWrite();
    const prevu = plus(39);
    const evt = await createAgendaItem({ title: 'Remplacement chaudière prévu le 20/11', startDate: prevu, assetIds: [maison.id], homeCategory: 'action' }, compte.id, compte.ownerUserId);
    // Le geste de l'utilisateur demande T3 (déclencheur Agenda, corrélation).
    const job = await attendreJobAgenda(compte, evt.id);
    expect(job).not.toBeNull();
    const [r] = await t3(compte, [evt.id]);
    expect(r).toMatchObject({ outcome: 'CREATE_NEW' });
    const [op, ...autres] = await ops(compte);
    expect(autres).toEqual([]);
    expect(op).toMatchObject({ type_code: 'INTERVENTION', status: 'ENVISAGED', planned_date: prevu, realized_date: null, invalidated: false });
    expect(await sourcesAgenda(op.id)).toEqual([{ entity: String(evt.id), active: true, authority: 'USER' }]);
    expect((await items(compte))[0]).toMatchObject({ id: evt.id, op: op.id, projection_origin: null });
    // Projection : l'élément de l'utilisateur représente déjà l'Opération (C16.1).
    expect(await projeter(compte, [op.id])).toMatchObject({ created: 0, changes: 0 });
    expect(await items(compte)).toHaveLength(1);
    // Idempotence (NFR-OP-004) : second passage sans écriture.
    const [r2] = await t3(compte, [evt.id]);
    expect(r2).toMatchObject({ outcome: 'LINKED', changes: 0 });
  });

  it('F-020 — rappel « penser à vérifier chaudière » : aucun déclencheur, aucune Opération ; échéance pure non plus', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    const { createAgendaItem } = await agendaWrite();
    const rappel = await createAgendaItem({ title: 'Penser à vérifier chaudière', startDate: plus(10), assetIds: [maison.id], homeCategory: 'action' }, compte.id, compte.ownerUserId);
    const echeance = await createAgendaItem({ title: 'Contrôle technique avant le 12/05', startDate: plus(12), assetIds: [maison.id], homeCategory: 'action' }, compte.id, compte.ownerUserId);
    await new Promise((r) => setTimeout(r, 200));
    expect((await jobsT3(compte)).filter((j) => j.target_type === 'business_operations')).toEqual([]);
    const res = await t3(compte, [rappel.id, echeance.id]);
    expect(res.map((x) => x.reason)).toEqual(['REMINDER', 'DEADLINE']);
    expect(await ops(compte)).toEqual([]);
  });

  it('F-022 — « vidange faite aujourd\'hui » → INTERVENTION REALIZED datée du jour', async () => {
    const compte = await make.account({ plan: 'premium' });
    const clio = await make.asset(compte, { category: 'VEHICULE' });
    const { createAgendaItem } = await agendaWrite();
    const evt = await createAgendaItem({ title: 'Vidange faite aujourd’hui', startDate: AUJOURDHUI, assetIds: [clio.id], homeCategory: 'information' }, compte.id, compte.ownerUserId);
    await t3(compte, [evt.id]);
    expect(await ops(compte)).toEqual([expect.objectContaining({ type_code: 'INTERVENTION', status: 'REALIZED', realized_date: AUJOURDHUI })]);
  });

  it('C16.1 / C7.2 — élément saisi pour une intervention déjà prouvée (devis, même bien, ±3 j) : RATTACHÉ, aucune nouvelle Opération ; la projection en double est retirée', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    const devis = await make.assetFile(compte, { assetId: maison.id });
    const opId = await opDocument(compte, { status: 'ENVISAGED', planned: plus(20), assetId: maison.id, fileId: devis.id, label: 'Remplacement chaudière' });
    await projeter(compte, [opId]);
    expect(await items(compte)).toEqual([expect.objectContaining({ op: opId, projection_origin: 'OPERATION' })]);
    const { createAgendaItem } = await agendaWrite();
    const evt = await createAgendaItem({ title: 'Remplacement de la chaudière', startDate: plus(21), assetIds: [maison.id], homeCategory: 'action' }, compte.id, compte.ownerUserId);
    const [r] = await t3(compte, [evt.id]);
    expect(r).toMatchObject({ outcome: 'MATCH_AND_ENRICH', operationId: opId });
    expect((await ops(compte)).map((o) => o.id)).toEqual([opId]);
    // La saisie de l'utilisateur prime pour la date prévue (C19).
    expect((await ops(compte))[0].planned_date).toBe(plus(21));
    await projeter(compte, [opId]);
    expect(await items(compte)).toEqual([expect.objectContaining({ id: evt.id, op: opId, projection_origin: null })]);
    expect((await projeter(compte, [opId])).changes).toBe(0);
  });

  // ══ Événement projeté modifié par l'utilisateur (TRG-013, C19) ═════════════

  it('TRG-013 / C19 — événement PROJETÉ dont l\'utilisateur corrige la date : source AGENDA de la MÊME Opération (aucune nouvelle), date corrigée ; projection : rien de réécrit', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    const devis = await make.assetFile(compte, { assetId: maison.id });
    const opId = await opDocument(compte, { status: 'ENVISAGED', planned: plus(20), assetId: maison.id, fileId: devis.id, label: 'Ramonage' });
    await projeter(compte, [opId]);
    const [evt] = await items(compte);
    const { updateAgendaItem } = await agendaWrite();
    await updateAgendaItem(evt.id, { startDate: plus(25) }, compte.id);
    expect(await attendreJobAgenda(compte, evt.id)).not.toBeNull();
    const [r] = await t3(compte, [evt.id]);
    expect(r).toMatchObject({ outcome: 'LINKED', operationId: opId });
    expect(await ops(compte)).toEqual([expect.objectContaining({ id: opId, status: 'ENVISAGED', planned_date: plus(25) })]);
    expect((await sourcesAgenda(opId))).toEqual([{ entity: String(evt.id), active: true, authority: 'USER' }]);
    expect(await projeter(compte, [opId])).toMatchObject({ changes: 0 });
    expect(await items(compte)).toEqual([expect.objectContaining({ id: evt.id, start_date: plus(25), projection_origin: 'OPERATION' })]);
  });

  it('C8 / C16-21 — « réalisé » posé par l\'utilisateur sur l\'événement relié → ENVISAGED → REALIZED, historisé ; anti-boucle : la projection ne repousse rien et n\'émet aucun T3', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    const devis = await make.assetFile(compte, { assetId: maison.id });
    const prevu = plus(-5);
    const opId = await opDocument(compte, { status: 'ENVISAGED', planned: prevu, assetId: maison.id, fileId: devis.id, label: 'Élagage' });
    await projeter(compte, [opId]);
    const [evt] = await items(compte);
    const { updateManualStatus } = await agendaWrite();
    await updateManualStatus(evt.id, 'realise', compte.id);
    expect(await attendreJobAgenda(compte, evt.id)).not.toBeNull();
    await t3(compte, [evt.id]);
    expect(await ops(compte)).toEqual([expect.objectContaining({ id: opId, status: 'REALIZED', planned_date: prevu, realized_date: prevu })]);
    expect((await historique(opId)).some((h) => h.event_type === 'STATUS_CHANGED')).toBe(true);
    // Anti-boucle (C16.2) : la projection qui suit ne réécrit pas l'élément touché, ne crée rien, ne demande pas T3.
    const avant = (await jobsT3(compte)).filter((j) => j.target_type === 'business_operations').length;
    expect(await projeter(compte, [opId])).toMatchObject({ changes: 0, created: 0 });
    await new Promise((r) => setTimeout(r, 200));
    expect((await jobsT3(compte)).filter((j) => j.target_type === 'business_operations').length).toBe(avant);
    expect(await items(compte)).toEqual([expect.objectContaining({ id: evt.id, manual_status: 'realise' })]);
    // T3 rejoué : rien ne bouge (aucune boucle).
    expect((await t3(compte, [evt.id]))[0].changes).toBe(0);
  });

  it('C8 — « annulé » sur une intervention établie par l\'agenda seul → CANCELLED (historisé) ; aucune projection contraire', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    const { createAgendaItem, updateManualStatus } = await agendaWrite();
    const evt = await createAgendaItem({ title: 'Ramonage', startDate: plus(15), assetIds: [maison.id], homeCategory: 'action' }, compte.id, compte.ownerUserId);
    await t3(compte, [evt.id]);
    const [op] = await ops(compte);
    await updateManualStatus(evt.id, 'annule', compte.id);
    await t3(compte, [evt.id]);
    expect(await ops(compte)).toEqual([expect.objectContaining({ id: op.id, status: 'CANCELLED', invalidated: false })]);
    expect((await historique(op.id)).filter((h) => h.event_type === 'STATUS_CHANGED').map((h) => h.after)).toEqual([{ status: 'CANCELLED' }]);
    expect(await projeter(compte, [op.id])).toMatchObject({ created: 0, changes: 0 });
    expect(await items(compte)).toHaveLength(1);
  });

  it('F-087 / TRG-014 — « annulé » posé sur l\'événement PROJETÉ d\'un devis : jamais une annulation métier ; la source Agenda est retirée, l\'Opération reste prévue', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    const devis = await make.assetFile(compte, { assetId: maison.id });
    const opId = await opDocument(compte, { status: 'ENVISAGED', planned: plus(20), assetId: maison.id, fileId: devis.id, label: 'Remplacement fenêtres' });
    await projeter(compte, [opId]);
    const [evt] = await items(compte);
    const { updateAgendaItem, updateManualStatus } = await agendaWrite();
    await updateAgendaItem(evt.id, { startDate: plus(22) }, compte.id);
    await t3(compte, [evt.id]);
    expect(await sourcesAgenda(opId)).toEqual([expect.objectContaining({ active: true })]);
    await updateManualStatus(evt.id, 'annule', compte.id);
    await t3(compte, [evt.id]);
    expect(await ops(compte)).toEqual([expect.objectContaining({ id: opId, status: 'ENVISAGED', invalidated: false })]);
    expect(await sourcesAgenda(opId)).toEqual([expect.objectContaining({ active: false })]);
    expect((await historique(opId)).some((h) => h.reason_code === 'AGENDA_CANCELLED_OTHER_PROOF')).toBe(true);
    // Aucune projection recréée à côté de l'élément annulé (lié).
    expect(await projeter(compte, [opId])).toMatchObject({ created: 0 });
    expect(await items(compte)).toHaveLength(1);
  });

  // ══ Garde anti-blanchiment (C2, C16.2) ═════════════════════════════════════

  it('O7b-E01 / C2 — projection intacte, T4 intact, T4 marqué réalisé par le système : JAMAIS source', async () => {
    const compte = await make.account({ plan: 'premium' });
    const clio = await make.asset(compte, { category: 'VEHICULE' });
    const f = await make.assetFile(compte, { assetId: clio.id });
    const prevue = await opDocument(compte, { status: 'ENVISAGED', planned: plus(10), assetId: clio.id, fileId: f.id, label: 'Révision' });
    await projeter(compte, [prevue]);
    const { upsertAgendaItem } = await import('@/services/agenda/agenda-write-primitive');
    const f2 = await make.assetFile(compte, { assetId: clio.id });
    const t4 = await upsertAgendaItem({
      accountId: compte.id, assetId: clio.id, origin: 'AUTOMATIC', title: 'Vidange', date: '2026-03-08', nature: 'DEADLINE', businessType: 'maintenance',
      category: 'action', sources: [{ fileId: f2.id, role: 'SOURCE' }], occurrenceIndex: 'single',
    });
    const realisee = await opDocument(compte, { status: 'REALIZED', realized: '2026-03-10', assetId: clio.id, fileId: f2.id, label: 'Vidange' });
    // La projection lie l'échéance T4 intacte et la marque réalisée (STATUS_AUTO_COMPLETED).
    expect(await projeter(compte, [realisee])).toMatchObject({ linked: 1, markedDone: 1 });
    const tous = await items(compte);
    const res = await t3(compte, tous.map((i) => i.id));
    expect(res.every((x) => x.outcome === 'NONE' && x.changes === 0)).toBe(true);
    expect(res.find((x) => x.itemId === t4.id)?.reason).toBe('NOT_USER_AUTHORED');
    expect(await sql`SELECT id FROM business_operation_sources WHERE account_id = ${compte.id} AND source_kind = 'AGENDA'`).toEqual([]);
    expect((await ops(compte)).map((o) => o.id).sort()).toEqual([prevue, realisee].sort());
  });

  // ══ Suppression (TRG-014, F-085, F-086) ════════════════════════════════════

  it('F-086 — suppression de l\'élément source UNIQUE d\'une intervention prévue : source retirée, Opération invalidée ; suppression mémorisée', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    const { createAgendaItem, deleteAgendaItem } = await agendaWrite();
    const evt = await createAgendaItem({ title: 'Travaux de toiture', startDate: plus(30), assetIds: [maison.id], homeCategory: 'action' }, compte.id, compte.ownerUserId);
    await t3(compte, [evt.id]);
    const [op] = await ops(compte);
    await deleteAgendaItem(evt.id, compte.id, compte.ownerUserId);
    expect(await attendreJobAgenda(compte, evt.id)).not.toBeNull();
    const [r] = await t3(compte, [evt.id]);
    expect(r).toMatchObject({ outcome: 'WITHDRAWN', reason: 'ITEM_GONE' });
    expect(await ops(compte)).toEqual([expect.objectContaining({ id: op.id, invalidated: true })]);
    expect(await sourcesAgenda(op.id)).toEqual([expect.objectContaining({ active: false })]);
    expect(await sql`SELECT projection_key FROM business_operation_projection_suppressions WHERE operation_id = ${op.id}`).toEqual([{ projection_key: 'INTERVENTION' }]);
  });

  it('F-085 — suppression d\'un événement projeté (corrigé puis supprimé) : source retirée, Opération intacte, suppression de projection durable', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    const devis = await make.assetFile(compte, { assetId: maison.id });
    const opId = await opDocument(compte, { status: 'ENVISAGED', planned: plus(20), assetId: maison.id, fileId: devis.id, label: 'Isolation combles' });
    await projeter(compte, [opId]);
    const [evt] = await items(compte);
    const { updateAgendaItem, deleteAgendaItem } = await agendaWrite();
    await updateAgendaItem(evt.id, { title: 'Isolation des combles (artisan)' }, compte.id);
    await t3(compte, [evt.id]);
    await deleteAgendaItem(evt.id, compte.id, compte.ownerUserId);
    await t3(compte, [evt.id]);
    expect(await ops(compte)).toEqual([expect.objectContaining({ id: opId, status: 'ENVISAGED', invalidated: false })]);
    expect(await sourcesAgenda(opId)).toEqual([expect.objectContaining({ active: false })]);
    expect(await projeter(compte, [opId])).toMatchObject({ suppressed: 1, created: 0 });
    expect(await items(compte)).toEqual([]);
  });

  it('TRG-020 — filet horaire : un élément source supprimé sans déclencheur est rattrapé par le balayage (état, pas événement)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    const { createAgendaItem } = await agendaWrite();
    const evt = await createAgendaItem({ title: 'Entretien chaudière', startDate: plus(40), assetIds: [maison.id], homeCategory: 'action' }, compte.id, compte.ownerUserId);
    await t3(compte, [evt.id]);
    const [op] = await ops(compte);
    await sql`DELETE FROM agenda_asset_links WHERE agenda_item_id = ${evt.id}`;
    await sql`DELETE FROM agenda_items WHERE id = ${evt.id}`;
    const { listAccountsToConsolidate, consolidateAccountOperations } = await import('@/services/business-operations/consolidation/consolidator');
    expect(await listAccountsToConsolidate(compte.id - 1, 1000)).toContain(compte.id);
    const r = await consolidateAccountOperations(compte.id, { today: AUJOURDHUI, operationMatch: false });
    expect(r.agendaItems).toBe(1);
    expect(await ops(compte)).toEqual([expect.objectContaining({ id: op.id, invalidated: true })]);
    expect(await listAccountsToConsolidate(compte.id - 1, 1000)).not.toContain(compte.id);
  });

  // ══ Point 2 : historique passé affiché réalisé, sans écriture ═════════════

  it('O7b-H10 — historique passé : « réalisé » (agenda, recherche, fiche, suivi, assistant) ; échéance passée : « en retard » ; AUCUN statut écrit', async () => {
    const compte = await make.account({ plan: 'premium' });
    const clio = await make.asset(compte, { category: 'VEHICULE' });
    session.currentAccountId = compte.id;
    session.userId = compte.ownerUserId;
    const f = await make.assetFile(compte, { assetId: clio.id });
    const { upsertAgendaItem } = await import('@/services/agenda/agenda-write-primitive');
    const hist = await upsertAgendaItem({
      accountId: compte.id, assetId: clio.id, origin: 'AUTOMATIC', title: 'Achat Clio', date: '2024-05-01', nature: 'HISTORICAL', businessType: 'purchase',
      category: 'information', sources: [{ fileId: f.id, role: 'SOURCE' }], occurrenceIndex: 'single',
    });
    const echeance = await upsertAgendaItem({
      accountId: compte.id, assetId: clio.id, origin: 'AUTOMATIC', title: 'Révision', date: plus(-20), nature: 'DEADLINE', businessType: 'maintenance',
      category: 'action', sources: [{ fileId: f.id, role: 'SOURCE' }], occurrenceIndex: 'single',
    });
    const { getAgendaItems, getAgendaItemById, searchAgendaItems, getHomepageAgendaItems } = await import('@/services/agenda/AgendaQueryService');
    const parId = new Map((await getAgendaItems({ accountId: compte.id, includeUndated: true })).map((i) => [i.id, i]));
    expect(parId.get(hist.id)).toMatchObject({ effectiveStatus: 'realise', manualStatus: null });
    expect(parId.get(hist.id)!.attentionFlags).not.toContain('en_retard');
    expect(parId.get(echeance.id)).toMatchObject({ effectiveStatus: 'en_retard' });
    expect((await getAgendaItemById(hist.id, compte.id))!.effectiveStatus).toBe('realise');
    expect((await searchAgendaItems('Achat', compte.id)).find((x) => x.id === hist.id)?.effectiveStatus).toBe('realise');
    const accueil = (await getHomepageAgendaItems(compte.id)).map((i) => i.id);
    expect(accueil).not.toContain(hist.id);
    expect(accueil).toContain(echeance.id);

    // Fiche du bien (vue d'ensemble, suivi) et assistant.
    const overview = await import('@/app/api/assets/[id]/overview/route');
    const o = await overview.GET(new NextRequest(`http://x/api/assets/${clio.id}/overview`), { params: Promise.resolve({ id: String(clio.id) }) });
    const timeline = ((await o.json()) as { timeline: Array<{ id: string; isDone: boolean; isOverdue: boolean }> }).timeline;
    expect(timeline.find((t) => t.id === String(hist.id))).toMatchObject({ isDone: true, isOverdue: false });
    expect(timeline.find((t) => t.id === String(echeance.id))).toMatchObject({ isDone: false, isOverdue: true });
    const followup = await import('@/app/api/assets/[id]/followup/route');
    const fr = await followup.GET(new NextRequest(`http://x/api/assets/${clio.id}/followup?includeDone=true`), { params: Promise.resolve({ id: String(clio.id) }) });
    const suivi = ((await fr.json()) as { items: Array<{ id: string; effectiveStatus: string; isOverdue: boolean }> }).items;
    expect(suivi.find((t) => t.id === String(hist.id))).toMatchObject({ effectiveStatus: 'realise', isOverdue: false });
    expect(suivi.find((t) => t.id === String(echeance.id))).toMatchObject({ effectiveStatus: 'en_retard', isOverdue: true });
    const { getCanonicalAgendaItem } = await import('@/services/verebona-assistant/canonical/agenda');
    expect(await getCanonicalAgendaItem(compte.id, hist.id)).toMatchObject({ status: 'completed', overdue: false });
    expect(await getCanonicalAgendaItem(compte.id, echeance.id)).toMatchObject({ status: 'not_proven', overdue: true });
    const { listActiveDeadlines } = await import('@/services/verebona-assistant/canonical/actionables');
    const actives = (await listActiveDeadlines(compte.id, { from: null, to: null })).map((d) => d.id);
    expect(actives).not.toContain(hist.id);
    expect(actives).toContain(echeance.id);

    // Aucune écriture : le statut en base reste nul.
    expect(await sql`SELECT manual_status FROM agenda_items WHERE id = ${hist.id}`).toEqual([{ manual_status: null }]);
  });
});
