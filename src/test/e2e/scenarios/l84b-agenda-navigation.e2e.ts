/**
 * Lot 84B — CDC « Opérations, Agenda, Timeline, Sinistres v5 », lot O-3
 * (Agenda et navigation) — PostgreSQL 16 réel.
 *
 * Chaînes de PRODUCTION : routes des tiroirs (`/api/agenda/:id/liens`,
 * `/api/documents/:id/agenda-liens`, suppression `/api/agenda/:id`), gestes
 * → service unique de regroupement (`withGroupingWrite`), écriture Opération
 * (dépôt), projection T4 (`projectAccountOperations`), invariants du registre
 * de cohérence. Garde d'écriture RÉELLE (`refuserSiLectureSeule`). Aucun appel
 * IA. Assertions limitées aux comptes créés ici.
 *
 *   L84B-E01  AC01 — lien manuel Document ↔ Agenda : Opération créée, rejointe (élément), rejointe (document)
 *   L84B-E02  AC02 — Agenda ↔ Agenda : quatre cas (§8.3), fusion sans absorption
 *   L84B-E03  AC04 / AC05 / AC06 — document sans lien Agenda ; principal désigné après : documents propagés ; nouveau document propagé
 *   L84B-E04  AC07 / AC08 — changement de principal : propagation transférée, lien précis conservé
 *   L84B-E05  AC27 / AC28 / §14.4 — vues des tiroirs : principal (5 catégories), secondaire léger, DocumentDrawer
 *   L84B-E06  AC32 — suppression du principal : aucun autre objet supprimé
 *   L84B-E07  retrait du rôle principal MÉMORISÉ : jamais rétabli par la projection T4 ni par une inférence ; invariant O3 ; nouvelle désignation
 *   L84B-E08  isolation de compte : lecture et gestes refusés, rien n'est écrit
 *   L84B-E09  compte en lecture seule : écriture refusée (403), rien n'est écrit ; lecture permise
 *   L84B-E10  retrait d'objets depuis le tiroir de l'ensemble ; détachement d'une étape ; candidats
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
const ecriture = () => import('@/services/business-operations/write');
const projection = () => import('@/services/business-operations/agenda-projection/service');
const grouping = () => import('@/services/business-operations/grouping/service');
const invariants = () => import('@/services/business-operations/grouping/invariants');
const runner = () => import('@/services/business-operations/grouping/runner');
const bus = () => import('@/services/business-operations/events');
const AUJ = '2026-10-23';

scenario('L84B', 'Opérations v5 — O-3 : Agenda et navigation (liens manuels, tiroirs, retrait du principal mémorisé)', ({ sql, make }) => {
  afterEach(async () => {
    (await bus()).resetBusinessOperationEventBusForTests();
  });

  const as = (c: Compte) => { session.userId = c.owner.id; session.currentAccountId = c.id; };
  async function contexte(plan: 'premium' | null = 'premium'): Promise<{ compte: Compte; maison: AssetRow }> {
    const compte = await make.account({ plan }) as Compte;
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    as(compte);
    return { compte, maison };
  }
  async function operation(compte: AccountRow, p: { assetId: number; fileId: number; type?: string; realized?: string | null }): Promise<number> {
    const { withBusinessOperationWrite } = await ecriture();
    return (await withBusinessOperationWrite(compte.id, (repo) => repo.create({
      type: { code: (p.type ?? 'CLAIM') as 'CLAIM' }, status: 'REALIZED', realizedDate: p.realized ?? '2026-03-12', technicalLabel: 'Dégât des eaux',
      source: { kind: 'DOCUMENT', entityKey: p.fileId, authority: 'DOCUMENT', confidence: 'certain' },
      assets: [{ assetId: p.assetId, role: 'PRIMARY', authority: 'DOCUMENT' }], reasonCode: 'E2E',
    }))).id;
  }
  async function ajouterDocument(compte: AccountRow, opId: number, fileId: number): Promise<void> {
    const { withBusinessOperationWrite } = await ecriture();
    await withBusinessOperationWrite(compte.id, (repo) => repo.addSource(opId, { kind: 'DOCUMENT', entityKey: fileId, authority: 'DOCUMENT' }));
  }
  const projeter = async (compte: AccountRow, ids: number[]) => (await projection()).projectAccountOperations(compte.id, { operationIds: ids, correlationId: 'l84b', today: AUJ });

  // ── Routes réelles ────────────────────────────────────────────────────────
  const json = (body: unknown) => ({ body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  async function vue(itemId: number, query = '') {
    const { GET } = await import('@/app/api/agenda/[id]/liens/route');
    const res = await GET(new NextRequest(`http://localhost/api/agenda/${itemId}/liens${query}`), { params: Promise.resolve({ id: String(itemId) }) });
    return { status: res.status, body: await res.json() as Json };
  }
  async function geste(itemId: number, action: string, targetId?: number) {
    const { POST } = await import('@/app/api/agenda/[id]/liens/route');
    const res = await POST(new NextRequest(`http://localhost/api/agenda/${itemId}/liens`, { method: 'POST', ...json({ action, targetId: targetId ?? null }) }),
      { params: Promise.resolve({ id: String(itemId) }) });
    return { status: res.status, body: await res.json() as Json };
  }
  async function liensDocument(fileId: number, method: 'GET' | 'POST' = 'GET', itemId?: number) {
    const route = await import('@/app/api/documents/[id]/agenda-liens/route');
    const req = method === 'GET'
      ? new NextRequest(`http://localhost/api/documents/${fileId}/agenda-liens`)
      : new NextRequest(`http://localhost/api/documents/${fileId}/agenda-liens`, { method: 'POST', ...json({ itemId }) });
    const res = await (method === 'GET' ? route.GET : route.POST)(req, { params: Promise.resolve({ id: String(fileId) }) });
    return { status: res.status, body: await res.json() as Json };
  }

  // ── Lectures ──────────────────────────────────────────────────────────────
  const element = async (id: number) => (await sql<Json[]>`
    SELECT business_operation_id::int AS op, operation_role AS role, operation_role_origin AS origin FROM agenda_items WHERE id = ${id}`)[0];
  const liensDe = (itemId: number) => sql<{ file: number; prov: string[] }[]>`
    SELECT asset_file_id AS file, provenances AS prov FROM agenda_file_links WHERE agenda_item_id = ${itemId} ORDER BY asset_file_id`;
  const membres = (opId: number) => sql<{ file_id: number; origins: string[] }[]>`
    SELECT file_id, origins FROM business_operation_documents WHERE operation_id = ${opId} AND active ORDER BY file_id`;
  const decisions = (compte: AccountRow, kind: string) => sql<Json[]>`
    SELECT source_entity_key AS key, candidate_operation_id::int AS op, decision, active FROM business_operation_match_decisions
     WHERE account_id = ${compte.id} AND source_kind = ${kind} ORDER BY id`;
  const empreinte = async (compte: AccountRow) => ({
    items: await sql`SELECT id, business_operation_id, operation_role, operation_role_origin, updated_at FROM agenda_items WHERE account_id = ${compte.id} ORDER BY id`,
    liens: await sql`SELECT l.agenda_item_id, l.asset_file_id, l.provenances FROM agenda_file_links l JOIN agenda_items i ON i.id = l.agenda_item_id WHERE i.account_id = ${compte.id} ORDER BY 1, 2`,
    ops: await sql`SELECT id, invalidated_at, merged_into_operation_id, version FROM business_operations WHERE account_id = ${compte.id} ORDER BY id`,
    docs: await sql`SELECT operation_id, file_id, origins, active FROM business_operation_documents WHERE account_id = ${compte.id} ORDER BY 1, 2`,
    decisions: await sql`SELECT id, source_kind, decision, active FROM business_operation_match_decisions WHERE account_id = ${compte.id} ORDER BY id`,
    rooms: await sql`SELECT id, active FROM business_operation_room_links WHERE account_id = ${compte.id} ORDER BY id`,
  });

  // ══ AC01 ══════════════════════════════════════════════════════════════════

  it('L84B-E01 — AC01 : un document lié manuellement à un élément crée ou rejoint le même regroupement (élément seul, élément regroupé, document regroupé)', async () => {
    const c = await contexte();
    // 1. Élément seul, document seul → regroupement CRÉÉ (type non qualifié, AC03), lien précis conservé.
    const devis = await make.assetFile(c.compte, { assetId: c.maison.id });
    const visite = await make.agendaItem(c.compte, { title: 'Visite expert', startDate: '2026-03-21', assetIds: [c.maison.id] });
    const r1 = await geste(visite.id, 'relier-document', devis.id);
    expect(r1.status).toBe(200);
    const op1 = (await element(visite.id)).op as number;
    expect(op1).toBeGreaterThan(0);
    expect(await element(visite.id)).toEqual({ op: op1, role: 'RELATED', origin: 'USER' });
    expect((await sql`SELECT type_code FROM business_operations WHERE id = ${op1}`)[0]).toEqual({ type_code: null });
    expect(await membres(op1)).toEqual([{ file_id: devis.id, origins: ['USER'] }]);
    expect(await liensDe(visite.id)).toEqual([{ file: devis.id, prov: ['MANUAL_DIRECT'] }]);
    expect(r1.body.view).toMatchObject({ role: 'MEMBER', main: null });
    // Rejoué : aucun second regroupement, rien ne change.
    const avant = await empreinte(c.compte);
    expect((await geste(visite.id, 'relier-document', devis.id)).status).toBe(200);
    expect((await empreinte(c.compte)).ops).toEqual(avant.ops);
    expect((await empreinte(c.compte)).liens).toEqual(avant.liens);

    // 2. Élément déjà regroupé (avec principal) → le document REJOINT son regroupement et est propagé au principal.
    const constat = await make.assetFile(c.compte, { assetId: c.maison.id });
    const op2 = await operation(c.compte, { assetId: c.maison.id, fileId: constat.id });
    const degat = await make.agendaItem(c.compte, { title: 'Dégât des eaux', startDate: '2026-03-12', assetIds: [c.maison.id] });
    const etape = await make.agendaItem(c.compte, { title: 'Réparation plafond', startDate: '2026-04-18', assetIds: [c.maison.id] });
    const { designatePrincipal, attachAgendaItem, withGroupingWrite } = await grouping();
    await withGroupingWrite(c.compte.id, async (ctx) => {
      await designatePrincipal(ctx, { operationId: op2, itemId: degat.id, origin: 'T4', reasonCode: 'E2E' });
      await attachAgendaItem(ctx, { operationId: op2, itemId: etape.id, origin: 'USER', reasonCode: 'E2E' });
    });
    const facture = await make.assetFile(c.compte, { assetId: c.maison.id });
    expect((await geste(etape.id, 'relier-document', facture.id)).status).toBe(200);
    expect((await element(etape.id)).op).toBe(op2);
    expect((await membres(op2)).map((m) => m.file_id)).toEqual([constat.id, facture.id].sort((a, b) => a - b));
    expect(await liensDe(etape.id)).toEqual([{ file: facture.id, prov: ['MANUAL_DIRECT'] }]);
    expect(await liensDe(degat.id)).toEqual([constat.id, facture.id].sort((a, b) => a - b).map((f) => ({ file: f, prov: ['OPERATION_PRINCIPAL'] })));

    // 3. Élément seul, document déjà dans UN regroupement → l'élément REJOINT celui du document (depuis le tiroir du document).
    const courrier = await make.agendaItem(c.compte, { title: 'Courrier assureur', startDate: '2026-05-02' });
    const lien = await liensDocument(constat.id, 'POST', courrier.id);
    expect(lien.status).toBe(200);
    expect(await element(courrier.id)).toEqual({ op: op2, role: 'RELATED', origin: 'USER' });
    expect(await liensDe(courrier.id)).toEqual([{ file: constat.id, prov: ['MANUAL_DIRECT'] }]);
    expect(lien.body.links).toEqual(expect.arrayContaining([expect.objectContaining({ itemId: courrier.id, direct: true, viaGroup: false })]));
    // Aucune nouvelle Opération pour ce cas ; aucune duplication du fichier.
    expect((await sql`SELECT count(*)::int AS n FROM business_operations WHERE account_id = ${c.compte.id}`)[0]).toEqual({ n: 2 });
    expect((await sql`SELECT count(*)::int AS n FROM asset_files WHERE account_id = ${c.compte.id}`)[0]).toEqual({ n: 3 });
  });

  // ══ AC02 ══════════════════════════════════════════════════════════════════

  it('L84B-E02 — AC02 : Agenda ↔ Agenda depuis le tiroir — créer, rattacher, sans effet, fusionner ; aucun élément absorbé', async () => {
    const c = await contexte();
    const a = await make.agendaItem(c.compte, { title: 'Devis plombier', startDate: '2026-03-15' });
    const b = await make.agendaItem(c.compte, { title: 'Visite expert', startDate: '2026-03-21' });
    const cr = await geste(a.id, 'relier-element', b.id);
    expect(cr.status).toBe(200);
    const op = (await element(a.id)).op as number;
    expect((await element(b.id)).op).toBe(op);
    const d = await make.agendaItem(c.compte, { title: 'Réparation', startDate: '2026-04-18' });
    expect((await geste(d.id, 'relier-element', a.id)).status).toBe(200);
    expect((await element(d.id)).op).toBe(op);
    const avant = await empreinte(c.compte);
    expect((await geste(a.id, 'relier-element', d.id)).body.changed).toBe(false);
    expect((await empreinte(c.compte)).items).toEqual(avant.items);
    // Deux regroupements différents → fusion transactionnelle, tous les éléments restent.
    const x = await make.agendaItem(c.compte, { title: 'Constat amiable', startDate: '2026-03-12' });
    const y = await make.agendaItem(c.compte, { title: 'Dégât des eaux', startDate: '2026-03-12' });
    await geste(x.id, 'relier-element', y.id);
    const autre = (await element(x.id)).op as number;
    expect(autre).not.toBe(op);
    expect((await geste(b.id, 'relier-element', y.id)).status).toBe(200);
    const canon = Math.min(op, autre);
    for (const it2 of [a, b, d, x, y]) expect((await element(it2.id)).op, String(it2.id)).toBe(canon);
    expect((await sql`SELECT merged_into_operation_id::int AS m FROM business_operations WHERE id = ${Math.max(op, autre)}`)[0]).toEqual({ m: canon });
    expect((await sql`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${c.compte.id}`)[0]).toEqual({ n: 5 });
    // Un élément ne se relie pas à lui-même.
    expect((await geste(a.id, 'relier-element', a.id)).status).toBe(400);
  });

  // ══ AC04 – AC06 ═══════════════════════════════════════════════════════════

  it('L84B-E03 — AC04 / AC05 / AC06 : document dans le regroupement sans lien Agenda ; principal désigné ensuite → documents rattachés rétroactivement ; nouveau document propagé', async () => {
    const c = await contexte();
    const constat = await make.assetFile(c.compte, { assetId: c.maison.id });
    const rapport = await make.assetFile(c.compte, { assetId: c.maison.id });
    const op = await operation(c.compte, { assetId: c.maison.id, fileId: constat.id });
    await ajouterDocument(c.compte, op, rapport.id);
    const visite = await make.agendaItem(c.compte, { title: 'Visite expert', startDate: '2026-03-21' });
    const degat = await make.agendaItem(c.compte, { title: 'Dégât des eaux', startDate: '2026-03-12' });
    const { attachAgendaItem, withGroupingWrite } = await grouping();
    await withGroupingWrite(c.compte.id, async (ctx) => {
      for (const id of [visite.id, degat.id]) await attachAgendaItem(ctx, { operationId: op, itemId: id, origin: 'USER', reasonCode: 'E2E' });
    });
    // AC04 : les documents appartiennent au regroupement, aucun lien Agenda artificiel (pas de principal).
    expect((await membres(op)).map((m) => m.file_id)).toEqual([constat.id, rapport.id].sort((x, y) => x - y));
    expect([...await liensDe(visite.id), ...await liensDe(degat.id)]).toEqual([]);
    // AC06 : l'utilisateur désigne l'événement de référence → documents déjà présents rattachés.
    const r = await geste(degat.id, 'designer-reference');
    expect(r.status).toBe(200);
    expect(await element(degat.id)).toEqual({ op, role: 'PRINCIPAL', origin: 'USER' });
    expect(await liensDe(degat.id)).toEqual([constat.id, rapport.id].sort((x, y) => x - y).map((f) => ({ file: f, prov: ['OPERATION_PRINCIPAL'] })));
    expect(await liensDe(visite.id)).toEqual([]);
    // AC05 : un nouveau document relié à une étape est aussi lié au principal.
    const facture = await make.assetFile(c.compte, { assetId: c.maison.id });
    await geste(visite.id, 'relier-document', facture.id);
    expect(await liensDe(degat.id)).toEqual(expect.arrayContaining([{ file: facture.id, prov: ['OPERATION_PRINCIPAL'] }]));
    expect(await liensDe(visite.id)).toEqual([{ file: facture.id, prov: ['MANUAL_DIRECT'] }]);
    expect(await decisions(c.compte, 'PRINCIPAL')).toEqual([{ key: String(degat.id), op, decision: 'CONFIRMED', active: true }]);
  });

  // ══ AC07 / AC08 ═══════════════════════════════════════════════════════════

  it('L84B-E04 — AC07 / AC08 : changement d’événement de référence — la propagation suit, le lien précis Rapport ↔ Visite expert reste', async () => {
    const c = await contexte();
    const constat = await make.assetFile(c.compte, { assetId: c.maison.id });
    const rapport = await make.assetFile(c.compte, { assetId: c.maison.id });
    const op = await operation(c.compte, { assetId: c.maison.id, fileId: constat.id });
    const degat = await make.agendaItem(c.compte, { title: 'Dégât des eaux', startDate: '2026-03-12' });
    const visite = await make.agendaItem(c.compte, { title: 'Visite expert', startDate: '2026-03-21' });
    const { attachAgendaItem, designatePrincipal, withGroupingWrite } = await grouping();
    await withGroupingWrite(c.compte.id, async (ctx) => {
      await designatePrincipal(ctx, { operationId: op, itemId: degat.id, origin: 'T4', reasonCode: 'E2E' });
      await attachAgendaItem(ctx, { operationId: op, itemId: visite.id, origin: 'USER', reasonCode: 'E2E' });
    });
    // AC08 : le rapport est lié au principal (ensemble) ET à la visite (lien précis).
    await geste(visite.id, 'relier-document', rapport.id);
    expect(await liensDe(degat.id)).toEqual([constat.id, rapport.id].sort((x, y) => x - y).map((f) => ({ file: f, prov: ['OPERATION_PRINCIPAL'] })));
    expect(await liensDe(visite.id)).toEqual([{ file: rapport.id, prov: ['MANUAL_DIRECT'] }]);
    // AC07 : la visite devient l'événement de référence (geste utilisateur).
    expect((await geste(visite.id, 'designer-reference')).status).toBe(200);
    expect(await element(visite.id)).toEqual({ op, role: 'PRINCIPAL', origin: 'USER' });
    expect((await element(degat.id)).role).toBe('RELATED');
    expect(await liensDe(degat.id)).toEqual([]);
    expect(await liensDe(visite.id)).toEqual([
      { file: constat.id, prov: ['OPERATION_PRINCIPAL'] },
      { file: rapport.id, prov: ['MANUAL_DIRECT', 'OPERATION_PRINCIPAL'] },
    ].sort((x, y) => x.file - y.file));
    // T4 ne reprend pas la main sur un choix de l'utilisateur.
    const r = await withGroupingWrite(c.compte.id, (ctx) => designatePrincipal(ctx, { operationId: op, itemId: degat.id, origin: 'T4', reasonCode: 'E2E' }));
    expect(r).toMatchObject({ changed: false, skipped: 'PRINCIPAL_PROTECTED' });
  });

  // ══ AC27 / AC28 / §14.4 ═══════════════════════════════════════════════════

  it('L84B-E05 — AC27 / AC28 / §14.4 : tiroir du principal (cinq catégories), tiroir secondaire léger, DocumentDrawer (principal + lien précis)', async () => {
    const c = await contexte();
    const constat = await make.assetFile(c.compte, { assetId: c.maison.id });
    const rapport = await make.assetFile(c.compte, { assetId: c.maison.id });
    const garage = await make.asset(c.compte, { category: 'IMMOBILIER', name: 'Garage' });
    const [cuisine] = await sql<{ id: number }[]>`INSERT INTO substructures (asset_id, name) VALUES (${c.maison.id}, 'Cuisine') RETURNING id`;
    const [ballon] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name, type) VALUES (${c.maison.id}, 'Ballon d’eau chaude', 'WATER_HEATER') RETURNING id`;
    const op = await operation(c.compte, { assetId: c.maison.id, fileId: constat.id });
    const degat = await make.agendaItem(c.compte, { title: 'Dégât des eaux', startDate: '2026-03-12' });
    const visite = await make.agendaItem(c.compte, { title: 'Visite expert', startDate: '2026-03-21' });
    const { attachAgendaItem, designatePrincipal, withGroupingWrite } = await grouping();
    await withGroupingWrite(c.compte.id, async (ctx) => {
      await designatePrincipal(ctx, { operationId: op, itemId: degat.id, origin: 'T4', reasonCode: 'E2E' });
      await attachAgendaItem(ctx, { operationId: op, itemId: visite.id, origin: 'USER', reasonCode: 'E2E' });
    });
    await geste(visite.id, 'relier-document', rapport.id);
    // Rattacher depuis le tiroir du principal : bien, Pièce, équipement (objets EXISTANTS).
    for (const [a, t] of [['relier-bien', garage.id], ['relier-piece', cuisine.id], ['relier-equipement', ballon.id]] as const) {
      expect((await geste(degat.id, a, t)).status, a).toBe(200);
    }
    const p = (await vue(degat.id)).body.view;
    expect(p.role).toBe('MAIN');
    expect(p.ensemble.items).toEqual([{ id: visite.id, title: 'Visite expert', startDate: '2026-03-21', isMain: false }]);
    expect(p.ensemble.documents.map((d: Json) => [d.id, d.link])).toEqual([[constat.id, 'GROUP'], [rapport.id, 'GROUP']].sort((x, y) => (x[0] as number) - (y[0] as number)));
    expect(p.ensemble.assets.map((x: Json) => x.name)).toEqual(['Garage', 'Maison']);
    expect(p.ensemble.rooms).toEqual([{ id: cuisine.id, name: 'Cuisine', assetId: c.maison.id }]);
    expect(p.ensemble.equipments).toEqual([{ id: ballon.id, name: 'Ballon d’eau chaude', assetId: c.maison.id }]);
    expect(JSON.stringify(p)).not.toMatch(/op[ée]ration/i);
    // AC28 : secondaire léger — contexte global chiffré et accès au principal, jamais le détail.
    const s = (await vue(visite.id)).body.view;
    expect(s).toEqual({
      itemId: visite.id, role: 'MEMBER', mainWithdrawn: false, ensemble: null,
      main: { id: degat.id, title: 'Dégât des eaux', startDate: '2026-03-12' },
      counts: { items: 1, documents: 2, assets: 2, rooms: 1, equipments: 1 },
      // Lot 86D : documents de CET élément (consulter, ouvrir, détacher) — ses liens, rien de plus.
      linkedDocuments: expect.any(Array),
    });
    expect(s.linkedDocuments.map((x: Json) => x.id)).toEqual((await liensDe(visite.id)).map((l) => l.file));
    // §14.4 : le document retrouve le principal (lien propagé) et conserve son lien précis.
    const d = (await liensDocument(rapport.id)).body.links;
    expect(d).toEqual([
      { itemId: degat.id, direct: false, viaGroup: true, isMain: true },
      { itemId: visite.id, direct: true, viaGroup: false, isMain: false },
    ]);
    // Candidats : objets du compte non encore reliés, filtre.
    const cand = (await vue(degat.id, '?candidats=biens&q=')).body.candidates;
    expect(cand).toEqual([]);
    const docs = (await vue(degat.id, '?candidats=documents&q=')).body.candidates;
    expect(docs).toEqual([]);
    expect((await vue(degat.id, '?candidats=inconnu')).status).toBe(400);
  });

  // ══ AC32 ══════════════════════════════════════════════════════════════════

  it('L84B-E06 — AC32 : la suppression de l’événement de référence ne supprime aucun autre objet', async () => {
    const c = await contexte();
    const constat = await make.assetFile(c.compte, { assetId: c.maison.id });
    const rapport = await make.assetFile(c.compte, { assetId: c.maison.id });
    const op = await operation(c.compte, { assetId: c.maison.id, fileId: constat.id });
    const degat = await make.agendaItem(c.compte, { title: 'Dégât des eaux', startDate: '2026-03-12' });
    const visite = await make.agendaItem(c.compte, { title: 'Visite expert', startDate: '2026-03-21' });
    const { attachAgendaItem, designatePrincipal, withGroupingWrite } = await grouping();
    await withGroupingWrite(c.compte.id, async (ctx) => {
      await designatePrincipal(ctx, { operationId: op, itemId: degat.id, origin: 'USER', reasonCode: 'E2E' });
      await attachAgendaItem(ctx, { operationId: op, itemId: visite.id, origin: 'USER', reasonCode: 'E2E' });
    });
    await geste(visite.id, 'relier-document', rapport.id);
    const { DELETE } = await import('@/app/api/agenda/[id]/route');
    const res = await DELETE(new NextRequest(`http://localhost/api/agenda/${degat.id}`, { method: 'DELETE' }), { params: Promise.resolve({ id: String(degat.id) }) });
    expect(res.status).toBe(200);
    expect(await sql`SELECT id FROM agenda_items WHERE id = ${degat.id}`).toEqual([]);
    expect(await element(visite.id)).toEqual({ op, role: 'RELATED', origin: 'USER' });
    expect(await liensDe(visite.id)).toEqual([{ file: rapport.id, prov: ['MANUAL_DIRECT'] }]);
    expect((await sql`SELECT invalidated_at FROM business_operations WHERE id = ${op}`)[0]).toEqual({ invalidated_at: null });
    expect((await membres(op)).map((m) => m.file_id)).toEqual([constat.id, rapport.id].sort((x, y) => x - y));
    expect((await sql`SELECT count(*)::int AS n FROM asset_files WHERE account_id = ${c.compte.id} AND deleted_at IS NULL`)[0]).toEqual({ n: 2 });
    // L'ensemble reste accessible depuis l'étape (sans événement de référence).
    expect((await vue(visite.id)).body.view).toMatchObject({ role: 'MEMBER', main: null });
  });

  // ══ Retrait du rôle principal (point ouvert 83A) ══════════════════════════

  it('L84B-E07 — retrait du rôle principal MÉMORISÉ : la projection T4 ne le rétablit pas (ni sur l’élément, ni sur un autre, ni par création) ; invariant O3 ; nouvelle désignation de l’utilisateur', async () => {
    const c = await contexte();
    const constat = await make.assetFile(c.compte, { assetId: c.maison.id });
    const op = await operation(c.compte, { assetId: c.maison.id, fileId: constat.id });
    // T4 projette l'événement global (principal créé par la projection).
    await projeter(c.compte, [op]);
    const [p] = await sql<{ id: number }[]>`SELECT id FROM agenda_items WHERE account_id = ${c.compte.id} AND business_operation_id = ${op} AND operation_role = 'PRINCIPAL'`;
    expect(p).toBeTruthy();
    expect(await liensDe(p.id)).toEqual([{ file: constat.id, prov: ['OPERATION_PRINCIPAL'] }]);
    // Une étape saisie, même bien, même date (la projection la reconnaîtrait comme l'événement global).
    const saisi = await make.agendaItem(c.compte, { title: 'Dégâts des eaux cuisine', startDate: '2026-03-12', assetIds: [c.maison.id] });
    await geste(saisi.id, 'relier-element', p.id);
    expect((await element(saisi.id)).op).toBe(op);

    // Geste : « Ne plus en faire l'événement de référence ».
    const r = await geste(p.id, 'retirer-reference');
    expect(r.status).toBe(200);
    expect(r.body.changed).toBe(true);
    expect(await element(p.id)).toEqual({ op, role: 'RELATED', origin: 'USER' });
    expect(await liensDe(p.id)).toEqual([]);
    expect(await decisions(c.compte, 'PRINCIPAL')).toEqual([{ key: String(p.id), op, decision: 'REJECTED', active: true }]);
    expect(r.body.view).toMatchObject({ role: 'MEMBER', main: null, mainWithdrawn: true });

    // La projection rejouée (deux fois) : aucun principal, aucun élément créé, rien d'écrit.
    const avant = await empreinte(c.compte);
    const r1 = await projeter(c.compte, [op]);
    const r2 = await projeter(c.compte, [op]);
    expect(r1.created + r2.created).toBe(0);
    expect(await empreinte(c.compte)).toEqual(avant);
    expect(await sql`SELECT id FROM agenda_items WHERE business_operation_id = ${op} AND operation_role = 'PRINCIPAL'`).toEqual([]);
    // Une inférence (T4, T3, reprise) ne désigne aucun principal ; rien n'est écrit.
    const { designatePrincipal, attachAgendaItem, withGroupingWrite } = await grouping();
    for (const origin of ['T4', 'T3', 'SYSTEM'] as const) {
      for (const itemId of [p.id, saisi.id]) {
        const x = await withGroupingWrite(c.compte.id, (ctx) => designatePrincipal(ctx, { operationId: op, itemId, origin, reasonCode: 'E2E' }));
        expect(x, `${origin}:${itemId}`).toMatchObject({ changed: false, skipped: 'USER_REJECTED' });
      }
    }
    // Un élément extérieur proposé comme principal par T4 n'est même pas rattaché.
    const ailleurs = await make.agendaItem(c.compte, { title: 'Dégât des eaux', startDate: '2026-03-12' });
    expect(await withGroupingWrite(c.compte.id, (ctx) => attachAgendaItem(ctx, { operationId: op, itemId: ailleurs.id, role: 'PRINCIPAL', origin: 'T4', reasonCode: 'E2E' })))
      .toMatchObject({ changed: false, skipped: 'USER_REJECTED' });
    expect((await element(ailleurs.id)).op).toBeNull();
    expect(await empreinte(c.compte)).toEqual({ ...avant, items: await sql`SELECT id, business_operation_id, operation_role, operation_role_origin, updated_at FROM agenda_items WHERE account_id = ${c.compte.id} ORDER BY id` });

    // Contournement (chemin hors service) : l'invariant O3 le détecte, la réparation passe par le service.
    await sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE agenda_items SET operation_role = 'PRINCIPAL', operation_role_origin = 'T4' WHERE id = ${saisi.id}`;
    });
    const inv = (await invariants()).OPERATIONS_GROUPING_INVARIANTS.find((i) => i.id === 'O3-PRINCIPAL-WITHDRAWN')!;
    const { drizzleRunner } = await runner();
    const { db } = await import('@/db');
    const constats = await inv.detect(drizzleRunner(db), c.compte.id);
    expect(constats).toEqual([expect.objectContaining({ objectKey: `operation:${op}`, detail: expect.objectContaining({ itemId: saisi.id, origin: 'T4', withdrawnItemIds: [p.id] }) })]);
    const rep = await withGroupingWrite(c.compte.id, (ctx) => inv.repairFinding!(ctx, constats[0]));
    expect(rep).toEqual({ repaired: true, changed: true });
    expect(await element(saisi.id)).toMatchObject({ op, role: 'RELATED' });
    expect(await inv.detect(drizzleRunner(db), c.compte.id)).toEqual([]);
    // Un autre compte n'est jamais touché par la détection.
    expect(await inv.detect(drizzleRunner(db), c.compte.id + 1_000_000)).toEqual([]);

    // L'utilisateur désigne un nouvel événement de référence : le retrait est levé (désactivé, jamais effacé).
    expect((await geste(saisi.id, 'designer-reference')).status).toBe(200);
    expect(await element(saisi.id)).toEqual({ op, role: 'PRINCIPAL', origin: 'USER' });
    expect(await decisions(c.compte, 'PRINCIPAL')).toEqual([
      { key: String(p.id), op, decision: 'REJECTED', active: false },
      { key: String(saisi.id), op, decision: 'CONFIRMED', active: true },
    ]);
    expect(await liensDe(saisi.id)).toEqual([{ file: constat.id, prov: ['OPERATION_PRINCIPAL'] }]);
    const apres = await projeter(c.compte, [op]);
    expect(apres.created).toBe(0);
    expect(await element(saisi.id)).toEqual({ op, role: 'PRINCIPAL', origin: 'USER' });
  });

  // ══ Isolation, lecture seule ══════════════════════════════════════════════

  it('L84B-E08 — isolation de compte : lecture et gestes refusés (404), aucun objet étranger relié, rien n’est écrit', async () => {
    const a = await contexte();
    const b = await contexte();
    const docA = await make.assetFile(a.compte, { assetId: a.maison.id });
    const itemA = await make.agendaItem(a.compte, { title: 'Visite expert', startDate: '2026-03-21' });
    const itemB = await make.agendaItem(b.compte, { title: 'Chez B', startDate: '2026-03-21' });
    const docB = await make.assetFile(b.compte, { assetId: b.maison.id });
    const avantA = await empreinte(a.compte);
    const avantB = await empreinte(b.compte);
    as(b.compte);
    expect((await vue(itemA.id)).status).toBe(404);
    expect((await vue(itemA.id, '?candidats=documents&q=')).status).toBe(404);
    expect((await geste(itemA.id, 'relier-document', docB.id)).status).toBe(404);
    expect((await geste(itemB.id, 'relier-document', docA.id)).status).toBe(404);
    expect((await geste(itemB.id, 'relier-element', itemA.id)).status).toBe(404);
    expect((await liensDocument(docA.id)).status).toBe(404);
    expect((await liensDocument(docA.id, 'POST', itemB.id)).status).toBe(404);
    expect((await liensDocument(docB.id, 'POST', itemA.id)).status).toBe(404);
    // Candidats : jamais un objet d'un autre compte.
    const cands = (await vue(itemB.id, '?candidats=documents&q=')).body.candidates as Json[];
    expect(cands.map((x) => x.id)).toEqual([docB.id]);
    const elems = (await vue(itemB.id, '?candidats=elements&q=')).body.candidates as Json[];
    expect(elems.map((x) => x.id)).not.toContain(itemA.id);
    expect(await empreinte(a.compte)).toEqual(avantA);
    expect(await empreinte(b.compte)).toEqual(avantB);
  });

  it('L84B-E09 — compte en lecture seule : tout geste refusé (403) sans écriture ; la consultation reste permise', async () => {
    const c = await contexte(null);
    const doc = await make.assetFile(c.compte, { assetId: c.maison.id });
    const a = await make.agendaItem(c.compte, { title: 'Visite expert', startDate: '2026-03-21' });
    const b = await make.agendaItem(c.compte, { title: 'Dégât des eaux', startDate: '2026-03-12' });
    const avant = await empreinte(c.compte);
    for (const [action, t] of [['relier-element', b.id], ['relier-document', doc.id], ['designer-reference', undefined], ['retirer-reference', undefined]] as const) {
      const r = await geste(a.id, action, t);
      expect(r.status, action).toBe(403);
      expect(r.body.code, action).toMatch(/TRIAL_EXPIRED|SUBSCRIPTION_REQUIRED/);
    }
    expect((await liensDocument(doc.id, 'POST', a.id)).status).toBe(403);
    expect(await empreinte(c.compte)).toEqual(avant);
    expect((await vue(a.id)).status).toBe(200);
    expect((await liensDocument(doc.id)).status).toBe(200);
  });

  // ══ Retraits depuis le tiroir ═════════════════════════════════════════════

  it('L84B-E10 — retirer depuis le tiroir de l’ensemble (étape, document, bien, Pièce, équipement) ; quitter l’ensemble ; décisions mémorisées', async () => {
    const c = await contexte();
    const constat = await make.assetFile(c.compte, { assetId: c.maison.id });
    const devis = await make.assetFile(c.compte, { assetId: c.maison.id });
    const [cuisine] = await sql<{ id: number }[]>`INSERT INTO substructures (asset_id, name) VALUES (${c.maison.id}, 'Cuisine') RETURNING id`;
    const [ballon] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name, type) VALUES (${c.maison.id}, 'Ballon', 'WATER_HEATER') RETURNING id`;
    const op = await operation(c.compte, { assetId: c.maison.id, fileId: constat.id });
    const degat = await make.agendaItem(c.compte, { title: 'Dégât des eaux', startDate: '2026-03-12' });
    const visite = await make.agendaItem(c.compte, { title: 'Visite expert', startDate: '2026-03-21' });
    const reparation = await make.agendaItem(c.compte, { title: 'Réparation', startDate: '2026-04-18' });
    const { attachAgendaItem, designatePrincipal, withGroupingWrite } = await grouping();
    await withGroupingWrite(c.compte.id, async (ctx) => {
      await designatePrincipal(ctx, { operationId: op, itemId: degat.id, origin: 'USER', reasonCode: 'E2E' });
      for (const id of [visite.id, reparation.id]) await attachAgendaItem(ctx, { operationId: op, itemId: id, origin: 'USER', reasonCode: 'E2E' });
    });
    await geste(degat.id, 'relier-document', devis.id);
    await geste(degat.id, 'relier-piece', cuisine.id);
    await geste(degat.id, 'relier-equipement', ballon.id);
    expect(await liensDe(degat.id)).toEqual([
      { file: constat.id, prov: ['OPERATION_PRINCIPAL'] }, { file: devis.id, prov: ['MANUAL_DIRECT', 'OPERATION_PRINCIPAL'] },
    ].sort((x, y) => x.file - y.file));
    // Retraits depuis le tiroir du principal.
    expect((await geste(degat.id, 'retirer-element', visite.id)).status).toBe(200);
    expect((await element(visite.id)).op).toBeNull();
    expect((await geste(degat.id, 'retirer-document', devis.id)).status).toBe(200);
    expect(await liensDe(degat.id)).toEqual([{ file: constat.id, prov: ['OPERATION_PRINCIPAL'] }]);
    expect((await membres(op)).map((m) => m.file_id)).toEqual([constat.id]);
    expect((await geste(degat.id, 'retirer-piece', cuisine.id)).status).toBe(200);
    expect((await geste(degat.id, 'retirer-equipement', ballon.id)).status).toBe(200);
    expect((await geste(degat.id, 'retirer-bien', c.maison.id)).status).toBe(200);
    const v = (await vue(degat.id)).body.view;
    expect(v.ensemble).toMatchObject({ items: [expect.objectContaining({ id: reparation.id })], rooms: [], equipments: [], assets: [] });
    expect(v.ensemble.documents.map((d: Json) => d.id)).toEqual([constat.id]);
    // Décisions mémorisées : refus de l'étape, du document, de la Pièce, de l'équipement ; exclusion du bien.
    for (const k of ['AGENDA', 'DOCUMENT', 'ROOM', 'EQUIPMENT']) {
      expect((await decisions(c.compte, k)).some((d) => d.decision === 'REJECTED' && d.active), k).toBe(true);
    }
    expect((await sql`SELECT count(*)::int AS n FROM business_operation_asset_exclusions WHERE operation_id = ${op}`)[0].n).toBe(1);
    // Une étape quitte elle-même l'ensemble ; un geste sur un élément non regroupé est refusé proprement.
    expect((await geste(reparation.id, 'quitter-ensemble')).status).toBe(200);
    expect((await element(reparation.id)).op).toBeNull();
    expect((await geste(reparation.id, 'relier-bien', c.maison.id)).status).toBe(409);
    // Rien n'a été supprimé : documents, Pièce, équipement, éléments.
    expect((await sql`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${c.compte.id}`)[0].n).toBe(3);
    expect((await sql`SELECT count(*)::int AS n FROM substructures WHERE id = ${cuisine.id}`)[0].n).toBe(1);
    expect((await sql`SELECT count(*)::int AS n FROM equipments WHERE id = ${ballon.id}`)[0].n).toBe(1);
  });
});
