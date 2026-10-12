/**
 * Lot 46 — O7 : T4 / Agenda, projection des Opérations (CDC Opérations V1
 * ch. 17.1, P14, B16, C4, C16, C16.1, C16.2, C22, F-138 à F-147) — base
 * PostgreSQL réelle.
 *
 * Opérations écrites par l'API d'écriture de production (et, pour la boucle
 * « achat », par la fiche et le moteur T3 réels) ; agenda par
 * `AgendaWriteService` / la primitive ; sinistres par les routes de
 * production ; projection par `OperationAgendaProjectionService`. Aucun
 * appel IA.
 */
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';

const session = vi.hoisted(() => ({ currentAccountId: 0, userId: 0 }));
const notifs = vi.hoisted(() => ({ created: [] as number[] }));
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
  ...(await o<object>()),
  emitAgendaItemCreated: async (_a: number, _b: number, itemId: number) => { notifs.created.push(itemId); },
}));

const AUJOURDHUI = new Date().toISOString().slice(0, 10);
const plus = (jours: number) => new Date(Date.now() + jours * 86_400_000).toISOString().slice(0, 10);
const bus = () => import('@/services/business-operations/events');
const ecriture = () => import('@/services/business-operations/write');
const projection = () => import('@/services/business-operations/agenda-projection/service');
const fileProjection = () => import('@/services/business-operations/agenda-projection/queue');
const agendaWrite = () => import('@/services/agenda/AgendaWriteService');

type Json = Record<string, unknown>;
type Item = {
  id: number; title: string; start_date: string | null; event_nature: string | null; business_type: string | null; projection_origin: string | null;
  op: number | null; functional_key: string | null; is_automatic: boolean; manual_status: string | null; origin_type: string; home_category: string | null;
  projection_correlation_id: string | null;
};

