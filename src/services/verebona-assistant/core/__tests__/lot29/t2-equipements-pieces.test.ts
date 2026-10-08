/**
 * Lot 29 — ticket 13 : cibles `equipment` et `room` résolues RÉELLEMENT
 * (plus de rabattement sur `asset`), bien parent conservé, lecture de CETTE
 * entité par `readCanonicalEntityField`, source `equipment_field:<id>:<clé>`.
 *
 * Sans base : résolution réelle, orchestrateur réel, lectures injectées
 * (mêmes règles que leur fiche : compte, équipement non archivé, bien parent
 * disponible). La chaîne complète sur PostgreSQL réel, SANS assetId injecté,
 * est dans `src/test/e2e/scenarios/l29-t2-lecture-donnees.e2e.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const unsafe = vi.fn(async (_sql: string, _params?: unknown[]) => [] as unknown[]);
vi.mock('@/db', () => ({ pgClient: { unsafe: (sql: string, params?: unknown[]) => unsafe(sql, params) }, db: {}, ensureMigrations: vi.fn(), ensureUnaccent: vi.fn() }));

const H = await import('./harness');
const { inputDeReprise } = await import('../../clarification.service');
const { runAssistant } = await import('../../assistant-orchestrator.service');
const { findEntitiesByTerms } = await import('../../target-lookup.repository');
const { toT2Understanding } = await import('@/services/ai/assistant/master/t2-understand');
const { parseEntityRef } = await import('../../entity-ref');

beforeEach(() => unsafe.mockClear());

const MAISON = { id: 1, name: 'Maison', category: 'IMMOBILIER', subtype: 'Maison' };
const CHAUDIERE = { kind: 'equipment' as const, id: 72, assetId: 1, name: 'Chaudière', type: 'BOILER', fields: { serialNumber: 'CH-001', warrantyEndDate: '2031-03-01' } };
const PAC = { kind: 'equipment' as const, id: 73, assetId: 1, name: 'Pompe à chaleur', type: 'HEAT_PUMP', fields: { serialNumber: 'PAC-002' } };
const entite = (h: ReturnType<typeof H.harness>) => h.readers.calls.filter((c) => c.kind === 'EQUIPMENT' || c.kind === 'ROOM');

describe('Ticket 13 — équipements et pièces, cibles à part entière', () => {
  it('T2EQ-AC01 — équipement unique hors contexte (accueil) : numéro de série de la chaudière, sans contexte ni modèle', async () => {
    const h = H.harness(H.account({ assets: [MAISON], entities: [CHAUDIERE] }));
    const r = await h.ask('Quel est le numéro de série de la chaudière ?', { pageContext: { route: '/accueil' } });
    expect(r.answer).toContain('CH-001');
    expect(entite(h)).toEqual([{ kind: 'EQUIPMENT', id: 72, key: 'serialNumber' }]);
    expect(h.llmCalls()).toBe(0);
    // Même chaîne quand la question n'est comprise QUE par UNDERSTAND (indice `equipment` conservé).
    const u = toT2Understanding({ mode: 'UNDERSTAND', intent: 'ACCOUNT_FACT_ASSET', confidence: 'exact', reason: '',
      entityHints: [{ type: 'equipment', value: 'la chaudière' }], requestedFacts: ['serialNumber'], requestedTopics: [], filters: {} });
    expect(u.plan.entityHints).toEqual([{ type: 'equipment', value: 'la chaudière' }]);
    const h2 = H.harness(H.account({ assets: [MAISON], entities: [CHAUDIERE] }), {
      understand: H.understood('ACCOUNT_FACT_ASSET', u.requestedFacts, u.plan.entityHints),
    });
    const r2 = await h2.ask('Le n° de série de la chaudière, tu l’as ?');
    expect(h2.classify).toHaveBeenCalledTimes(1);
    expect(r2.answer).toContain('CH-001');
    expect(h2.generate).not.toHaveBeenCalled();
  });

  it('T2EQ-AC02 — pièce unique hors contexte : surface de la cuisine', async () => {
    const h = H.harness(H.account({ assets: [MAISON], entities: [{ kind: 'room', id: 5, assetId: 1, name: 'Cuisine', fields: { roomArea: 14 } }] }), {
      understand: H.understood('ACCOUNT_FACT_ASSET', ['roomArea'], [{ type: 'room', value: 'la cuisine' }]),
    });
    const r = await h.ask('Quelle est la surface de la cuisine ?');
    expect(r.answer).toMatch(/Cuisine : 14 m/);
    expect(entite(h)).toEqual([{ kind: 'ROOM', id: 5, key: 'roomArea' }]);
    expect(h.generate).not.toHaveBeenCalled();
  });

  it('T2EQ-AC03 — contexte du bien : la page FILTRE la recherche de l’enfant (chaudière de Maison Lyon, sans clarification)', async () => {
    const acc = H.account({
      assets: [{ ...MAISON, id: 1, name: 'Maison Lyon' }, { ...MAISON, id: 2, name: 'Maison Annecy' }],
      entities: [{ ...CHAUDIERE, id: 72, assetId: 1, fields: { serialNumber: 'LYON-1' } }, { ...CHAUDIERE, id: 82, assetId: 2, fields: { serialNumber: 'ANNECY-2' } }],
    });
    const h = H.harness(acc);
    const r = await h.ask('Quel est le numéro de série de la chaudière ?', { pageContext: { assetId: '1', route: '/assets/1' } });
    expect(r.clarification).toBeNull();
    expect(r.answer).toContain('LYON-1');
    expect(r.answer).not.toContain('ANNECY-2');
  });

  it('T2EQ-AC04 — même équipement sur deux biens sans contexte : clarification avec les parents, reprise sur l’équipement choisi', async () => {
    const acc = H.account({
      assets: [{ ...MAISON, id: 1, name: 'Maison Lyon' }, { ...MAISON, id: 2, name: 'Maison Annecy' }],
      entities: [{ ...CHAUDIERE, id: 72, assetId: 1, fields: { serialNumber: 'LYON-1' } }, { ...CHAUDIERE, id: 82, assetId: 2, fields: { serialNumber: 'ANNECY-2' } }],
    });
    const h = H.harness(acc);
    const r = await h.ask('Quel est le numéro de série de la chaudière ?');
    const c = r.clarification!;
    expect(c.question).toBe('De quel « Chaudière » parlez-vous ?');
    expect(c.candidateType).toBe('equipment');
    expect(c.candidates.map((x) => [x.label, x.secondaryLabel, x.entityId, x.assetId])).toEqual([
      ['Chaudière', 'Maison Lyon', 72, 1], ['Chaudière', 'Maison Annecy', 82, 2],
    ]);
    expect(c.resolvedContext?.requestedFacts).toEqual(['serialNumber']);
    expect(entite(h)).toEqual([]);
    // Reprise : entityType = equipment, entityId, assetId conservés ; demande ORIGINALE reprise.
    const reprise = inputDeReprise({ accountId: 1, userId: 7, planType: 'PREMIUM', locale: 'fr-FR' }, c, c.candidates[1]);
    expect(reprise.resume?.entity).toEqual({ type: 'equipment', id: 82, assetId: 2 });
    const suite = await runAssistant(reprise, h.ports);
    expect(suite.answer).toContain('ANNECY-2');
    expect(suite.answer).not.toContain('LYON-1');
    expect(h.llmCalls()).toBe(0);
  });

  it('T2EQ-AC05 — plusieurs équipements différents dans le même bien : uniquement CH-001', async () => {
    const h = H.harness(H.account({ assets: [MAISON], entities: [CHAUDIERE, PAC] }));
    const r = await h.ask('Quel est le numéro de série de la chaudière ?');
    expect(r.answer).toContain('CH-001');
    expect(r.answer).not.toContain('PAC-002');
    expect(entite(h)).toEqual([{ kind: 'EQUIPMENT', id: 72, key: 'serialNumber' }]);
  });

  it('T2EQ-AC06 — plusieurs pièces similaires : clarification, aucune pièce choisie arbitrairement', async () => {
    const h = H.harness(H.account({ assets: [MAISON], entities: [
      { kind: 'room', id: 5, assetId: 1, name: 'Chambre parentale', fields: { roomArea: 16 } },
      { kind: 'room', id: 6, assetId: 1, name: 'Chambre enfant', fields: { roomArea: 11 } },
    ] }), { understand: H.understood('ACCOUNT_FACT_ASSET', ['roomArea'], [{ type: 'room', value: 'la chambre' }]) });
    const r = await h.ask('Quelle est la surface de la chambre ?');
    expect(r.clarification?.candidateType).toBe('room');
    expect(r.clarification?.question).toBe('De quelle pièce parlez-vous ?');
    expect(r.clarification?.candidates.map((x) => x.entityId)).toEqual([5, 6]);
    expect(entite(h)).toEqual([]);
  });

  it('T2EQ-AC07 — nom explicite : surface de la chambre parentale, lecture directe', async () => {
    const h = H.harness(H.account({ assets: [MAISON], entities: [
      { kind: 'room', id: 5, assetId: 1, name: 'Chambre parentale', fields: { roomArea: 16 } },
      { kind: 'room', id: 6, assetId: 1, name: 'Chambre enfant', fields: { roomArea: 11 } },
    ] }), { understand: H.understood('ACCOUNT_FACT_ASSET', ['roomArea'], [{ type: 'room', value: 'la chambre parentale' }]) });
    const r = await h.ask('Quelle est la surface de la chambre parentale ?');
    expect(r.clarification).toBeNull();
    expect(r.answer).toMatch(/Chambre parentale : 16 m/);
    expect(entite(h)).toEqual([{ kind: 'ROOM', id: 5, key: 'roomArea' }]);
  });

  it('T2EQ-AC08 — référence conversationnelle : « Parle-moi de la chaudière » puis « Et son numéro de série ? » → même équipement', async () => {
    const acc = H.account({ assets: [MAISON], entities: [CHAUDIERE, PAC] });
    // Tour 1 : la réponse porte sur UN équipement → il devient la cible courante du fil.
    const t1 = H.harness(acc, { understand: H.understood('ACCOUNT_SEARCH_ASSET', [], [{ type: 'equipment', value: 'la chaudière' }]), retrieved: [{ id: 'equipment_72', type: 'asset_field', title: 'Chaudière', content: 'BOILER · dans Maison', relevanceScore: 0.9, meta: { equipmentId: 72, assetId: 1 } }] });
    const r1 = await t1.ask('Parle-moi de la chaudière.');
    expect(r1.contextUpdate).toEqual({ type: 'equipment', id: 72, label: 'Chaudière' });
    // Tour 2 : le fil désigne l'équipement — lu sur LUI, pas sur la PAC.
    const t2 = H.harness(acc, { thread: H.threadOn('equipment', 72, 'Chaudière') });
    const r2 = await t2.ask('Et son numéro de série ?');
    expect(r2.answer).toContain('CH-001');
    expect(r2.answer).not.toContain('PAC-002');
    expect(r2.cascade?.reference?.entity).toEqual({ type: 'equipment', id: 72 });
    const r3 = await t2.ask('Et sa date de fin de garantie ?');
    expect(r3.answer).toContain('1 mars 2031');
    expect(t2.llmCalls()).toBe(0);
  });

  it('T2EQ-AC09 — source correcte : EQUIPMENT:<id>:serialNumber (equipment_field:72:serialNumber), jamais le bien parent seul', async () => {
    const h = H.harness(H.account({ assets: [MAISON], entities: [CHAUDIERE] }));
    const r = await h.ask('Quel est le numéro de série de la chaudière ?');
    const ids = r.sources.map((s) => s.id);
    expect(ids).toEqual(['equipment_field:72:serialNumber']);
    expect(ids).not.toContain('asset_field:1:serialNumber');
    expect(r.claims).toEqual([expect.objectContaining({ claimKey: 'field:serialNumber', sourceIds: ['equipment_field:72:serialNumber'] })]);
    expect(parseEntityRef('equipment_field:72:serialNumber')).toEqual({ kind: 'equipment', id: 72, sourceId: 'equipment_field:72:serialNumber', fieldKey: 'serialNumber' });
    const lu = await (await import('../../target-answer')).readTargetForRequest({ accountId: 1, message: 'Quel est le numéro de série de la chaudière ?' },
      (await import('../../assistant-targets')).targetsFromInput({}), null, { lookup: h.lookup, readers: h.readers });
    expect(lu?.sources[0].meta).toMatchObject({ targetType: 'EQUIPMENT', targetId: 72, assetId: 1, fieldKey: 'serialNumber' });
  });

  it('T2EQ-AC10 — entité inexistante : équipement non identifié, jamais une recherche d’un BIEN nommé « chaudière »', async () => {
    const h = H.harness(H.account({ assets: [MAISON, { id: 2, name: 'Polo', category: 'VEHICULE' }] }), {
      understand: H.understood('ACCOUNT_FACT_ASSET', ['serialNumber'], [{ type: 'equipment', value: 'la chaudière' }]),
    });
    const r = await h.ask('Le n° de série de la chaudière ?');
    expect(r.answer).toMatch(/Je n’ai pas identifié l’équipement « la chaudière »/);
    expect(r.cascade?.diagnostic).toBe('TARGET_NOT_FOUND');
    expect(h.readers.calls).toEqual([]);
    expect(h.lookup.calls.entities).toBeGreaterThan(0);
  });

  it('T2EQ-AC11 — entité d’un autre compte (ou archivée) : jamais candidate ; requête bornée au compte', async () => {
    const h = H.harness(H.account({
      assets: [MAISON, { id: 9, accountId: 2, name: 'Maison voisin', category: 'IMMOBILIER' }],
      entities: [{ ...CHAUDIERE, id: 90, assetId: 9, fields: { serialNumber: 'AUTRUI-9' } }, { ...CHAUDIERE, id: 91, assetId: 1, archived: true, fields: { serialNumber: 'ARCH-1' } }],
    }), { understand: H.understood('ACCOUNT_FACT_ASSET', ['serialNumber'], [{ type: 'equipment', value: 'Chaudière' }]) });
    const r = await h.ask('Quel est le numéro de série de la chaudière ?');
    expect(r.answer).not.toMatch(/AUTRUI|ARCH-1/);
    expect(entite(h)).toEqual([]);
    await findEntitiesByTerms(1, 'equipment', ['chaudiere']);
    const sql = String(unsafe.mock.calls[0][0]);
    expect(sql).toMatch(/JOIN assets a ON a\.id = e\.asset_id AND a\.account_id = \$1/);
    expect(sql).toMatch(/e\.archived_at IS NULL/);
  });

  it('T2EQ-AC12 — aucun appel ANSWER : cible unique + champ renseigné → réponse déterministe', async () => {
    const h = H.harness(H.account({ assets: [MAISON], entities: [CHAUDIERE] }), {
      understand: H.understood('ACCOUNT_FACT_ASSET', ['serialNumber'], [{ type: 'equipment', value: 'la chaudière' }]),
    });
    await h.ask('Quel est le numéro de série de la chaudière ?');
    await h.ask('Le n° de série de la chaudière ?');
    expect(h.generate).not.toHaveBeenCalled();
  });

  it('T2EQ-AC13 — non-régression cible bien : « Quel est le kilométrage de la Polo ? » inchangé', async () => {
    const h = H.harness(H.account({ assets: [MAISON, { id: 2, name: 'Polo', category: 'VEHICULE', fields: { mileage: 82000 } }], entities: [CHAUDIERE] }));
    const r = await h.ask('Quel est le kilométrage de la Polo ?');
    expect(r.answer).toMatch(/^Kilométrage de Polo : 82\s000 km\.$/);
    expect(r.sources.map((s) => s.id)).toEqual(['asset_field:2:mileage']);
    expect(h.lookup.calls.entities).toBe(0);
  });

  it('T2EQ-AC14 — non-régression lecture agrégée : « numéros de série des équipements de la maison » → plusieurs équipements', async () => {
    const h = H.harness(H.account({ assets: [MAISON], entities: [CHAUDIERE, PAC] }), {
      understand: H.understood('ACCOUNT_FACT_ASSET', ['serialNumber'], [{ type: 'asset', value: 'la maison' }]),
    });
    const r = await h.ask('Quels sont les numéros de série des équipements de la maison ?');
    expect(r.answer).toContain('CH-001');
    expect(r.answer).toContain('PAC-002');
    expect(h.readers.calls).toContainEqual({ kind: 'asset', id: 1, key: 'serialNumber' });
  });
});
