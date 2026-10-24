/**
 * Lot 86D — ticket P1 « Documents / Agenda — associations erronées et gestion
 * bidirectionnelle » — PostgreSQL 16 réel.
 *
 * Chaînes de PRODUCTION : routes des tiroirs (`/api/agenda/:id/liens`,
 * `/api/documents/:id/agenda-liens` GET / POST / DELETE, `/api/agenda?fileId`),
 * service unique de regroupement (`withGroupingWrite`), primitive d'écriture
 * d'agenda (T4 et agenda manuel), projection T4 (`projectAccountOperations`),
 * campagne de cohérence (orchestrateur réel, mode à blanc puis correctif).
 * Garde d'écriture RÉELLE. Aucun appel IA. Date de référence injectée.
 * Assertions limitées aux comptes créés ici.
 *
 *   L86D-E2E-01  depuis l'élément : ajouter, consulter, ouvrir (lecture du document), détacher un document — rien d'autre ne bouge ; idempotent
 *   L86D-E2E-02  depuis le document : consulter, détacher, re-relier (le rattachement manuel lève le détachement) ; deux interfaces synchronisées
 *   L86D-E2E-03  détachement mémorisé : jamais recréé par T4 (rejeu), ni par la propagation vers l'événement de référence, ni par la projection, ni par la cohérence
 *   L86D-E2E-04  cause racine : une association retirée ne reste plus visible par sa trace de production (agenda et document)
 *   L86D-E2E-05  contrôle : lien automatique démontré injustifié (stock) — à blanc sans écriture, retiré en correctif, recontrôlé ; le reste intact ; idempotent
 *   L86D-E2E-06  lien manuel jamais retiré automatiquement (même sans aucune preuve)
 *   L86D-E2E-07  lien automatique sans preuve propre : constat AMBIGUOUS qualifié, aucune écriture, contrat IA nommé
 *   L86D-E2E-08  isolation de compte : lecture et détachement refusés (404), rien n'est écrit
 *   L86D-E2E-09  compte en lecture seule : détachement refusé (403) des deux côtés, rien n'est écrit ; lecture permise
 */
import { afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import type { AccountRow, AssetRow } from '../factories';

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

type Json = Record<string, any>;
type Compte = AccountRow & { owner: { id: number } };
const AUJ = '2026-10-23';
const CHECK = 'COH-DOC-AGENDA-LINKS';

scenario('L86D', 'Documents / Agenda — associations : gestion bidirectionnelle, détachement mémorisé, contrôle par les preuves', ({ sql, make }) => {
  afterEach(async () => {
    (await import('@/services/business-operations/events')).resetBusinessOperationEventBusForTests();
  });

  const as = (c: Compte) => { session.userId = c.owner.id; session.currentAccountId = c.id; };
  async function contexte(plan: 'premium' | null = 'premium'): Promise<{ compte: Compte; maison: AssetRow }> {
    const compte = await make.account({ plan }) as Compte;
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    as(compte);
    return { compte, maison };
  }

  // ── Routes réelles ────────────────────────────────────────────────────────
  const json = (body: unknown) => ({ body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  async function vue(itemId: number) {
    const { GET } = await import('@/app/api/agenda/[id]/liens/route');
    const res = await GET(new NextRequest(`http://localhost/api/agenda/${itemId}/liens`), { params: Promise.resolve({ id: String(itemId) }) });
    return { status: res.status, body: await res.json() as Json };
  }
  async function geste(itemId: number, action: string, targetId?: number) {
    const { POST } = await import('@/app/api/agenda/[id]/liens/route');
    const res = await POST(new NextRequest(`http://localhost/api/agenda/${itemId}/liens`, { method: 'POST', ...json({ action, targetId: targetId ?? null }) }),
      { params: Promise.resolve({ id: String(itemId) }) });
    return { status: res.status, body: await res.json() as Json };
  }
  async function liensDocument(fileId: number, method: 'GET' | 'POST' | 'DELETE' = 'GET', itemId?: number) {
    const route = await import('@/app/api/documents/[id]/agenda-liens/route');
    const url = `http://localhost/api/documents/${fileId}/agenda-liens${method === 'DELETE' ? `?itemId=${itemId}` : ''}`;
    const req = method === 'POST' ? new NextRequest(url, { method, ...json({ itemId }) }) : new NextRequest(url, { method });
    const fn = method === 'GET' ? route.GET : method === 'POST' ? route.POST : route.DELETE;
    const res = await fn(req, { params: Promise.resolve({ id: String(fileId) }) });
    return { status: res.status, body: await res.json() as Json };
  }
  /** Éléments affichés dans le tiroir du document (`/api/agenda?fileId`, AgendaQueryService). */
  async function elementsDuDocument(fileId: number): Promise<number[]> {
    const { GET } = await import('@/app/api/agenda/route');
    const res = await GET(new NextRequest(`http://localhost/api/agenda?fileId=${fileId}&period=all&includeCancelled=false`));
    return ((await res.json() as Json).items ?? []).map((i: Json) => i.id).sort((a: number, b: number) => a - b);
  }
  /** Documents affichés dans le tiroir de l'élément (`fileLinks`, AgendaQueryService). */
  async function documentsDeLElement(itemId: number): Promise<number[]> {
    const { getAgendaItemById } = await import('@/services/agenda/AgendaQueryService');
    const it = await getAgendaItemById(itemId, session.currentAccountId!);
    return (it?.fileLinks ?? []).map((l) => l.assetFileId).sort((a, b) => a - b);
  }

  // ── Lectures ──────────────────────────────────────────────────────────────
  const element = async (id: number) => (await sql<Json[]>`SELECT id, business_operation_id::int AS op, operation_role AS role FROM agenda_items WHERE id = ${id}`)[0];
  const liensDe = (itemId: number) => sql<{ file: number; prov: string[] }[]>`
    SELECT asset_file_id AS file, provenances AS prov FROM agenda_file_links WHERE agenda_item_id = ${itemId} ORDER BY asset_file_id`;
  const membres = (opId: number) => sql<{ file_id: number }[]>`SELECT file_id FROM business_operation_documents WHERE operation_id = ${opId} AND active ORDER BY file_id`;
  const decisionsLien = (compte: AccountRow) => sql<Json[]>`
    SELECT source_entity_key AS key, candidate_operation_id AS op, decision, active FROM business_operation_match_decisions
     WHERE account_id = ${compte.id} AND source_kind = 'AGENDA_FILE_LINK' ORDER BY id`;
  const existe = async (table: 'asset_files' | 'agenda_items', id: number) => (await sql`SELECT 1 FROM ${sql(table)} WHERE id = ${id}`).length === 1;
  const empreinte = async (compte: AccountRow) => ({
    items: await sql`SELECT id, business_operation_id, operation_role, updated_at FROM agenda_items WHERE account_id = ${compte.id} ORDER BY id`,
    liens: await sql`SELECT l.agenda_item_id, l.asset_file_id, l.provenances FROM agenda_file_links l JOIN agenda_items i ON i.id = l.agenda_item_id WHERE i.account_id = ${compte.id} ORDER BY 1, 2`,
    docs: await sql`SELECT operation_id, file_id, origins, active FROM business_operation_documents WHERE account_id = ${compte.id} ORDER BY 1, 2`,
    decisions: await sql`SELECT id, source_kind, decision, active FROM business_operation_match_decisions WHERE account_id = ${compte.id} ORDER BY id`,
    fichiers: await sql`SELECT id, deleted_at FROM asset_files WHERE account_id = ${compte.id} ORDER BY id`,
  });

  // ── Fabrique : Opération avec principal projeté (T4) ──────────────────────
  async function ensembleAvecReference(compte: AccountRow, maison: AssetRow, fileIds: number[]): Promise<{ op: number; principal: number }> {
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    const op = (await withBusinessOperationWrite(compte.id, (repo) => repo.create({
      type: { code: 'CLAIM' }, status: 'REALIZED', realizedDate: '2026-03-12', technicalLabel: 'Dégât des eaux',
      source: { kind: 'DOCUMENT', entityKey: fileIds[0], authority: 'DOCUMENT', confidence: 'certain' },
      assets: [{ assetId: maison.id, role: 'PRIMARY', authority: 'DOCUMENT' }], reasonCode: 'E2E',
    }))).id;
    for (const f of fileIds.slice(1)) {
      await withBusinessOperationWrite(compte.id, (repo) => repo.addSource(op, { kind: 'DOCUMENT', entityKey: f, authority: 'DOCUMENT' }));
    }
    const { projectAccountOperations } = await import('@/services/business-operations/agenda-projection/service');
    await projectAccountOperations(compte.id, { operationIds: [op], correlationId: 'l86d', today: AUJ });
    const [p] = await sql<{ id: number }[]>`SELECT id FROM agenda_items WHERE business_operation_id = ${op} AND operation_role = 'PRINCIPAL'`;
    return { op, principal: p.id };
  }
  /** Élément automatique produit par T4 depuis un document (lien AI_DIRECT + trace de production). */
  async function elementT4(compte: AccountRow, maison: AssetRow, fileId: number, title = 'Contrôle chaudière') {
    const { upsertAgendaItem } = await import('@/services/agenda/agenda-write-primitive');
    const entree = {
      accountId: compte.id, assetId: maison.id, origin: 'AUTOMATIC' as const, category: 'action' as const, date: '2027-03-15', title,
      originFieldKey: 'maintenanceDueDate', sources: [{ fileId, role: 'SOURCE' as const }], occurrenceIndex: 'single',
    };
    const r = await upsertAgendaItem(entree);
    return { id: r.id, rejouer: () => upsertAgendaItem(entree) };
  }

  async function campagne(scope: number[], mode: 'DRY_RUN' | 'CORRECTIVE') {
    const o = await import('@/services/coherence/orchestrator');
    const id = await o.startCampaign({ kind: 'MANUAL', trigger: 'e2e-l86d', mode, scopeAccountIds: scope, now: new Date(`${AUJ}T10:00:00Z`) });
    for (let i = 0; i < 40; i++) {
      const r = await o.runCampaignStep(id, { deadline: Date.now() + 120_000, today: AUJ, now: new Date(`${AUJ}T10:00:00Z`) });
      if (r.done) break;
    }
    return (await o.getCampaign(id))!;
  }
  const preuve = async (accountId: number, linkId: number) => (await sql<Json[]>`
    SELECT last_result, finding FROM coherence_object_proofs WHERE account_id = ${accountId} AND check_id = ${CHECK} AND object_id = ${linkId}`)[0];
  const reparations = (accountId: number) => sql<Json[]>`
    SELECT object_id::int AS object_id, service, outcome, ai_calls, result FROM coherence_repairs WHERE account_id = ${accountId} AND check_id = ${CHECK} ORDER BY id`;
  const idLien = async (itemId: number, fileId: number) => (await sql<{ id: number }[]>`SELECT id FROM agenda_file_links WHERE agenda_item_id = ${itemId} AND asset_file_id = ${fileId}`)[0]?.id;

  // ══ 01 ═══════════════════════════════════════════════════════════════════

  it('L86D-E2E-01 — depuis l’élément : ajouter, consulter, ouvrir, détacher un document ; rien d’autre ne bouge ; idempotent', async () => {
    const c = await contexte();
    const devis = await make.assetFile(c.compte, { assetId: c.maison.id });
    const facture = await make.assetFile(c.compte, { assetId: c.maison.id });
    const visite = await make.agendaItem(c.compte, { title: 'Visite plombier', startDate: '2026-03-21', assetIds: [c.maison.id] });
    const autre = await make.agendaItem(c.compte, { title: 'Relance', startDate: '2026-04-02', assetIds: [c.maison.id] });

    // Ajouter (deux documents) — associations multiples, sans doublon.
    expect((await geste(visite.id, 'relier-document', devis.id)).status).toBe(200);
    expect((await geste(visite.id, 'relier-document', facture.id)).status).toBe(200);
    expect((await geste(visite.id, 'relier-document', facture.id)).status).toBe(200);
    expect((await geste(autre.id, 'relier-document', devis.id)).status).toBe(200);
    expect(await liensDe(visite.id)).toEqual([{ file: devis.id, prov: ['MANUAL_DIRECT'] }, { file: facture.id, prov: ['MANUAL_DIRECT'] }]);
    const op = (await element(visite.id)).op as number;

    // Consulter : la vue du tiroir porte les documents de l'élément ; ouvrir = le document est lisible côté document.
    const v = await vue(visite.id);
    expect(v.status).toBe(200);
    expect(v.body.view.linkedDocuments.map((d: Json) => d.id).sort()).toEqual([devis.id, facture.id].sort());
    expect((await liensDocument(devis.id)).body.links.map((l: Json) => l.itemId).sort()).toEqual([visite.id, autre.id].sort());

    // Détacher le devis de la visite.
    const r = await geste(visite.id, 'detacher-document', devis.id);
    expect(r.status).toBe(200);
    expect(r.body.changed).toBe(true);
    expect(r.body.view.linkedDocuments.map((d: Json) => d.id)).toEqual([facture.id]);
    expect(await liensDe(visite.id)).toEqual([{ file: facture.id, prov: ['MANUAL_DIRECT'] }]);
    // Rien d'autre : document, élément, appartenance à l'ensemble, lien du devis avec l'autre élément.
    expect(await existe('asset_files', devis.id)).toBe(true);
    expect(await existe('agenda_items', visite.id)).toBe(true);
    expect((await membres(op)).map((m) => m.file_id)).toContain(devis.id);
    expect(await liensDe(autre.id)).toEqual([{ file: devis.id, prov: ['MANUAL_DIRECT'] }]);
    expect(await element(visite.id)).toMatchObject({ op });
    // Décision mémorisée sur le LIEN (sans Opération).
    expect(await decisionsLien(c.compte)).toContainEqual({ key: `${visite.id}:${devis.id}`, op: null, decision: 'REJECTED', active: true });
    // Côté document : synchronisé.
    expect((await liensDocument(devis.id)).body.links.map((l: Json) => l.itemId)).toEqual([autre.id]);
    expect(await elementsDuDocument(devis.id)).toEqual([autre.id]);

    // Idempotent : rejoué, rien n'est écrit.
    const avant = await empreinte(c.compte);
    const r2 = await geste(visite.id, 'detacher-document', devis.id);
    expect(r2).toMatchObject({ status: 200, body: { changed: false } });
    expect(await empreinte(c.compte)).toEqual(avant);
  });

  // ══ 02 ═══════════════════════════════════════════════════════════════════

  it('L86D-E2E-02 — depuis le document : consulter, détacher, re-relier ; les deux interfaces synchronisées', async () => {
    const c = await contexte();
    const rapport = await make.assetFile(c.compte, { assetId: c.maison.id });
    const a = await make.agendaItem(c.compte, { title: 'Expertise', startDate: '2026-03-21' });
    const b = await make.agendaItem(c.compte, { title: 'Réparation', startDate: '2026-04-18' });
    expect((await liensDocument(rapport.id, 'POST', a.id)).status).toBe(200);
    expect((await liensDocument(rapport.id, 'POST', b.id)).status).toBe(200);
    expect(await elementsDuDocument(rapport.id)).toEqual([a.id, b.id].sort((x, y) => x - y));

    const d = await liensDocument(rapport.id, 'DELETE', a.id);
    expect(d.status).toBe(200);
    expect(d.body.changed).toBe(true);
    expect(d.body.links.map((l: Json) => l.itemId)).toEqual([b.id]);
    // Tiroir de l'élément (même données, relu) : le document n'y figure plus ; l'autre élément le garde.
    expect((await vue(a.id)).body.view.linkedDocuments).toEqual([]);
    expect((await vue(b.id)).body.view.linkedDocuments.map((x: Json) => x.id)).toEqual([rapport.id]);
    expect(await documentsDeLElement(a.id)).toEqual([]);
    expect(await existe('asset_files', rapport.id)).toBe(true);
    expect(await existe('agenda_items', a.id)).toBe(true);

    // Re-relier : le rattachement manuel lève le détachement (désactivé, jamais effacé).
    expect((await liensDocument(rapport.id, 'POST', a.id)).status).toBe(200);
    expect(await liensDe(a.id)).toEqual([{ file: rapport.id, prov: ['MANUAL_DIRECT'] }]);
    const ds = (await decisionsLien(c.compte)).filter((x) => x.key === `${a.id}:${rapport.id}`);
    expect(ds.map((x) => [x.decision, x.active])).toEqual([['CONFIRMED', false], ['REJECTED', false], ['CONFIRMED', true]]);
  });

  // ══ 03 ═══════════════════════════════════════════════════════════════════

  it('L86D-E2E-03 — détachement mémorisé : jamais recréé par T4, la propagation, la projection ni la cohérence', async () => {
    const c = await contexte();
    const constat = await make.assetFile(c.compte, { assetId: c.maison.id });
    const facture = await make.assetFile(c.compte, { assetId: c.maison.id });
    const { op, principal } = await ensembleAvecReference(c.compte, c.maison, [constat.id, facture.id]);
    expect((await liensDe(principal)).map((l) => [l.file, l.prov])).toEqual([[constat.id, ['OPERATION_PRINCIPAL']], [facture.id, ['OPERATION_PRINCIPAL']]]);

    // Lien PROPAGÉ détaché depuis le document : le document reste membre de l'ensemble.
    expect((await liensDocument(facture.id, 'DELETE', principal)).status).toBe(200);
    expect((await liensDe(principal)).map((l) => l.file)).toEqual([constat.id]);
    expect((await membres(op)).map((m) => m.file_id)).toEqual([constat.id, facture.id].sort((x, y) => x - y));

    // Lien T4 (AI_DIRECT + trace) détaché depuis l'élément.
    const ctrl = await elementT4(c.compte, c.maison, constat.id);
    expect(await liensDe(ctrl.id)).toEqual([{ file: constat.id, prov: ['AI_DIRECT'] }]);
    expect((await geste(ctrl.id, 'detacher-document', constat.id)).status).toBe(200);
    expect(await liensDe(ctrl.id)).toEqual([]);

    // Traitements automatiques ordinaires : T4 rejoué, propagation recalculée, projection rejouée, cohérence corrective.
    await ctrl.rejouer();
    const { withGroupingWrite, recomputePrincipal } = await import('@/services/business-operations/grouping/service');
    await withGroupingWrite(c.compte.id, (g) => recomputePrincipal(g, op));
    const { projectAccountOperations } = await import('@/services/business-operations/agenda-projection/service');
    await projectAccountOperations(c.compte.id, { operationIds: [op], correlationId: 'l86d-rejeu', today: AUJ });
    await campagne([c.compte.id], 'CORRECTIVE');
    expect(await liensDe(ctrl.id)).toEqual([]);
    expect((await liensDe(principal)).map((l) => l.file)).toEqual([constat.id]);
    // Invariant de propagation : aucun « lien manquant » sur un refus de l'utilisateur.
    const { OPERATIONS_GROUPING_INVARIANTS } = await import('@/services/business-operations/grouping/invariants');
    const { postgresRunner } = await import('@/services/business-operations/grouping/runner');
    const inv = OPERATIONS_GROUPING_INVARIANTS.find((i) => i.id === 'O1-PRINCIPAL-DOCUMENTS')!;
    expect(await inv.detect(postgresRunner(sql), c.compte.id)).toEqual([]);
    // Affichage : ni l'élément T4 ni l'événement de référence ne réapparaissent côté document.
    expect(await elementsDuDocument(facture.id)).toEqual([]);
    expect(await elementsDuDocument(constat.id)).toEqual([principal]);
  });

  // ══ 04 ═══════════════════════════════════════════════════════════════════

  it('L86D-E2E-04 — cause racine : une association retirée ne reste plus visible par sa trace de production', async () => {
    const c = await contexte();
    const doc = await make.assetFile(c.compte, { assetId: c.maison.id });
    const ctrl = await elementT4(c.compte, c.maison, doc.id, 'Ramonage');
    expect(await documentsDeLElement(ctrl.id)).toEqual([doc.id]);
    // L'utilisateur retire le document par le formulaire de l'élément (agenda manuel, état complet).
    const { updateAgendaItem } = await import('@/services/agenda/AgendaWriteService');
    await updateAgendaItem(ctrl.id, { fileIds: [] }, c.compte.id, c.compte.owner.id);
    expect(await liensDe(ctrl.id)).toEqual([]);
    // La trace de production existe toujours (historique) …
    expect((await sql`SELECT 1 FROM agenda_item_sources WHERE agenda_item_id = ${ctrl.id} AND asset_file_id = ${doc.id}`).length).toBe(1);
    // … mais n'est plus une association affichée (avant 86D : l'élément restait relié au document à l'écran).
    expect(await documentsDeLElement(ctrl.id)).toEqual([]);
    expect(await elementsDuDocument(doc.id)).toEqual([]);
    // Et le retrait est mémorisé : T4 rejoué ne le recrée pas.
    expect(await decisionsLien(c.compte)).toContainEqual({ key: `${ctrl.id}:${doc.id}`, op: null, decision: 'REJECTED', active: true });
    await ctrl.rejouer();
    expect(await liensDe(ctrl.id)).toEqual([]);
  });

  // ══ 05 ═══════════════════════════════════════════════════════════════════

  it('L86D-E2E-05 — contrôle : lien automatique démontré injustifié retiré (stock), recontrôlé ; le reste intact ; idempotent', async () => {
    const c = await contexte();
    const constat = await make.assetFile(c.compte, { assetId: c.maison.id });
    const etranger = await make.assetFile(c.compte, { assetId: c.maison.id });
    const { op, principal } = await ensembleAvecReference(c.compte, c.maison, [constat.id]);
    // Stock historique : copie de projection d'un document qui n'est PAS (plus) membre de l'ensemble, sans trace.
    await sql`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id, provenances) VALUES (${principal}, ${etranger.id}, ARRAY['AI_DIRECT']::text[])`;
    const lien = await idLien(principal, etranger.id);
    const lienJuste = await idLien(principal, constat.id);

    const avant = await empreinte(c.compte);
    await campagne([c.compte.id], 'DRY_RUN');
    expect(await preuve(c.compte.id, lien)).toMatchObject({ last_result: 'WOULD_REPAIR' });
    expect((await preuve(c.compte.id, lien)).finding).toMatchObject({ anomaly: 'AUTOMATIC_LINK_UNJUSTIFIED' });
    expect(await empreinte(c.compte)).toEqual(avant);

    await campagne([c.compte.id], 'CORRECTIVE');
    expect(await preuve(c.compte.id, lien)).toMatchObject({ last_result: 'REPAIRED' });
    const reps = await reparations(c.compte.id);
    expect(reps).toEqual([expect.objectContaining({ object_id: lien, service: 'withdrawAutomaticLinkProvenances', ai_calls: 0 })]);
    expect(reps[0].result).toMatchObject({ state: 'WITHDRAWN', removed: ['AI_DIRECT'], linkDeleted: true, unjustified: [{ provenance: 'AI_DIRECT', reason: 'PROJECTION_DOCUMENT_LEFT_ENSEMBLE' }] });
    // Correction journalisée avec sa justification dans l'historique de l'ensemble.
    const [h] = await sql<Json[]>`SELECT after_json FROM business_operation_history WHERE operation_id = ${op} AND reason_code = 'COHERENCE_AUTOMATIC_LINK_UNJUSTIFIED'`;
    expect(h.after_json).toMatchObject({ file_id: etranger.id, removed: ['AI_DIRECT'], evidence: { unjustified: [{ reason: 'PROJECTION_DOCUMENT_LEFT_ENSEMBLE' }] } });
    // Reste intact : documents, élément, lien justifié, appartenance.
    expect(await liensDe(principal)).toEqual([{ file: constat.id, prov: ['OPERATION_PRINCIPAL'] }]);
    expect(await idLien(principal, constat.id)).toBe(lienJuste);
    expect(await existe('asset_files', etranger.id)).toBe(true);
    expect(await element(principal)).toMatchObject({ op, role: 'PRINCIPAL' });
    expect((await membres(op)).map((m) => m.file_id)).toEqual([constat.id]);

    // Campagne suivante : aucune réapparition, aucune nouvelle réparation, aucune écriture.
    const apres = await empreinte(c.compte);
    await campagne([c.compte.id], 'CORRECTIVE');
    expect(await reparations(c.compte.id)).toHaveLength(1);
    expect(await empreinte(c.compte)).toEqual(apres);
  });

  // ══ 06 ═══════════════════════════════════════════════════════════════════

  it('L86D-E2E-06 — un lien posé par l’utilisateur n’est jamais retiré automatiquement, même sans aucune preuve', async () => {
    const c = await contexte();
    const doc = await make.assetFile(c.compte, { assetId: c.maison.id });
    const it1 = await make.agendaItem(c.compte, { title: 'Sans rapport apparent', startDate: '2026-01-05' });
    await sql`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id, provenances) VALUES (${it1.id}, ${doc.id}, ARRAY['MANUAL_DIRECT']::text[])`;
    const it2 = await make.agendaItem(c.compte, { title: 'Cumul', startDate: '2026-01-06' });
    await sql`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id, provenances) VALUES (${it2.id}, ${doc.id}, ARRAY['AI_DIRECT', 'MANUAL_DIRECT']::text[])`;
    await campagne([c.compte.id], 'CORRECTIVE');
    expect(await liensDe(it1.id)).toEqual([{ file: doc.id, prov: ['MANUAL_DIRECT'] }]);
    expect(await liensDe(it2.id)).toEqual([{ file: doc.id, prov: ['AI_DIRECT', 'MANUAL_DIRECT'] }]);
    expect(await reparations(c.compte.id)).toEqual([]);
    // Hors périmètre du contrôle (décision de l'utilisateur) : aucune preuve de contrôle n'est même ouverte.
    expect(await preuve(c.compte.id, await idLien(it1.id, doc.id))).toBeUndefined();
    // Le service refuse explicitement de retirer MANUAL_DIRECT.
    const { withGroupingWrite, withdrawAutomaticLinkProvenances } = await import('@/services/business-operations/grouping/service');
    await expect(withGroupingWrite(c.compte.id, (g) => withdrawAutomaticLinkProvenances(g, { itemId: it1.id, fileId: doc.id, provenances: ['MANUAL_DIRECT' as never], reasonCode: 'E2E' })))
      .rejects.toThrow(/MANUAL_LINK_PROTECTED/);
    expect(await liensDe(it1.id)).toEqual([{ file: doc.id, prov: ['MANUAL_DIRECT'] }]);
  });

  // ══ 07 ═══════════════════════════════════════════════════════════════════

  it('L86D-E2E-07 — lien automatique sans preuve propre : constat AMBIGUOUS qualifié, aucune écriture, contrat IA nommé ; idempotent', async () => {
    const c = await contexte();
    const doc = await make.assetFile(c.compte, { assetId: c.maison.id });
    const item = await make.agendaItem(c.compte, { title: 'Entretien', startDate: '2026-02-10', assetIds: [c.maison.id] });
    // Même bien, date proche — jamais une preuve ; lien hérité (reprise 0654) sans trace.
    await sql`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id, provenances) VALUES (${item.id}, ${doc.id}, ARRAY['AI_DIRECT']::text[])`;
    const lien = await idLien(item.id, doc.id);
    const avant = await empreinte(c.compte);
    await campagne([c.compte.id], 'CORRECTIVE');
    const p = await preuve(c.compte.id, lien);
    expect(p).toMatchObject({ last_result: 'AMBIGUOUS' });
    expect(p.finding).toMatchObject({ anomaly: 'AUTOMATIC_LINK_UNPROVEN', detail: { aiContract: '86D-t4-pertinence-lien-document-agenda', unproven: ['AI_DIRECT'] } });
    expect(await empreinte(c.compte)).toEqual(avant);
    expect(await reparations(c.compte.id)).toEqual([]);
    // Aucune carte « À traiter » ne sollicite l'utilisateur.
    expect((await sql`SELECT 1 FROM to_process_actions WHERE account_id = ${c.compte.id} AND resolved_at IS NULL`).length).toBe(0);
    await campagne([c.compte.id], 'CORRECTIVE');
    expect(await empreinte(c.compte)).toEqual(avant);
  });

  // ══ 08 ═══════════════════════════════════════════════════════════════════

  it('L86D-E2E-08 — isolation de compte : lecture et détachement refusés (404), rien n’est écrit', async () => {
    const a = await contexte();
    const doc = await make.assetFile(a.compte, { assetId: a.maison.id });
    const item = await make.agendaItem(a.compte, { title: 'Chez A' });
    expect((await geste(item.id, 'relier-document', doc.id)).status).toBe(200);
    const avant = await empreinte(a.compte);
    const b = await contexte();
    const docB = await make.assetFile(b.compte, { assetId: b.maison.id });
    expect((await liensDocument(doc.id, 'DELETE', item.id)).status).toBe(404);
    expect((await geste(item.id, 'detacher-document', doc.id)).status).toBe(404);
    // Élément de A, document de B (et l'inverse) : refusé.
    as(a.compte);
    expect((await geste(item.id, 'detacher-document', docB.id)).status).toBe(404);
    as(b.compte);
    expect((await liensDocument(docB.id, 'DELETE', item.id)).status).toBe(404);
    expect((await liensDocument(doc.id)).status).toBe(404);
    expect(await empreinte(a.compte)).toEqual(avant);
    expect(await decisionsLien(b.compte)).toEqual([]);
  });

  // ══ 09 ═══════════════════════════════════════════════════════════════════

  it('L86D-E2E-09 — compte en lecture seule : détachement refusé (403) des deux côtés, rien n’est écrit ; lecture permise', async () => {
    const c = await contexte(null);
    const doc = await make.assetFile(c.compte, { assetId: c.maison.id });
    const item = await make.agendaItem(c.compte, { title: 'Visite' });
    // Lien antérieur à la fin de l'abonnement.
    await sql`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id, provenances) VALUES (${item.id}, ${doc.id}, ARRAY['MANUAL_DIRECT']::text[])`;
    const avant = await empreinte(c.compte);
    expect((await liensDocument(doc.id, 'DELETE', item.id)).status).toBe(403);
    expect((await geste(item.id, 'detacher-document', doc.id)).status).toBe(403);
    expect(await empreinte(c.compte)).toEqual(avant);
    expect((await liensDocument(doc.id)).status).toBe(200);
    expect((await vue(item.id)).body.view.linkedDocuments.map((d: Json) => d.id)).toEqual([doc.id]);
  });
});
