/**
 * Lot 103D — fiche Agenda (retours de recette iOS du 31/10) — PostgreSQL 16 réel.
 *
 * Chaînes de PRODUCTION : routes `/api/agenda`, `/api/agenda/:id`,
 * `/api/agenda/:id/liens`, `/api/home/mascot/reminders` ; primitive d'écriture
 * (canaux manuel et T4) ; service unique de regroupement (gestes, T3) ;
 * contrôles du registre de cohérence (inspection, réparation, recontrôle).
 * Aucun appel IA. Assertions limitées aux comptes créés ici.
 *
 *   L103D-E01  création : pièce sans logement rattaché refusée (409, code stable), rien n'est écrit
 *   L103D-E02  modification : retrait du dernier logement → blocage expliqué, puis dissociation confirmée ATOMIQUE et tracée
 *   L103D-E03  regroupement : rubriques et candidats limités aux logements rattachés ; geste incompatible refusé ; retrait de bien confirmé
 *   L103D-E04  IA / réconciliation : T4 et T3 n'écrivent jamais un lien incompatible (abstention tracée)
 *   L103D-E05  COH-AGENDA-STRUCTURAL-HOUSING : cas certain réparé (journal avant / après), correction manuelle préservée (Supervision)
 *   L103D-E06  COH-AGENDA-HISTORICAL-STATUS : contrôle 2020 prouvé → « Réalisé », badges levés ; sans preuve → « à confirmer » ; idempotent ; protégé
 *   L103D-E07  rappels : aucun bloc pour un fait historique ; rappel T6 existant → action et date ; l'accueil n'est pas sollicité
 */
