/**
 * Lot 29 — T2 lecture de données, de bout en bout sur PostgreSQL réel :
 * `runAssistant` + PORTS RÉELS (`buildOrchestratorPorts`), T2 en master,
 * sorties modèle rejouées par la vraie passerelle (aucun réseau) — le
 * compteur `replay.calls` est le compteur d'appels LLM.
 *
 *  · ticket 13 : « numéro de série de la chaudière » / « surface de la
 *    cuisine » posés SANS assetId ni contexte de page : question →
 *    (UNDERSTAND) → résolution réelle de l'équipement / de la pièce → bien
 *    parent → lecture de CETTE entité → réponse ;
 *  · ticket 8a : adresse de « la maison » restituée, jamais transmise au
 *    modèle au tour suivant ;
 *  · ticket 8b : VIN et immatriculation EXACTS en SQL, barre de recherche ;
 *  · ticket 12 : plusieurs champs lus sur la cible résolue une fois ;
 *  · ticket 14 : findAssets / listAssets / catalogue des cibles / revalidation
 *    de clarification appliquent la même règle (ARCHIVED, TRANSMIS exclus).
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { demander, useTargetState } from '../chain';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
const session = vi.hoisted(() => ({ currentAccountId: 0, userId: 0 }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: () => new Response(null, { status: 401 }),
  },
}));

type Compte = { id: number; ownerUserId: number };
const understand = (output: Record<string, unknown>) => ({
  operationCode: 't2_understand', task: 'UNDERSTAND',
  output: { mode: 'UNDERSTAND', confidence: 'exact', requestedTopics: [], filters: {}, reason: 'e2e', ...output },
});

scenario('L29-T2', 'Lot 29 — T2 lecture de données (SQL-first, équipements, sensible, disponibilité)', ({ sql, make, useRecordings }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });
  let es: typeof import('@/services/canonical/entity-state');
  beforeAll(async () => { es = await import('@/services/canonical/entity-state'); });

  const compte = async (): Promise<Compte> => { const a = await make.account({ plan: 'premium' }); return { id: a.id, ownerUserId: a.ownerUserId }; };
  const bien = async (c: Compte, name: string, over: { category?: string; subtype?: string | null; status?: string | null; kc?: Record<string, unknown>; registration?: string | null; deleted?: boolean } = {}) => {
    const a = await make.asset({ id: c.id, ownerUserId: c.ownerUserId } as never, {
      category: over.category ?? 'VEHICULE', name, keyCharacteristics: over.kc, registrationNumber: over.registration ?? null,
    });
    await sql`UPDATE assets SET subtype = ${over.subtype ?? null}, status = ${over.status ?? 'EN_SERVICE'},
              deleted_at = CASE WHEN ${over.deleted === true} THEN now() ELSE NULL END WHERE id = ${a.id}`;
    return a;
  };
  const equipement = async (c: Compte, assetId: number, name: string, serial: string | null, type = 'BOILER') => {
    const [e] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name, type) VALUES (${assetId}, ${name}, ${type}) RETURNING id`;
    if (serial) await es.writeCanonicalEntityField({ target: { type: 'EQUIPMENT', id: e.id }, accountId: c.id, origin: 'USER', key: 'serialNumber', value: serial });
    return e.id;
  };
  const piece = async (assetId: number, name: string, area: number) => {
    const [p] = await sql<{ id: number }[]>`INSERT INTO substructures (asset_id, name, room_type, area) VALUES (${assetId}, ${name}, 'KITCHEN', ${String(area)}) RETURNING id`;
    return p.id;
  };

  it('T2EQ-E2E — chaîne complète SANS assetId injecté : question → résolution de l’équipement → bien parent → lecture de CET équipement', async () => {
    const c = await compte();
    const maison = await bien(c, 'Maison Lyon', { category: 'IMMOBILIER', subtype: 'Maison' });
    await bien(c, 'Polo', { kc: { mileage: 82000 } });
    const chaudiere = await equipement(c, maison.id, 'Chaudière', 'CH-001');
    await equipement(c, maison.id, 'Pompe à chaleur', 'PAC-002', 'HEAT_PUMP');
    const autre = await compte();
    const ailleurs = await bien(autre, 'Maison voisin', { category: 'IMMOBILIER' });
    await equipement(autre, ailleurs.id, 'Chaudière', 'AUTRUI-9');

    // 1. Compris sans modèle (vocabulaire canonique + SQL) : aucun appel LLM.
    let replay = await useRecordings([]);
    const r = await demander(c, 'Quel est le numéro de série de la chaudière ?', { pageContext: { route: '/accueil' } });
    expect(r.answer).toContain('CH-001');
    expect(r.answer).not.toMatch(/PAC-002|AUTRUI/);
    expect(r.sources.map((s) => s.id)).toEqual([`equipment_field:${chaudiere}:serialNumber`]);
    expect(r.cascade?.aiCalls).toBe(0);
    expect(replay.calls).toHaveLength(0);
    expect(r.contextUpdate).toMatchObject({ type: 'equipment', id: chaudiere });

    // 2. Compris par UNDERSTAND : l'indice `equipment` est CONSERVÉ jusqu'à la lecture.
    replay = await useRecordings([understand({ intent: 'ACCOUNT_FACT_ASSET', entityHints: [{ type: 'equipment', value: 'la chaudière' }], requestedFacts: ['serialNumber'] })]);
    const u = await demander(c, 'Le n° de série de la chaudière, tu l’as ?');
    expect(replay.calls.map((x) => x.task)).toEqual(['UNDERSTAND']);
    expect(u.answer).toContain('CH-001');
    expect(u.answer).not.toContain('PAC-002');

    // 3. Pièce (sous-structure) : surface de la cuisine, via UNDERSTAND, sans contexte.
    await piece(maison.id, 'Cuisine', 14);
    replay = await useRecordings([understand({ intent: 'ACCOUNT_FACT_ASSET', entityHints: [{ type: 'room', value: 'la cuisine' }], requestedFacts: ['roomArea'] })]);
    const p = await demander(c, 'Quelle est la surface de la cuisine ?');
    expect(p.answer).toMatch(/Cuisine : 14 m/);
    expect(replay.calls.map((x) => x.task)).toEqual(['UNDERSTAND']);

    // 4. Équipement inexistant : non identifié, jamais un bien nommé « chaudière ».
    const vide = await compte();
    await bien(vide, 'Polo');
    await useRecordings([understand({ intent: 'ACCOUNT_FACT_ASSET', entityHints: [{ type: 'equipment', value: 'la chaudière' }], requestedFacts: ['serialNumber'] })]);
    const n = await demander(vide, 'Le n° de série de la chaudière, tu l’as ?');
    expect(n.cascade?.diagnostic).toBe('TARGET_NOT_FOUND');
  });

  it('T2SENS-E2E — adresse de « la maison » : restituée sans modèle, jamais recopiée dans le prompt du tour suivant', async () => {
    const c = await compte();
    await bien(c, 'Maison de Bourg', { category: 'IMMOBILIER', subtype: 'Maison', kc: { address1: '12 rue des Lilas', postalCode: '01000', city: 'Bourg-en-Bresse' } });
    await bien(c, 'Polo');
    let replay = await useRecordings([]);
    const r = await demander(c, 'À quelle adresse se situe la maison ?');
    expect(r.answer).toContain('12 rue des Lilas, 01000 Bourg-en-Bresse');
    expect(replay.calls).toHaveLength(0);
    expect(r.conversationId).toBeTruthy();
    const [claim] = await sql<{ claim_key: string }[]>`
      SELECT c.claim_key FROM verebona_message_claims c JOIN verebona_messages m ON m.id = c.message_id
       WHERE m.conversation_id = ${r.conversationId!} ORDER BY c.id DESC LIMIT 1`;
    expect(claim.claim_key).toBe('field:address1');
    const [run] = await sql<{ j: unknown }[]>`SELECT retrieval_methods_json AS j FROM verebona_request_runs WHERE request_id = ${r.requestId}`;
    expect(JSON.stringify(run?.j ?? {})).not.toContain('Lilas');
    // Tour suivant compris par le modèle : le contexte transmis ne porte pas l'adresse.
    replay = await useRecordings([understand({ intent: 'UNKNOWN', entityHints: [], requestedFacts: [] })]);
    await demander(c, 'blorg fizz ?', { conversationId: r.conversationId });
    expect(replay.calls).toHaveLength(1);
    expect(replay.calls[0].prompt).not.toContain('Lilas');
    expect(replay.calls[0].prompt).toContain('donnée protégée');
  });

  it('T2SQL-E2E — VIN et immatriculation EXACTS en SQL (normalisée, sans approximation), barre de recherche SQL-first', async () => {
    const c = await compte();
    const p3008 = await bien(c, 'Peugeot 3008', { kc: { vin: 'VF3MCYHZRML012345', mileage: 40000 } });
    const polo = await bien(c, 'Polo', { registration: 'AB-123-CD', kc: { registrationNumber: 'AB-123-CD', mileage: 82000 } });
    const { findVehiclesByIdentifier } = await import('@/services/verebona-assistant/core/target-lookup.repository');
    expect((await findVehiclesByIdentifier(c.id, { plates: [], vins: ['VF3MCYHZRML012345'] })).map((v) => v.id)).toEqual([p3008.id]);
    expect((await findVehiclesByIdentifier(c.id, { plates: ['AB123CD'], vins: [] })).map((v) => v.id)).toEqual([polo.id]);
    expect(await findVehiclesByIdentifier(c.id, { plates: ['AB123CE'], vins: ['VF3MCYHZRML012346'] })).toEqual([]);
    const replay = await useRecordings([]);
    for (const q of ['Quel est le kilométrage du VF3MCYHZRML012345 ?', 'Quel est le kilométrage du véhicule ab 123 cd ?']) {
      const r = await demander(c, q);
      expect(r.answer).toMatch(q.includes('VF3') ? /40\s000 km/ : /82\s000 km/);
    }
    expect(replay.calls).toHaveLength(0);
    session.currentAccountId = c.id; session.userId = c.ownerUserId;
    const { GET } = await import('@/app/api/search/route');
    const { NextRequest } = await import('next/server');
    const res = await GET(new NextRequest('http://x/api/search?q=VF3MCYHZRML012345'));
    const body = await res.json() as { results: Array<{ id: string }> };
    expect(body.results[0].id).toBe(`asset-${p3008.id}`);
  });

  it('T2MULTI-E2E — plusieurs champs (UNDERSTAND) lus sur la cible résolue une fois, sans appel ANSWER', async () => {
    const c = await compte();
    const polo = await bien(c, 'Polo', { kc: { acquisitionDate: '2021-06-15', acquisitionPrice: 18500, mileage: 82000 } });
    const replay = await useRecordings([understand({ intent: 'ACCOUNT_FACT_ASSET', entityHints: [{ type: 'asset', value: 'Polo' }], requestedFacts: ['acquisitionDate', 'acquisitionPrice', 'mileage'] })]);
    const r = await demander(c, 'Donne-moi la date d’achat, le prix et le kilométrage de la Polo.');
    expect(replay.calls.map((x) => x.task)).toEqual(['UNDERSTAND']);
    expect(r.answer.replace(/[  ]/g, ' ')).toBe('Pour Polo : date d’achat : 15 juin 2021 ; prix d’achat : 18 500 € ; kilométrage : 82 000 km.');
    expect(r.sources.map((s) => s.id).sort()).toEqual([`asset_field:${polo.id}:acquisitionDate`, `asset_field:${polo.id}:acquisitionPrice`, `asset_field:${polo.id}:mileage`].sort());
  });

  it('T2ARCH-E2E — findAssets / listAssets / catalogue / revalidation : même règle (ARCHIVED, TRANSMIS, supprimé exclus ; autres statuts gardés)', async () => {
    const c = await compte();
    const ids: Record<string, number> = {};
    // Statuts admis par la contrainte réelle `assets_status_check` (0057, 0121) : les
    // statuts « dégradés » du modèle (EN_PANNE, EN_REPARATION, INACTIF) n'existent pas
    // en base ; leurs équivalents stockés (EN_MAINTENANCE, HORS_SERVICE) restent accessibles.
    for (const [st, del] of [['EN_SERVICE', false], ['EN_MAINTENANCE', false], ['HORS_SERVICE', false], ['ARCHIVED', false], ['TRANSMIS', false], ['EN_SERVICE', true]] as const) {
      ids[`${st}${del ? '_DEL' : ''}`] = (await bien(c, `Polo ${st.toLowerCase()}${del ? ' sup' : ''}`, { status: st, deleted: del, kc: { mileage: 1000 } })).id;
    }
    const { accountDataRepository } = await import('@/services/verebona-assistant/core/account-data.repository');
    const trouves = (await accountDataRepository.findAssets(c.id, ['polo'])).map((a) => a.id).sort((a, b) => a - b);
    const listes = (await accountDataRepository.listAssets(c.id)).map((a) => a.id);
    const attendus = [ids.EN_SERVICE, ids.EN_MAINTENANCE, ids.HORS_SERVICE].sort((a, b) => a - b);
    expect(trouves).toEqual(attendus);
    expect(trouves.every((id) => listes.includes(id))).toBe(true);
    const { listAvailableAssets } = await import('@/services/verebona-assistant/core/target-lookup.repository');
    expect((await listAvailableAssets(c.id)).map((a) => a.id).sort((a, b) => a - b)).toEqual(attendus);
    const { candidatToujoursValide } = await import('@/services/verebona-assistant/core/clarification.service');
    expect(await candidatToujoursValide(c.id, 'asset', { id: `asset_${ids.ARCHIVED}`, entityId: ids.ARCHIVED, label: 'x' })).toBe(false);
    expect(await candidatToujoursValide(c.id, 'asset', { id: `asset_${ids.TRANSMIS}`, entityId: ids.TRANSMIS, label: 'x' })).toBe(false);
    expect(await candidatToujoursValide(c.id, 'asset', { id: `asset_${ids.HORS_SERVICE}`, entityId: ids.HORS_SERVICE, label: 'x' })).toBe(true);
    // Bout en bout : une Polo active + une Polo archivée de même nom → la Polo active, sans clarification.
    const d = await compte();
    await bien(d, 'Polo', { kc: { mileage: 82000 } });
    await bien(d, 'Polo', { status: 'ARCHIVED', kc: { mileage: 150000 } });
    const replay = await useRecordings([]);
    const r = await demander(d, 'Quel est le kilométrage de la Polo ?');
    expect(r.clarification).toBeNull();
    expect(r.answer).toMatch(/82\s000 km/);
    expect(replay.calls).toHaveLength(0);
    // Page d'un bien archivé : rejetée, aucune lecture.
    const arch = await bien(d, 'Clio', { status: 'ARCHIVED', kc: { mileage: 5 } });
    const pg = await demander(d, 'Quel est son kilométrage ?', { pageContext: { assetId: String(arch.id), route: `/assets/${arch.id}` } });
    expect(pg.cascade?.diagnostic).toBe('TARGET_UNAVAILABLE');
  });
});