scenario('L46-O7', 'T4 / Agenda : projection des Opérations (C16), rapprochement, suppression mémorisée, anti-boucle', ({ sql, make }) => {
  afterEach(async () => {
    (await bus()).resetBusinessOperationEventBusForTests();
    notifs.created.length = 0;
  });
  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
  });

  async function creerOp(compte: AccountRow, p: {
    type: string; status?: string; planned?: string | null; realized?: string | null; assetIds: number[]; fileId?: number | null;
    label?: string | null; provider?: string | null; sourceKind?: 'DOCUMENT' | 'ASSET_DATA';
  }): Promise<number> {
    const { withBusinessOperationWrite } = await ecriture();
    const r = await withBusinessOperationWrite(compte.id, (repo) => repo.create({
      type: { code: p.type } as never,
      status: (p.status ?? 'REALIZED') as never,
      plannedDate: p.planned ?? null,
      realizedDate: p.realized ?? null,
      technicalLabel: p.label ?? null,
      provider: p.provider ?? null,
      source: p.fileId
        ? { kind: 'DOCUMENT', entityKey: p.fileId, role: 'INVOICE', authority: 'DOCUMENT', confidence: 'certain' }
        : { kind: 'ASSET_DATA', entityKey: p.assetIds[0], authority: 'USER', confidence: 'certain', locator: { nature: p.type } },
      assets: p.assetIds.map((assetId, i) => ({ assetId, role: i === 0 ? 'PRIMARY' : 'CONCERNED', authority: 'DOCUMENT' })),
      reasonCode: 'E2E',
    }));
    return r.id;
  }
  const projeter = async (compte: AccountRow, ids?: number[]) =>
    (await projection()).projectAccountOperations(compte.id, ids ? { operationIds: ids, correlationId: 'corr-e2e' } : { all: true, correlationId: 'corr-e2e' });
  const items = (compte: AccountRow) => sql<Item[]>`
    SELECT id, title, start_date::text AS start_date, event_nature, business_type, projection_origin, business_operation_id::int AS op,
           functional_key, is_automatic, manual_status, origin_type, home_category, projection_correlation_id
      FROM agenda_items WHERE account_id = ${compte.id} ORDER BY id`;
  const liens = async (itemId: number) => ({
    assets: (await sql<{ a: number }[]>`SELECT asset_id AS a FROM agenda_asset_links WHERE agenda_item_id = ${itemId} ORDER BY 1`).map((x) => x.a),
    files: (await sql<{ f: number }[]>`SELECT asset_file_id AS f FROM agenda_file_links WHERE agenda_item_id = ${itemId} ORDER BY 1`).map((x) => x.f),
  });
  const suppressions = (opId: number) => sql<{ projection_key: string; user_id: number | null }[]>`
    SELECT projection_key, user_id FROM business_operation_projection_suppressions WHERE operation_id = ${opId}`;

  // ══ Projection par type (tableau C16) ═════════════════════════════════════

  it('F-138 / O7-E01 / C16-01 — intervention ENVISAGED datée → UN événement planifié, notifié ; rejouée : no-op', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    const devis = await make.assetFile(compte, { assetId: maison.id });
    const prevu = plus(20);
    const op = await creerOp(compte, { type: 'INTERVENTION', status: 'ENVISAGED', planned: prevu, assetIds: [maison.id], fileId: devis.id, label: 'Remplacement chaudière' });
    const r = await projeter(compte, [op]);
    expect(r).toMatchObject({ created: 1, changes: 1 });
    const [evt, ...autres] = await items(compte);
    expect(autres).toEqual([]);
    expect(evt).toMatchObject({
      title: 'Remplacement chaudière', start_date: prevu, event_nature: 'DEADLINE', business_type: 'maintenance', projection_origin: 'OPERATION',
      op, functional_key: `bo:v1:${op}:INTERVENTION`, is_automatic: true, manual_status: null, origin_type: 'deduced_rule', home_category: 'action',
      projection_correlation_id: 'corr-e2e',
    });
    expect(await liens(evt.id)).toEqual({ assets: [maison.id], files: [devis.id] });
    expect(notifs.created).toEqual([evt.id]);
    // Idempotence : aucune écriture au second passage, ni en passage complet.
    const avant = (await sql<{ u: string }[]>`SELECT updated_at::text AS u FROM agenda_items WHERE id = ${evt.id}`)[0].u;
    expect((await projeter(compte, [op])).changes).toBe(0);
    expect((await projeter(compte)).changes).toBe(0);
    expect((await sql<{ u: string }[]>`SELECT updated_at::text AS u FROM agenda_items WHERE id = ${evt.id}`)[0].u).toBe(avant);
  });

  it('O7-E02 / C16-02 / C22 — ENVISAGED → REALIZED : le MÊME événement devient historique (date réelle) ; jamais notifié à nouveau', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    const devis = await make.assetFile(compte, { assetId: maison.id });
    const op = await creerOp(compte, { type: 'INTERVENTION', status: 'ENVISAGED', planned: plus(10), assetIds: [maison.id], fileId: devis.id, label: 'Ramonage' });
    await projeter(compte, [op]);
    const [avant] = await items(compte);
    notifs.created.length = 0;
    const { withBusinessOperationWrite } = await ecriture();
    await withBusinessOperationWrite(compte.id, async (repo) => {
      await repo.setStatus(op, 'REALIZED', { reasonCode: 'E2E' });
      await repo.updateAttributes(op, { realizedDate: AUJOURDHUI }, 'E2E');
    });
    expect(await projeter(compte, [op])).toMatchObject({ updated: 1, created: 0 });
    const [apres, ...autres] = await items(compte);
    expect(autres).toEqual([]);
    expect(apres).toMatchObject({ id: avant.id, start_date: AUJOURDHUI, event_nature: 'HISTORICAL', home_category: 'information', manual_status: null });
    expect(notifs.created).toEqual([]);
    expect((await projeter(compte, [op])).changes).toBe(0);
  });

  it('F-139 / F-141 / F-142 / F-143 / F-144 / C16 — historiques datés (intervention, sinistre, achat, sortie) ; contrat seulement avec échéance ; financement jamais', async () => {
    const compte = await make.account({ plan: 'premium' });
    const clio = await make.asset(compte, { category: 'VEHICULE' });
    const f = await make.assetFile(compte, { assetId: clio.id });
    const inter = await creerOp(compte, { type: 'INTERVENTION', realized: '2026-03-10', assetIds: [clio.id], fileId: f.id, label: 'Vidange' });
    const sinistre = await creerOp(compte, { type: 'CLAIM', realized: '2026-04-02', assetIds: [clio.id], fileId: f.id });
    const achat = await creerOp(compte, { type: 'ACQUISITION', realized: '2021-03-01', assetIds: [clio.id] });
    const vente = await creerOp(compte, { type: 'DISPOSAL', realized: '2026-06-30', assetIds: [clio.id] });
    const sansDate = await creerOp(compte, { type: 'INTERVENTION', realized: null, assetIds: [clio.id], fileId: f.id });
    const contratSans = await creerOp(compte, { type: 'CONTRACT', assetIds: [clio.id], fileId: f.id, provider: 'Assur+' });
    const contrat = await creerOp(compte, { type: 'CONTRACT', assetIds: [clio.id], fileId: f.id, provider: 'Assur+' });
    const { withBusinessOperationWrite } = await ecriture();
    await withBusinessOperationWrite(compte.id, (repo) => repo.upsertContractDetails(contrat, { effectiveTo: plus(90) }));
    const financement = await creerOp(compte, { type: 'FINANCING', assetIds: [clio.id], fileId: f.id });
    await sql`UPDATE business_operations SET end_date = ${plus(400)} WHERE id = ${financement}`;
    await projeter(compte);

    const parOp = new Map((await items(compte)).map((i) => [i.op, i]));
    expect(parOp.get(inter)).toMatchObject({ title: 'Vidange', start_date: '2026-03-10', event_nature: 'HISTORICAL', business_type: 'maintenance' });
    expect(parOp.get(sinistre)).toMatchObject({ title: 'Sinistre', start_date: '2026-04-02', event_nature: 'HISTORICAL', business_type: 'claim' });
    expect(parOp.get(achat)).toMatchObject({ title: 'Achat', start_date: '2021-03-01', event_nature: 'HISTORICAL', business_type: 'purchase' });
    expect(parOp.get(vente)).toMatchObject({ title: 'Vente', start_date: '2026-06-30', event_nature: 'HISTORICAL', business_type: 'sale' });
    expect(parOp.get(contrat)).toMatchObject({ title: 'Fin de contrat — Assur+', start_date: plus(90), event_nature: 'DEADLINE', business_type: 'contract' });
    // F-140 : sans date, rien d'inventé ; F-144 : contrat sans échéance, aucune copie ; financement : aucune projection.
    for (const absent of [sansDate, contratSans, financement]) expect(parOp.has(absent)).toBe(false);
    expect(parOp.size).toBe(5);
    // D-14 : seuls les événements à venir sont notifiés (l'échéance du contrat), jamais un historique.
    expect(notifs.created).toEqual([parOp.get(contrat)!.id]);
    // D-15 : aucune carte « statut du bien » proposée par la vente projetée.
    expect(await sql`SELECT id FROM to_process_actions WHERE account_id = ${compte.id} AND rule_code = 'ASSET-STATUS'`).toEqual([]);
  });

  it('O7-E04 / D-14 — un historique projeté est hors « prochaines échéances » et hors mascotte ; l\'échéance projetée y figure', async () => {
    const compte = await make.account({ plan: 'premium' });
    const clio = await make.asset(compte, { category: 'VEHICULE' });
    const f = await make.assetFile(compte, { assetId: clio.id });
    // Historique daté dans l'horizon (cas limite volontaire : seule la nature l'exclut).
    const hist = await creerOp(compte, { type: 'INTERVENTION', realized: plus(3), assetIds: [clio.id], fileId: f.id, label: 'Réparation pare-brise' });
    const prevue = await creerOp(compte, { type: 'INTERVENTION', status: 'ENVISAGED', planned: plus(5), assetIds: [clio.id], fileId: f.id, label: 'Révision' });
    await projeter(compte);
    const parOp = new Map((await items(compte)).map((i) => [i.op, i.id]));
    const { getUpcomingDeadlines, getHomepageAgendaItems } = await import('@/services/agenda/AgendaQueryService');
    const prochaines = (await getUpcomingDeadlines(compte.id)).map((i) => i.id);
    expect(prochaines).toContain(parOp.get(prevue));
    expect(prochaines).not.toContain(parOp.get(hist));
    expect((await getHomepageAgendaItems(compte.id)).map((i) => i.id)).not.toContain(parOp.get(hist));
    const { collectMascotData } = await import('@/services/home/mascot/collector');
    const mascotte = (await collectMascotData(compte.id)).agenda?.map((a) => a.id) ?? [];
    expect(mascotte).not.toContain(parOp.get(hist));
    expect(mascotte).toContain(parOp.get(prevue));
  });

  // ══ Rapprochement (C16.1, F-147) ═══════════════════════════════════════════

  it('F-147 / O7-E05 / C16-10 — événement saisi AVANT l\'Opération : lié (texte conservé), aucun doublon ; T4 lié et intact : marqué réalisé', async () => {
    const compte = await make.account({ plan: 'premium' });
    const clio = await make.asset(compte, { category: 'VEHICULE' });
    const { createAgendaItem } = await agendaWrite();
    const manuel = await createAgendaItem({ title: 'Achat de ma Clio chez Dupont', startDate: '2021-03-02', assetIds: [clio.id], homeCategory: 'information' }, compte.id, compte.ownerUserId);
    const achat = await creerOp(compte, { type: 'ACQUISITION', realized: '2021-03-01', assetIds: [clio.id] });
    expect(await projeter(compte, [achat])).toMatchObject({ linked: 1, created: 0 });
    const [seul, ...autres] = await items(compte);
    expect(autres).toEqual([]);
    expect(seul).toMatchObject({ id: manuel.id, title: 'Achat de ma Clio chez Dupont', start_date: '2021-03-02', op: achat, projection_origin: null });
    expect((await projeter(compte, [achat])).changes).toBe(0);

    // Échéance T4 (document) planifiée, puis l'intervention réalisée : liée et marquée réalisée.
    const f = await make.assetFile(compte, { assetId: clio.id });
    const { upsertAgendaItem } = await import('@/services/agenda/agenda-write-primitive');
    const t4 = await upsertAgendaItem({
      accountId: compte.id, assetId: clio.id, origin: 'AUTOMATIC', title: 'Révision', date: '2026-03-08', nature: 'DEADLINE', businessType: 'maintenance',
      category: 'action', sources: [{ fileId: f.id, role: 'SOURCE' }], occurrenceIndex: 'single',
    });
    const revision = await creerOp(compte, { type: 'INTERVENTION', realized: '2026-03-10', assetIds: [clio.id], fileId: f.id, label: 'Révision 60 000 km' });
    expect(await projeter(compte, [revision])).toMatchObject({ linked: 1, markedDone: 1, created: 0 });
    expect((await items(compte)).find((i) => i.id === t4.id)).toMatchObject({ op: revision, manual_status: 'realise', title: 'Révision', start_date: '2026-03-08' });
    expect((await projeter(compte, [revision])).changes).toBe(0);
  });

  it('O7-E06 / C16-11 — sinistre historique créé par T4 depuis le constat : lié au sinistre (même document), aucun second événement', async () => {
    const compte = await make.account({ plan: 'standard' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    const constat = await make.assetFile(compte, { assetId: maison.id });
    const { upsertAgendaItem } = await import('@/services/agenda/agenda-write-primitive');
    const t4 = await upsertAgendaItem({
      accountId: compte.id, assetId: maison.id, origin: 'AUTOMATIC', title: 'Sinistre — dégât des eaux', date: '2026-03-12', nature: 'HISTORICAL',
      businessType: 'claim', category: 'information', sources: [{ fileId: constat.id, role: 'SOURCE' }], occurrenceIndex: 'single',
    });
    const claim = await creerOp(compte, { type: 'CLAIM', realized: '2026-03-12', assetIds: [maison.id], fileId: constat.id });
    expect(await projeter(compte, [claim])).toMatchObject({ linked: 1, created: 0 });
    expect(await items(compte)).toEqual([expect.objectContaining({ id: t4.id, op: claim, projection_origin: null, title: 'Sinistre — dégât des eaux' })]);
  });

  it('O7-E07 / C16-12 — sinistre du formulaire (lot 44) : événement choisi lié → aucun élément projeté ; ancre historique → aucun élément ; le tiroir mène au sinistre', async () => {
    const compte = await make.account({ plan: 'standard' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    session.currentAccountId = compte.id;
    session.userId = compte.ownerUserId;
    const evt = await make.agendaItem(compte, { title: 'Fuite cuisine', startDate: '2026-03-12', assetIds: [maison.id] });
    const route = await import('@/app/api/assets/[id]/claims/route');
    const creer = async (body: Json) => {
      const r = await route.POST(new NextRequest(`http://x/api/assets/${maison.id}/claims`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
        { params: Promise.resolve({ id: String(maison.id) }) });
      return { status: r.status, body: await r.json() as Json };
    };
    const a = await creer({ claim: { claimType: 'DEGAT_DES_EAUX', occurredOn: '2026-03-12', claimEventKey: `agenda:${evt.id}` } });
    expect(a.status).toBe(201);
    const claimId = a.body.id as number;
    await projeter(compte, [claimId]);
    expect(await items(compte)).toEqual([expect.objectContaining({ id: evt.id, op: claimId, projection_origin: null })]);

    // Tiroir (desktop et mobile) : lien vers le sinistre, jamais le mot « Opération ».
    const { getAgendaItemById } = await import('@/services/agenda/AgendaQueryService');
    const full = await getAgendaItemById(evt.id, compte.id);
    expect(full!.claimSource).toEqual({ assetId: maison.id, claimId });
    expect(JSON.stringify({ title: full!.title, claimSource: full!.claimSource })).not.toMatch(/op[ée]ration/i);

    // Ancre de l'historique (events) : équivalent existant, aucun élément d'agenda créé.
    const [hist] = await sql<{ id: number }[]>`
      INSERT INTO events (account_id, user_id, asset_id, categorie, titre, date_evenement) VALUES (${compte.id}, ${compte.ownerUserId}, ${maison.id}, 'sinistre', 'Vol', '2026-05-02') RETURNING id`;
    const b = await creer({ claim: { claimType: 'VOL', occurredOn: '2026-05-02', claimEventKey: `event:${hist.id}` } });
    expect(b.status).toBe(201);
    const n = (await items(compte)).length;
    await projeter(compte, [b.body.id as number]);
    expect((await items(compte)).length).toBe(n);
  });

  it('O7-E08 / C16.1 — garde T4 : un document analysé APRÈS la projection ne crée pas de second événement', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    const facture = await make.assetFile(compte, { assetId: maison.id });
    const op = await creerOp(compte, { type: 'INTERVENTION', realized: '2026-02-14', assetIds: [maison.id], fileId: facture.id, label: 'Réparation fuite' });
    await projeter(compte, [op]);
    const { persistAgendaDecisions } = await import('@/services/agenda/agenda-persistence');
    await persistAgendaDecisions([{
      action: 'create', title: 'Intervention plombier', date: '2026-02-14', category: 'information', confidence: 'certain', reasonCode: 'NEW_EVENT',
      deterministic: true, sourceFileId: facture.id, businessType: 'repair', nature: 'HISTORICAL',
    } as never], compte.id, maison.id, { sourceFileId: facture.id, analysisComplete: true });
    const tous = await items(compte);
    expect(tous).toHaveLength(1);
    expect(tous[0]).toMatchObject({ op, projection_origin: 'OPERATION' });
  });

  // ══ Suppression utilisateur mémorisée (F-146) ═════════════════════════════

  it('F-146 / O7-E09 / C16.1 — l\'utilisateur supprime l\'événement projeté : mémorisé, jamais recréé (événement, reconsolidation, balayage) ; Opération intacte', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    const f = await make.assetFile(compte, { assetId: maison.id });
    const op = await creerOp(compte, { type: 'INTERVENTION', realized: '2026-01-20', assetIds: [maison.id], fileId: f.id, label: 'Ramonage' });
    await projeter(compte, [op]);
    const [evt] = await items(compte);
    const { deleteAgendaItem } = await agendaWrite();
    await deleteAgendaItem(evt.id, compte.id, compte.ownerUserId);
    expect(await suppressions(op)).toEqual([{ projection_key: 'INTERVENTION', user_id: compte.ownerUserId }]);
    expect(await sql`SELECT invalidated_at FROM business_operations WHERE id = ${op}`).toEqual([{ invalidated_at: null }]);
    // Reconsolidation (nouveau libellé, nouvelle date) : toujours rien.
    const { withBusinessOperationWrite } = await ecriture();
    await withBusinessOperationWrite(compte.id, (repo) => repo.updateAttributes(op, { technicalLabel: 'Ramonage annuel', realizedDate: '2026-01-21' }, 'E2E'));
    expect(await projeter(compte, [op])).toMatchObject({ suppressed: 1, created: 0, changes: 0 });
    expect(await projeter(compte)).toMatchObject({ created: 0, linked: 0 });
    expect(await items(compte)).toEqual([]);
    // Balayage horaire : le compte n'est pas repassé pour cette Opération.
    expect(await (await projection()).listAccountsNeedingProjection(10_000)).not.toContain(compte.id);
    // Un événement saisi ensuite par l'utilisateur n'est pas lié d'office non plus.
    const { createAgendaItem } = await agendaWrite();
    await createAgendaItem({ title: 'Ramonage', startDate: '2026-01-21', assetIds: [maison.id], homeCategory: 'information' }, compte.id, compte.ownerUserId);
    await projeter(compte, [op]);
    expect((await items(compte)).map((i) => i.op)).toEqual([null]);
  });

  it('O7-E10 — suppression d\'un événement LIÉ (saisi) : mémorisée aussi ; T3 demandé (déclencheur Agenda) avec corrélation', async () => {
    const compte = await make.account({ plan: 'premium' });
    const clio = await make.asset(compte, { category: 'VEHICULE' });
    const { createAgendaItem, deleteAgendaItem } = await agendaWrite();
    const manuel = await createAgendaItem({ title: 'Achat Clio', startDate: '2021-03-01', assetIds: [clio.id], homeCategory: 'information' }, compte.id, compte.ownerUserId);
    const achat = await creerOp(compte, { type: 'ACQUISITION', realized: '2021-03-01', assetIds: [clio.id] });
    await projeter(compte, [achat]);
    await deleteAgendaItem(manuel.id, compte.id, compte.ownerUserId);
    expect(await suppressions(achat)).toEqual([{ projection_key: 'ACQUISITION', user_id: compte.ownerUserId }]);
    await projeter(compte, [achat]);
    expect(await items(compte)).toEqual([]);
    const job = await attendreJobT3(compte, 'agenda_changed');
    expect(job).toMatchObject({ trigger_code: 'asset_updated' });
  });

  // ══ Anti-boucle (C16.2, F-145) ════════════════════════════════════════════

  async function jobsT3(compte: AccountRow) {
    return sql<{ id: number; target_type: string; trigger_code: string | null; payload: Json }[]>`
      SELECT id, target_type, trigger_code, payload FROM ai_job_queue WHERE treatment = 'T3' AND account_id = ${compte.id} ORDER BY id`;
  }
  async function attendreJobT3(compte: AccountRow, trigger: string) {
    for (let i = 0; i < 40; i++) {
      const j = (await jobsT3(compte)).find((x) => x.target_type === 'business_operations'
        && ((x.payload.events as Array<{ trigger: string }> | undefined) ?? []).some((e) => e.trigger === trigger));
      if (j) return j;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }

  it('F-145 / O7-E11 — boucle « achat » : agenda → acquisitionDate → asset_updated → T3 → ACQUISITION → projection LIE l\'événement et s\'arrête', async () => {
    const compte = await make.account({ plan: 'premium' });
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const { createAgendaItem, updateAgendaItem } = await agendaWrite();
    // 1. Événement « achat » réalisé saisi par l'utilisateur → date d'acquisition recopiée (D-13) → TRG-008.
    const achatEvt = await createAgendaItem({ title: 'Achat', startDate: '2024-05-01', manualStatus: 'realise', assetIds: [clio.id], homeCategory: 'information' }, compte.id, compte.ownerUserId);
    const kc = (await sql<{ kc: Json | null }[]>`SELECT key_characteristics AS kc FROM assets WHERE id = ${clio.id}`)[0].kc;
    expect(JSON.stringify(kc)).toContain('2024-05-01');
    expect(await attendreJobT3(compte, 'asset_updated')).not.toBeNull();
    // 2. T3 (moteur de production) : ACQUISITION depuis la fiche ; événements publiés après commit.
    (await fileProjection()).registerOperationAgendaProjection();
    const { consolidateAssetData } = await import('@/services/business-operations/consolidation/asset-data-consolidator');
    const r1 = await consolidateAssetData(compte.id, clio.id, { today: AUJOURDHUI });
    const acq = r1.natures.find((n) => n.nature === 'ACQUISITION')!.operationId!;
    expect(acq).toBeGreaterThan(0);
    // L'abonné du bus a mis la projection en file (un travail par compte).
    const proj = (await jobsT3(compte)).filter((j) => j.target_type === 'business_operations_agenda');
    expect(proj).toHaveLength(1);
    expect(proj[0].payload.events).toEqual([expect.objectContaining({ operationIds: [acq] })]);
    // 3. Projection (exécutant de file) : l'événement saisi est LIÉ, rien n'est créé ni réécrit.
    const t3Avant = (await jobsT3(compte)).filter((j) => j.target_type === 'business_operations').length;
    const { runAgendaProjectionJob } = await fileProjection();
    const res = await runAgendaProjectionJob({ id: proj[0].id } as never, {
      kind: 'business_operations_agenda', accountId: compte.id, events: proj[0].payload.events as never, requestedAt: null,
    }, { assertActive: async () => {} } as never);
    expect(res.result).toBe('APPLIED');
    expect(await items(compte)).toEqual([expect.objectContaining({ id: achatEvt.id, op: acq, title: 'Achat', start_date: '2024-05-01', projection_origin: null })]);
    // 4. Aucune nouvelle demande T3 issue de la projection ; T3 rejoué : 0 changement ; projection rejouée : no-op.
    await new Promise((r) => setTimeout(r, 200));
    expect((await jobsT3(compte)).filter((j) => j.target_type === 'business_operations').length).toBe(t3Avant);
    expect((await consolidateAssetData(compte.id, clio.id, { today: AUJOURDHUI })).changes).toBe(0);
    expect((await projeter(compte, [acq])).changes).toBe(0);
    // 5. Correction utilisateur de l'événement lié : T3 demandé (déclencheur Agenda), la fiche n'est pas réécrite, la projection ne touche pas au texte de l'utilisateur.
    await updateAgendaItem(achatEvt.id, { startDate: '2024-05-03' }, compte.id);
    const j = await attendreJobT3(compte, 'agenda_changed');
    expect(j).not.toBeNull();
    expect((j!.payload.events as Array<{ trigger: string; agendaItemId?: number; correlationId?: string }>).find((e) => e.trigger === 'agenda_changed'))
      .toMatchObject({ agendaItemId: achatEvt.id, correlationId: expect.stringMatching(/^agenda:/) });
    expect(JSON.stringify((await sql<{ kc: Json | null }[]>`SELECT key_characteristics AS kc FROM assets WHERE id = ${clio.id}`)[0].kc)).not.toContain('2024-05-03');
    expect((await projeter(compte, [acq])).changes).toBe(0);
    expect((await items(compte))[0]).toMatchObject({ start_date: '2024-05-03', title: 'Achat' });
  });

  it('F-145 / O7-E12 — mise à jour d\'un événement projeté par la projection : aucun déclencheur T3 ; geste utilisateur sans changement : aucun non plus', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    const f = await make.assetFile(compte, { assetId: maison.id });
    const op = await creerOp(compte, { type: 'INTERVENTION', status: 'ENVISAGED', planned: plus(15), assetIds: [maison.id], fileId: f.id, label: 'Élagage' });
    await projeter(compte, [op]);
    const { withBusinessOperationWrite } = await ecriture();
    await withBusinessOperationWrite(compte.id, (repo) => repo.updateAttributes(op, { plannedDate: plus(16) }, 'E2E'));
    expect(await projeter(compte, [op])).toMatchObject({ updated: 1 });
    const [evt] = await items(compte);
    expect(evt.start_date).toBe(plus(16));
    const { updateAgendaItem } = await agendaWrite();
    await updateAgendaItem(evt.id, { title: evt.title }, compte.id);
    await new Promise((r) => setTimeout(r, 200));
    expect((await jobsT3(compte)).filter((j) => j.target_type === 'business_operations')).toEqual([]);
  });

  // ══ Cycle de vie : invalidation, fusion, transfert, suppression de bien ═══

  it('C22 / O7-E13 — Opération invalidée : projection retirée (tracée) ; fusion : un seul événement sur la canonique', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    const f1 = await make.assetFile(compte, { assetId: maison.id });
    const f2 = await make.assetFile(compte, { assetId: maison.id });
    const a = await creerOp(compte, { type: 'INTERVENTION', realized: '2026-02-01', assetIds: [maison.id], fileId: f1.id, label: 'Peinture' });
    const c = await creerOp(compte, { type: 'INTERVENTION', realized: '2026-02-01', assetIds: [maison.id], fileId: f2.id, label: 'Peinture salon' });
    await projeter(compte, [a]);
    // c : l'événement de a est lié à une autre Opération active → c crée le sien.
    await projeter(compte, [c]);
    expect((await items(compte)).map((i) => i.op).sort()).toEqual([a, c].sort());
    const { withBusinessOperationWrite } = await ecriture();
    await withBusinessOperationWrite(compte.id, (repo) => repo.mergeOperations(a, c, 'E2E'));
    await projeter(compte, [a]);
    const restants = await items(compte);
    expect(restants).toHaveLength(1);
    expect(restants[0]).toMatchObject({ op: c, functional_key: `bo:v1:${c}:INTERVENTION` });
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agenda_item_removals WHERE account_id = ${compte.id} AND reason = 'OPERATION_PROJECTION'`)[0].n).toBe(1);
    await withBusinessOperationWrite(compte.id, (repo) => repo.invalidate(c, 'E2E'));
    await projeter(compte, [c]);
    expect(await items(compte)).toEqual([]);
    expect((await projeter(compte)).changes).toBe(0);
  });

  it('O7-E14 / Q14 — transfert Duo d\'un bien : l\'Opération et son événement projeté suivent ; aucun orphelin dans le compte quitté', async () => {
    const source = await make.account({ plan: 'premium_duo' });
    const cible = await make.account({ plan: 'premium' });
    const clio = await make.asset(source, { category: 'VEHICULE' });
    const achat = await creerOp(source, { type: 'ACQUISITION', realized: '2022-09-01', assetIds: [clio.id] });
    await projeter(source, [achat]);
    const [evt] = await items(source);
    const { db } = await import('@/db');
    const { transferAssetOperationsInTx } = await import('@/services/business-operations/asset-lifecycle');
    const { transferAssetDataInTx } = await import('@/services/assets/asset-account-transfer.service');
    const { sql: dsql } = await import('drizzle-orm');
    const evts = await db.transaction(async (tx) => {
      await tx.execute(dsql`UPDATE assets SET account_id = ${cible.id} WHERE id = ${clio.id}`);
      const r = await transferAssetOperationsInTx(tx, { assetId: clio.id, fromAccountId: source.id, toAccountId: cible.id });
      await transferAssetDataInTx(tx, { assetId: clio.id, fromAccountId: source.id, toAccountId: cible.id });
      return r.events;
    });
    expect(evts.some((e) => e.previousAccountId === source.id)).toBe(true);
    await projeter(source);
    await projeter(cible);
    expect(await items(source)).toEqual([]);
    expect(await items(cible)).toEqual([expect.objectContaining({ id: evt.id, op: achat, projection_origin: 'OPERATION' })]);
    expect((await projeter(cible)).changes).toBe(0);
  });

  it('O7-E15 / B27 — suppression définitive du bien : Opération invalidée, aucune projection orpheline', async () => {
    const compte = await make.account({ plan: 'premium' });
    const garage = await make.asset(compte, { category: 'IMMOBILIER' });
    const f = await make.assetFile(compte, { assetId: garage.id });
    const op = await creerOp(compte, { type: 'INTERVENTION', realized: '2026-01-05', assetIds: [garage.id], fileId: f.id, label: 'Toiture' });
    await projeter(compte, [op]);
    const { deleteAssetCompletely } = await import('@/services/assets/asset-deletion.service');
    await deleteAssetCompletely({ id: garage.id });
    await projeter(compte, [op]);
    await projeter(compte);
    expect(await sql`SELECT id FROM agenda_items WHERE account_id = ${compte.id} AND projection_origin = 'OPERATION'`).toEqual([]);
    expect((await projeter(compte)).changes).toBe(0);
  });
});