import { expect, it, vi } from 'vitest';
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
const json = (body: unknown) => ({ body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

scenario('L103D', 'Fiche Agenda — pièces / équipements d’un logement, statut d’un fait passé, rappels', ({ sql, make }) => {
  const as = (c: Compte) => { session.userId = c.owner.id; session.currentAccountId = c.id; };

  async function bien(compte: AccountRow, category: string, subtype: string | null, name: string): Promise<AssetRow> {
    const a = await make.asset(compte, { category, name });
    await sql`UPDATE assets SET subtype = ${subtype} WHERE id = ${a.id}`;
    return a;
  }
  const piece = async (assetId: number, name: string) => (await sql<{ id: number }[]>`
    INSERT INTO substructures (asset_id, name) VALUES (${assetId}, ${name}) RETURNING id`)[0].id;
  const equipement = async (assetId: number, name: string) => (await sql<{ id: number }[]>`
    INSERT INTO equipments (asset_id, name) VALUES (${assetId}, ${name}) RETURNING id`)[0].id;

  async function contexte() {
    const compte = await make.account({ plan: 'premium' }) as Compte;
    as(compte);
    const polo = await bien(compte, 'VEHICULE', 'Voiture', 'Polo');
    const maisonA = await bien(compte, 'IMMOBILIER', 'Maison', 'Maison A');
    const appartB = await bien(compte, 'IMMOBILIER', 'Appartement', 'Appartement B');
    const maisonC = await bien(compte, 'IMMOBILIER', 'Maison', 'Maison C');
    return {
      compte, polo, maisonA, appartB, maisonC,
      cuisineA: await piece(maisonA.id, 'Cuisine A'), salonB: await piece(appartB.id, 'Salon B'), garageC: await piece(maisonC.id, 'Garage C'),
      chaudiereA: await equipement(maisonA.id, 'Chaudière A'),
    };
  }

  // ── Routes réelles ────────────────────────────────────────────────────────
  async function creer(body: Json) {
    const { POST } = await import('@/app/api/agenda/route');
    const res = await POST(new NextRequest('http://localhost/api/agenda', { method: 'POST', ...json(body) }));
    return { status: res.status, body: await res.json() as Json };
  }
  async function modifier(id: number, body: Json) {
    const { PUT } = await import('@/app/api/agenda/[id]/route');
    const res = await PUT(new NextRequest(`http://localhost/api/agenda/${id}`, { method: 'PUT', ...json(body) }), { params: Promise.resolve({ id: String(id) }) });
    return { status: res.status, body: await res.json() as Json };
  }
  async function lire(id: number) {
    const { GET } = await import('@/app/api/agenda/[id]/route');
    const res = await GET(new NextRequest(`http://localhost/api/agenda/${id}`), { params: Promise.resolve({ id: String(id) }) });
    return (await res.json() as Json).item as Json;
  }
  async function vue(itemId: number, query = '') {
    const { GET } = await import('@/app/api/agenda/[id]/liens/route');
    const res = await GET(new NextRequest(`http://localhost/api/agenda/${itemId}/liens${query}`), { params: Promise.resolve({ id: String(itemId) }) });
    return { status: res.status, body: await res.json() as Json };
  }
  async function geste(itemId: number, action: string, targetId?: number, extra: Json = {}) {
    const { POST } = await import('@/app/api/agenda/[id]/liens/route');
    const res = await POST(new NextRequest(`http://localhost/api/agenda/${itemId}/liens`, { method: 'POST', ...json({ action, targetId: targetId ?? null, ...extra }) }),
      { params: Promise.resolve({ id: String(itemId) }) });
    return { status: res.status, body: await res.json() as Json };
  }
  async function rappels(itemId: number) {
    const { GET } = await import('@/app/api/home/mascot/reminders/route');
    const res = await GET(new NextRequest(`http://localhost/api/home/mascot/reminders?agendaItemId=${itemId}`));
    return { status: res.status, body: await res.json() as Json };
  }
  const liensPieces = (itemId: number) => sql<{ id: number }[]>`SELECT substructure_id AS id FROM agenda_room_links WHERE agenda_item_id = ${itemId} ORDER BY 1`;
  const evenements = (itemId: number, type: string) => sql<{ detail: Json }[]>`
    SELECT detail_json AS detail FROM agenda_occurrence_events WHERE agenda_item_id = ${itemId} AND event_type = ${type} ORDER BY id`;
  const nbElements = async (c: AccountRow) => Number((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${c.id}`)[0].n);
  const ctxCoherence = (mode: 'DRY_RUN' | 'CORRECTIVE' = 'CORRECTIVE') => ({ sql, now: new Date(), today: '2026-11-02', mode, correlationId: `coherence:e2e:l103d:${mode}` });

  it('L103D-E01 — création : pièce sans logement rattaché refusée (409, code stable), rien n’est écrit ; logement rattaché accepté', async () => {
    const c = await contexte();
    const avant = await nbElements(c.compte);
    // Aucun bien : l'API acceptait la pièce (contrôle de cohérence sauté sans bien) — audit 103D.
    const sansBien = await creer({ title: 'Vidange', substructureIds: [c.cuisineA] });
    expect(sansBien.status).toBe(409);
    expect(sansBien.body.code).toBe('AGENDA_STRUCTURAL_LINK_INCOMPATIBLE');
    expect(sansBien.body.details).toEqual({ substructureIds: [c.cuisineA], equipmentIds: [] });
    // Polo seul : refus avec le même code (et non plus le message technique « Cohérence des liens »).
    const polo = await creer({ title: 'Vidange', assetIds: [c.polo.id], equipmentIds: [c.chaudiereA] });
    expect(polo.status).toBe(409);
    expect(polo.body.code).toBe('AGENDA_STRUCTURAL_LINK_INCOMPATIBLE');
    expect(await nbElements(c.compte)).toBe(avant);
    // Polo + Maison A : pièce de A acceptée ; pièce de la Maison C (non rattachée) refusée.
    const ok = await creer({ title: 'Entretien', assetIds: [c.polo.id, c.maisonA.id], substructureIds: [c.cuisineA], equipmentIds: [c.chaudiereA] });
    expect(ok.status).toBe(201);
    expect((await liensPieces(ok.body.item.id)).map((x) => x.id)).toEqual([c.cuisineA]);
    expect((await creer({ title: 'Entretien', assetIds: [c.maisonA.id], substructureIds: [c.garageC] })).body.code).toBe('AGENDA_STRUCTURAL_LINK_INCOMPATIBLE');
    // Maison A + Appartement B : pièces des deux.
    const deux = await creer({ title: 'Visite', assetIds: [c.maisonA.id, c.appartB.id], substructureIds: [c.cuisineA, c.salonB] });
    expect(deux.status).toBe(201);
    // Catégorie fournie à la fiche (règle d'affichage desktop et mobile).
    const fiche = await lire(ok.body.item.id);
    expect(fiche.assetLinks.map((l: Json) => [l.assetName, l.assetCategory, l.assetSubtype]).sort()).toEqual([['Maison A', 'IMMOBILIER', 'Maison'], ['Polo', 'VEHICULE', 'Voiture']]);
  });

  it('L103D-E02 — retrait du dernier logement : blocage expliqué (rien n’est écrit), puis dissociation confirmée atomique et tracée ; objets conservés', async () => {
    const c = await contexte();
    const cree = await creer({ title: 'Ramonage', assetIds: [c.polo.id, c.maisonA.id], substructureIds: [c.cuisineA], equipmentIds: [c.chaudiereA] });
    const id = cree.body.item.id as number;
    const bloque = await modifier(id, { assetIds: [c.polo.id] });
    expect(bloque.status).toBe(409);
    expect(bloque.body.code).toBe('AGENDA_HOUSING_REMOVAL_HAS_DEPENDENTS');
    expect(bloque.body.details).toEqual({ substructureIds: [c.cuisineA], equipmentIds: [c.chaudiereA] });
    // Rien n'a changé : biens et liens intacts.
    expect((await lire(id)).assetLinks).toHaveLength(2);
    expect((await liensPieces(id)).map((x) => x.id)).toEqual([c.cuisineA]);
    // Une pièce NOUVELLE incompatible n'est jamais « dissociée » : refus.
    expect((await modifier(id, { assetIds: [c.maisonA.id], substructureIds: [c.cuisineA, c.garageC], dissociateIncompatible: true })).body.code).toBe('AGENDA_STRUCTURAL_LINK_INCOMPATIBLE');
    const confirme = await modifier(id, { assetIds: [c.polo.id], dissociateIncompatible: true });
    expect(confirme.status).toBe(200);
    const fiche = await lire(id);
    expect(fiche.assetLinks.map((l: Json) => l.assetId)).toEqual([c.polo.id]);
    expect(fiche.roomLinks).toEqual([]);
    expect(fiche.equipmentLinks).toEqual([]);
    // Pièce et équipement conservés ; trace avant / après.
    expect((await sql`SELECT 1 FROM substructures WHERE id = ${c.cuisineA}`).length).toBe(1);
    expect((await sql`SELECT 1 FROM equipments WHERE id = ${c.chaudiereA}`).length).toBe(1);
    const [trace] = await evenements(id, 'STRUCTURAL_LINKS_DISSOCIATED');
    expect(trace.detail).toMatchObject({ reason: 'USER_CONFIRMED_HOUSING_REMOVAL', removed: { roomIds: [c.cuisineA], equipmentIds: [c.chaudiereA] }, after: { roomIds: [], equipmentIds: [] } });
  });

  it('L103D-E03 — regroupement : catégories et candidats limités aux logements rattachés ; geste incompatible refusé sans écriture ; retrait de bien confirmé', async () => {
    const c = await contexte();
    const a = await make.agendaItem(c.compte, { title: 'Sinistre Polo', startDate: '2026-03-12', assetIds: [c.polo.id] });
    const b = await make.agendaItem(c.compte, { title: 'Expertise', startDate: '2026-03-20' });
    expect((await geste(a.id, 'relier-element', b.id)).status).toBe(200);
    expect((await geste(a.id, 'designer-reference')).status).toBe(200);
    expect((await geste(a.id, 'relier-bien', c.polo.id)).status).toBe(200);
    let v = (await vue(a.id)).body.view as Json;
    expect(v.role).toBe('MAIN');
    expect(v.structuralScope).toEqual({ allowed: false, housingAssetIds: [] });
    expect((await vue(a.id, '?candidats=pieces&q=')).body.candidates).toEqual([]);
    expect((await vue(a.id, '?candidats=equipements&q=')).body.candidates).toEqual([]);
    // Appel direct (sélecteur contourné) : refus, code stable, rien n'est écrit.
    const refus = await geste(a.id, 'relier-piece', c.cuisineA);
    expect(refus.status).toBe(409);
    expect(refus.body.code).toBe('AGENDA_STRUCTURAL_LINK_INCOMPATIBLE');
    expect((await sql`SELECT 1 FROM business_operation_room_links WHERE substructure_id = ${c.cuisineA}`).length).toBe(0);
    // Maison A rattachée : seulement ses pièces (jamais celles de la Maison C du compte).
    expect((await geste(a.id, 'relier-bien', c.maisonA.id)).status).toBe(200);
    v = (await vue(a.id)).body.view as Json;
    expect(v.structuralScope).toEqual({ allowed: true, housingAssetIds: [c.maisonA.id] });
    expect((await vue(a.id, '?candidats=pieces&q=')).body.candidates.map((x: Json) => x.id)).toEqual([c.cuisineA]);
    expect((await geste(a.id, 'relier-piece', c.cuisineA)).status).toBe(200);
    expect((await geste(a.id, 'relier-piece', c.garageC)).body.code).toBe('AGENDA_STRUCTURAL_LINK_INCOMPATIBLE');
    // Retrait de la Maison A : blocage expliqué, puis dissociation confirmée (même transaction).
    const bloque = await geste(a.id, 'retirer-bien', c.maisonA.id);
    expect(bloque.status).toBe(409);
    expect(bloque.body.code).toBe('AGENDA_HOUSING_REMOVAL_HAS_DEPENDENTS');
    expect(bloque.body.details).toEqual({ substructureIds: [c.cuisineA], equipmentIds: [] });
    expect((await sql`SELECT 1 FROM business_operation_room_links WHERE substructure_id = ${c.cuisineA} AND active`).length).toBe(1);
    const ok = await geste(a.id, 'retirer-bien', c.maisonA.id, { dissocier: true });
    expect(ok.status).toBe(200);
    expect(ok.body.view.structuralScope.allowed).toBe(false);
    expect(ok.body.view.ensemble.rooms).toEqual([]);
    expect((await sql`SELECT 1 FROM substructures WHERE id = ${c.cuisineA}`).length).toBe(1);
  });

  it('L103D-E04 — IA / réconciliation : T4 et T3 n’écrivent jamais un lien incompatible (abstention tracée, aucun logement ajouté)', async () => {
    const c = await contexte();
    const item = await make.agendaItem(c.compte, { title: 'Contrôle', startDate: '2026-05-01', assetIds: [c.polo.id] });
    const { upsertAgendaItem } = await import('@/services/agenda/agenda-write-primitive');
    await upsertAgendaItem({ itemId: item.id, accountId: c.compte.id, assetId: null, origin: 'AUTOMATIC', target: { type: 'ROOM', id: c.cuisineA } });
    expect(await liensPieces(item.id)).toEqual([]);
    expect((await sql`SELECT asset_id FROM agenda_asset_links WHERE agenda_item_id = ${item.id}`).map((x) => x.asset_id)).toEqual([c.polo.id]);
    // T3 : abstention sur un ensemble sans logement.
    const a = await make.agendaItem(c.compte, { title: 'A', assetIds: [c.polo.id] });
    const b = await make.agendaItem(c.compte, { title: 'B' });
    await geste(a.id, 'relier-element', b.id);
    const op = Number((await sql<{ op: number }[]>`SELECT business_operation_id AS op FROM agenda_items WHERE id = ${a.id}`)[0].op);
    const { withGroupingWrite, attachRoom, attachEquipment } = await import('@/services/business-operations/grouping/service');
    const r = await withGroupingWrite(c.compte.id, async (g) => ({
      room: await attachRoom(g, { operationId: op, substructureId: c.cuisineA, origin: 'T3', reasonCode: 'T3_TARGET_LINKED' }),
      equip: await attachEquipment(g, { operationId: op, equipmentId: c.chaudiereA, origin: 'T3', reasonCode: 'T3_TARGET_LINKED' }),
    }));
    expect(r).toEqual({ room: { changed: false, skipped: 'HOUSING_NOT_LINKED' }, equip: { changed: false, skipped: 'HOUSING_NOT_LINKED' } });
    expect((await sql`SELECT 1 FROM business_operation_room_links WHERE operation_id = ${op}`).length).toBe(0);
    expect((await sql`SELECT 1 FROM business_operation_equipment_links WHERE operation_id = ${op}`).length).toBe(0);
  });

  it('L103D-E05 — COH-AGENDA-STRUCTURAL-HOUSING : à blanc d’abord, cas certain réparé (journal), correction manuelle préservée (Supervision)', async () => {
    const c = await contexte();
    // Historique : élément AUTOMATIQUE lié à Polo seulement, avec la cuisine de la Maison A (lien hérité).
    const auto = (await sql<{ id: number }[]>`INSERT INTO agenda_items (account_id, title, start_date, is_automatic) VALUES (${c.compte.id}, 'Révision', '2025-04-01', true) RETURNING id`)[0].id;
    await sql`INSERT INTO agenda_asset_links (agenda_item_id, asset_id) VALUES (${auto}, ${c.polo.id})`;
    await sql`INSERT INTO agenda_room_links (agenda_item_id, substructure_id) VALUES (${auto}, ${c.cuisineA})`;
    // Élément SAISI par l'utilisateur, même incohérence : jamais corrigé automatiquement.
    const manuel = await make.agendaItem(c.compte, { title: 'Mon rappel', assetIds: [c.polo.id] });
    await sql`INSERT INTO agenda_room_links (agenda_item_id, substructure_id) VALUES (${manuel.id}, ${c.cuisineA})`;
    const { agendaStructuralHousingCheck: chk } = await import('@/services/coherence/registry/checks/agenda-structural-housing');
    const ids = await chk.listObjects!(ctxCoherence('DRY_RUN') as never, c.compte.id, 0, 100);
    expect(ids).toEqual([auto, manuel.id].sort((x, y) => x - y));
    const insp = await chk.inspect!(ctxCoherence('DRY_RUN') as never, c.compte.id, ids);
    expect(insp.get(auto)).toMatchObject({ verdict: 'REPAIRABLE', anomaly: 'STRUCTURAL_LINK_WITHOUT_HOUSING' });
    expect(insp.get(manuel.id)).toMatchObject({ verdict: 'FINDING', anomaly: 'STRUCTURAL_LINK_HOUSING_AMBIGUOUS' });
    // Inspection en lecture seule : rien n'a changé.
    expect((await liensPieces(auto)).length).toBe(1);
    const rep = await chk.repair!(ctxCoherence() as never, c.compte.id, [{ id: auto, inspection: insp.get(auto)! }]);
    expect(rep.get(auto)).toMatchObject({ called: true, result: { item: { roomIds: [c.cuisineA], equipmentIds: [] } } });
    expect(await liensPieces(auto)).toEqual([]);
    expect((await liensPieces(manuel.id)).length).toBe(1);
    const [trace] = await evenements(auto, 'STRUCTURAL_LINKS_DISSOCIATED');
    expect(trace.detail).toMatchObject({ origin: 'COHERENCE', before: { roomIds: [c.cuisineA] }, removed: { roomIds: [c.cuisineA] } });
    // Recontrôle : cohérent (sorti du périmètre) ; rejouer ne fait rien (idempotent).
    expect(await chk.listObjects!(ctxCoherence() as never, c.compte.id, 0, 100)).toEqual([manuel.id]);
    const re = await chk.repair!(ctxCoherence() as never, c.compte.id, [{ id: auto, inspection: insp.get(auto)! }]);
    expect(re.get(auto)).toMatchObject({ called: false });
  });

  // #715 : plus de statut d'événement — L103D-E06 (COH-AGENDA-HISTORICAL-STATUS, « Réalisé » prouvé) supprimé avec le contrôle.

  it('L103D-E07 — rappels : aucun bloc pour un fait historique ni sans décision T6 ; rappel T6 existant → action et date utile', async () => {
    const c = await contexte();
    const [h] = await sql<{ id: number }[]>`
      INSERT INTO agenda_items (account_id, title, start_date, is_automatic, event_nature, business_type)
      VALUES (${c.compte.id}, 'Contrôle réalisé — Maison', '2020-12-22', true, 'HISTORICAL', 'inspection') RETURNING id`;
    const historique = await rappels(h.id);
    expect(historique.status).toBe(200);
    expect(historique.body.relevance).toMatchObject({ visible: false, reason: 'HISTORICAL_FACT' });
    const echeance = await make.agendaItem(c.compte, { title: 'Ramonage annuel', startDate: '2026-12-15', assetIds: [c.maisonA.id] });
    expect((await rappels(echeance.id)).body.relevance).toMatchObject({ visible: false, reason: 'NO_REMINDER' });
    await sql`INSERT INTO t6_interpellation_assessments (account_id, agenda_item_id, subject_key, context_fingerprint, assessed_on, interpellation, action_needed, priority, action_date, reason, action)
              VALUES (${c.compte.id}, ${echeance.id}, ${`agenda:${echeance.id}`}, 'e2e', '2026-11-01', 'ANTICIPATE', true, 'MEDIUM', '2026-11-25', 'e2e', 'Prendre rendez-vous avec le ramoneur')`;
    expect((await rappels(echeance.id)).body.relevance).toEqual({ visible: true, reason: 'T6_REMINDER', action: 'Prendre rendez-vous avec le ramoneur', actionDate: '2026-11-25' });
  });
});
