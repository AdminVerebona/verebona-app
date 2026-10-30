/**
 * Lot 101A — continuité conversationnelle T2 (A), garde-fou de routage (B),
 * retrieval borné (C), validation objet → propriété → source → valeur (D),
 * diagnostic par tour (I). SANS BASE : orchestrateur RÉEL (`runAssistant`),
 * résolution RÉELLE, lectures injectées (harnais lot 29), compteur d'appels
 * modèle. La chaîne complète sur PostgreSQL est rejouée par
 * `src/test/e2e/scenarios/l101a-continuite-serie-equipement.e2e.ts`.
 *
 * Cas réel : « C'est quoi la marque de mon micro-onde ? » → Samsung, puis
 * « Et la série ? » → 10 valeurs parasites (Decathlon, Orange, EDF, VIN).
 */
import { describe, expect, it, vi } from 'vitest';

const unsafe = vi.fn(async (_sql: string, _params?: unknown[]) => [] as unknown[]);
vi.mock('@/db', () => ({ pgClient: { unsafe: (sql: string, params?: unknown[]) => unsafe(sql, params) }, db: {}, ensureMigrations: vi.fn(), ensureUnaccent: vi.fn() }));

const H = await import('../lot29/harness');
const { propertyFollowUp, resolveThreadReference } = await import('../../reference-resolver');
const { decideT2Routing, turnAnomalies } = await import('../../routing-guard');
const { validateFactCandidate } = await import('../../candidate-validation');
const { answerFromData } = await import('../../data-answer.service');
const { CONTEXT_TARGET_QUESTION_MESSAGE } = await import('../../assistant-orchestrator.service');
const { deterministicRequestedFacts } = await import('../../../canonical/field-vocabulary');
import type { ThreadContext } from '../../reference-resolver';
import type { FactHit, AccountDataPort } from '../../data-answer.service';

const MAISON = { id: 1, name: 'Maison', category: 'IMMOBILIER', subtype: 'Maison' };
const MICRO = { kind: 'equipment' as const, id: 8, assetId: 1, name: 'Micro-onde', type: 'Micro-onde', fields: { brand: 'Samsung', modelName: 'MG23K3515AK' } };
const FOUR = { kind: 'equipment' as const, id: 9, assetId: 1, name: 'Four', type: 'Four', fields: { brand: 'Bosch', modelName: 'HBA534BS0' } };

const fil = (p: Partial<ThreadContext>): ThreadContext => ({
  conversationId: 99, messages: [{ role: 'user', content: 'C’est quoi la marque de mon micro-onde ?' }, { role: 'assistant', content: 'Marque de Micro-onde : Samsung.' }],
  presentedLists: [], lastPresentedEntities: [], lastSelected: null, currentAssetId: null, currentDocumentId: null, pendingClarification: null, ...p,
});
const surMicro = fil({ lastSelected: { type: 'equipment', id: 8, label: 'Micro-onde' }, lastSelectedMessageId: 10,
  presentedLists: [[{ position: 1, type: 'equipment', id: 8, label: 'Micro-onde' }]], presentedListMessageIds: [10] });
const PARASITES = ['Decathlon', '29,99', 'Livebox', 'EDF', 'VF1RFB00X56123456'];
const sansParasite = (t: string) => { for (const p of PARASITES) expect(t).not.toContain(p); };

describe('L101A-U-A — continuité : objet actif par identifiant métier (pur)', () => {
  it('ellipses reconnues (série, modèle, prix, date, référence, marque, numéro de série) ; un nom n’en est pas une', () => {
    for (const m of ['Et la série ?', 'Et le modèle ?', 'Et son prix ?', 'Et la date ?', 'Et sa référence ?', 'Et la marque ?', 'Et son numéro de série ?', 'La série ?']) {
      expect(propertyFollowUp(m), m).not.toBeNull();
    }
    for (const m of ['Et la Clio ?', 'Et la maison ?', 'Quelle est la série de rappels de la chaudière à prévoir cette année ?']) expect(propertyFollowUp(m), m).toBeNull();
    expect(propertyFollowUp('Et la série ?')!.fields).toEqual(['productSeries']);
    expect(propertyFollowUp('Et son numéro de série ?')!.fields).toEqual(['serialNumber']);
  });
  it('« série » ≠ « numéro de série » ≠ « n° de série » (vocabulaire du registre)', () => {
    expect(deterministicRequestedFacts('Et la série ?')).toEqual(['productSeries']);
    expect(deterministicRequestedFacts('Quel est le numéro de série du micro-onde ?')).toEqual(['serialNumber']);
    expect(deterministicRequestedFacts('Le n° de série, tu l’as ?')).toEqual([]);
    // « marque » : champs homonymes du véhicule ET de l'équipement (la cible départage).
    expect(deterministicRequestedFacts('C’est quoi la marque de mon micro-onde ?')).toEqual(['make', 'brand']);
  });
  it('dernier objet actif ; liste plus récente : unique → retenu, plusieurs → ambiguïté (jamais de choix)', () => {
    expect(resolveThreadReference('Et la série ?', surMicro)).toMatchObject({ kind: 'resolved', entity: { type: 'equipment', id: 8 }, method: 'ellipsis' });
    const deux = fil({ lastSelected: { type: 'equipment', id: 8 }, lastSelectedMessageId: 10,
      presentedLists: [[{ position: 1, type: 'equipment', id: 8 }, { position: 2, type: 'equipment', id: 9 }]], presentedListMessageIds: [12] });
    expect(resolveThreadReference('Et la série ?', deux)).toMatchObject({ kind: 'ambiguous', candidates: [{ id: 8 }, { id: 9 }] });
    const four = fil({ lastSelected: { type: 'equipment', id: 9, label: 'Four' }, lastSelectedMessageId: 14,
      presentedLists: [[{ position: 1, type: 'equipment', id: 9 }], [{ position: 1, type: 'equipment', id: 8 }]], presentedListMessageIds: [14, 10] });
    expect(resolveThreadReference('Et la marque ?', four)).toMatchObject({ kind: 'resolved', entity: { id: 9 } });
    // Aucun objet : rien (jamais le texte seul).
    expect(resolveThreadReference('Et la série ?', fil({}))).toEqual({ kind: 'none' });
    // Documents de la dernière réponse : une série ne s'applique pas à un document.
    expect(resolveThreadReference('Et la série ?', fil({ presentedLists: [[{ position: 1, type: 'document', id: 50 }]], presentedListMessageIds: [12] }))).toEqual({ kind: 'none' });
  });
});

describe('L101A-U-B — garde-fou de routage T2 (pur)', () => {
  it('UNKNOWN contextuel ou propriété sans cible → UNDERSTAND d’abord ; cible sûre + propriété → déterministe borné ; mots-clés → niveaux gratuits', () => {
    expect(decideT2Routing({ intentUnknown: true, contextual: true, targetResolved: false, propertyNormalized: true, propertyQuestion: true }))
      .toEqual({ decision: 'UNDERSTAND_FIRST', reasons: ['UNKNOWN_INTENT', 'CONTEXT_DEPENDENT', 'TARGET_UNRESOLVED'] });
    expect(decideT2Routing({ intentUnknown: true, contextual: true, targetResolved: true, propertyNormalized: true, propertyQuestion: true }).decision).toBe('DETERMINISTIC_BOUNDED');
    expect(decideT2Routing({ intentUnknown: true, contextual: true, targetResolved: true, propertyNormalized: false, propertyQuestion: true }).decision).toBe('UNDERSTAND_FIRST');
    expect(decideT2Routing({ intentUnknown: true, contextual: false, targetResolved: false, propertyNormalized: false, propertyQuestion: false }).decision).toBe('FREE_LEVELS_FIRST');
    expect(decideT2Routing({ intentUnknown: false, contextual: true, targetResolved: true, propertyNormalized: false, propertyQuestion: false }).decision).toBe('DETERMINISTIC');
  });
});

describe('L101A-U-AB — orchestrateur réel : cas de référence et non-régressions obligatoires', () => {
  const compte = (over: Partial<typeof MICRO['fields']> & Record<string, unknown> = {}) => H.account({ assets: [MAISON], entities: [{ ...MICRO, fields: { ...MICRO.fields, ...over } }, FOUR] });

  it('tour 1 « C’est quoi la marque de mon micro-onde ? » → Samsung, sans modèle, le micro-onde devient l’objet actif', async () => {
    const h = H.harness(compte());
    const r = await h.ask('C’est quoi la marque de mon micro-onde ?');
    expect(r.answer).toBe('Marque de Micro-onde : Samsung.');
    expect(r.contextUpdate).toMatchObject({ type: 'equipment', id: 8 });
    expect(h.llmCalls()).toBe(0);
    expect(r.cascade?.turn).toMatchObject({ requestedProperty: ['make', 'brand'], retrievalScope: { kind: 'OBJECT', objectType: 'equipment', objectId: 8 }, anomalies: [] });
  });

  it('marque → « Et la série ? » : même equipment_id = 8, série du produit, absente → dite absente (ni modèle, ni numéro de série, ni parasite)', async () => {
    const h = H.harness(compte(), { thread: surMicro });
    const r = await h.ask('Et la série ?');
    expect(r.answer).toBe('L’information « Série du produit » n’est pas renseignée pour Micro-onde.');
    expect(r.answer).not.toContain('MG23K3515AK');
    sansParasite(r.answer);
    expect(r.cascade?.reference?.entity).toEqual({ type: 'equipment', id: 8 });
    expect(h.readers.calls.filter((c) => c.kind === 'EQUIPMENT')).toEqual([{ kind: 'EQUIPMENT', id: 8, key: 'productSeries' }]);
    expect(h.retrieve).not.toHaveBeenCalled();
    expect(h.llmCalls()).toBe(0);
    const t = r.cascade!.turn!;
    expect(t).toMatchObject({
      contextMessages: 2, elliptical: true, activeObjectsBefore: [{ type: 'equipment', id: 8, via: 'lastSelected' }],
      resolvedTargets: [{ type: 'equipment', id: 8, origin: 'thread' }], requestedProperty: ['productSeries'],
      routing: { decision: 'DETERMINISTIC_BOUNDED' }, understandCalled: false, anomalies: [],
    });
    // Série renseignée : la valeur structurée est servie.
    const h2 = H.harness(compte({ productSeries: 'MG23K3515' }), { thread: surMicro });
    expect((await h2.ask('Et la série ?')).answer).toBe('Série du produit de Micro-onde : MG23K3515.');
  });

  it('marque → « Et le modèle ? » ; modèle → « Et son numéro de série ? » (absent : information non disponible, aucun substitut)', async () => {
    const h = H.harness(compte(), { thread: surMicro });
    const m = await h.ask('Et le modèle ?');
    expect(m.answer).toBe('Modèle de Micro-onde : MG23K3515AK.');
    expect(m.contextUpdate).toMatchObject({ type: 'equipment', id: 8 });
    const s = await h.ask('Et son numéro de série ?');
    expect(s.answer).toBe('L’information « Numéro de série » n’est pas renseignée pour Micro-onde.');
    expect(s.answer).not.toMatch(/MG23K3515/);
    sansParasite(s.answer);
    expect(h.llmCalls()).toBe(0);
  });

  it('équipement A puis équipement B puis « Et la marque ? » : le DERNIER objet actif (B)', async () => {
    const h = H.harness(compte(), { thread: fil({ lastSelected: { type: 'equipment', id: 9, label: 'Four' }, lastSelectedMessageId: 14,
      presentedLists: [[{ position: 1, type: 'equipment', id: 9 }], [{ position: 1, type: 'equipment', id: 8 }]], presentedListMessageIds: [14, 10] }) });
    const r = await h.ask('Et la marque ?');
    expect(r.answer).toBe('Marque de Four : Bosch.');
    expect(r.cascade?.reference?.entity).toEqual({ type: 'equipment', id: 9 });
  });

  it('ambiguïté réelle entre deux objets : clarification, aucune sélection arbitraire, aucune lecture', async () => {
    const h = H.harness(compte(), { thread: fil({ lastSelected: { type: 'equipment', id: 8 }, lastSelectedMessageId: 10,
      presentedLists: [[{ position: 1, type: 'equipment', id: 8, label: 'Micro-onde' }, { position: 2, type: 'equipment', id: 9, label: 'Four' }]], presentedListMessageIds: [12] }) });
    const r = await h.ask('Et la série ?');
    expect(r.clarification?.candidates.map((c) => c.entityId).sort()).toEqual([8, 9]);
    expect(h.readers.calls).toEqual([]);
    expect(h.llmCalls()).toBe(0);
  });

  it('plusieurs tours successifs : série, modèle, référence, numéro de série — toujours equipment_id = 8', async () => {
    const h = H.harness(compte({ productReference: 'MG23K3515AK/EF' }), { thread: surMicro });
    for (const [q, attendu] of [
      ['Et la série ?', 'L’information « Série du produit » n’est pas renseignée pour Micro-onde.'],
      ['Et le modèle ?', 'Modèle de Micro-onde : MG23K3515AK.'],
      ['Et sa référence ?', 'Référence commerciale de Micro-onde : MG23K3515AK/EF.'],
      ['Et la marque ?', 'Marque de Micro-onde : Samsung.'],
    ] as const) {
      const r = await h.ask(q);
      expect(r.answer, q).toBe(attendu);
      expect(r.cascade?.reference?.entity, q).toEqual({ type: 'equipment', id: 8 });
    }
  });

  it('ellipse sans propriété reconnue (« Et son prix ? ») : UNDERSTAND AVANT tout retrieval, lecture bornée à l’objet', async () => {
    const h = H.harness(compte({ acquisitionPrice: 149 }), { thread: surMicro, understand: H.understood('ACCOUNT_FACT_ASSET', ['acquisitionPrice']) });
    const r = await h.ask('Et son prix ?');
    expect(r.answer).toContain('149');
    expect(h.classify).toHaveBeenCalledTimes(1);
    expect(h.retrieve).not.toHaveBeenCalled();
    expect(r.cascade?.routingGuard?.decision).toBe('UNDERSTAND_FIRST');
    expect(r.cascade?.routingGuard?.reasons).toEqual(expect.arrayContaining(['CONTEXT_DEPENDENT', 'PROPERTY_NOT_NORMALIZED']));
    expect(r.cascade?.turn?.understandCalled).toBe(true);
    expect(r.answer).not.toBe('Voici « Micro-onde ».');
  });

  it('contexte présent, ellipse, AUCUNE cible : jamais de recherche globale silencieuse — précision demandée, anomalie diagnostiquable', async () => {
    const h = H.harness(compte(), { thread: fil({}) });
    const r = await h.ask('Et la série ?');
    expect(r.answer).toBe(CONTEXT_TARGET_QUESTION_MESSAGE);
    expect(h.retrieve).not.toHaveBeenCalled();
    expect(r.cascade?.turn).toMatchObject({ contextMessages: 2, elliptical: true, resolvedTargets: [], anomalies: ['ELLIPTIC_CONTEXT_UNRESOLVED'] });
    expect(r.cascade?.escalationReasons).toContain('ANOMALY:ELLIPTIC_CONTEXT_UNRESOLVED');
  });
});

describe('L101A-U-CD — retrieval borné et validation des candidats (objet → propriété → source → valeur)', () => {
  const h = (p: Partial<FactHit> & Pick<FactHit, 'id' | 'fileId'>): FactHit => ({
    factKey: 'fact', subject: null, attribute: null, label: null, valueText: null, valueNumber: null, valueUnit: null, confidence: 'certain',
    excerpt: '', documentTitle: 'Document', matchedTerms: 1, ...p,
  });
  // Documents parasites du cas réel (tous contiennent « série » ou un numéro).
  const PARASITES_FAITS: FactHit[] = [
    h({ id: 1, fileId: 101, documentTitle: 'Ticket Decathlon', attribute: 'Article série', label: 'Prix', valueText: '29,99', valueUnit: 'EUR', targetType: 'GENERIC' }),
    h({ id: 2, fileId: 101, documentTitle: 'Ticket Decathlon', attribute: 'N° de transaction', valueText: '0042 7781 2231', targetType: 'GENERIC' }),
    h({ id: 3, fileId: 102, documentTitle: 'Facture Orange', attribute: 'Offre', valueText: 'Série Spéciale Livebox Lite Fibre', targetType: 'GENERIC' }),
    h({ id: 4, fileId: 103, documentTitle: 'Facture EDF', attribute: 'Numéro de série du compteur', canonicalKey: 'serialNumber', valueText: '021529000123', targetType: 'GENERIC' }),
    h({ id: 5, fileId: 104, documentTitle: 'Carte grise', attribute: 'VIN', canonicalKey: 'vin', valueText: 'VF1RFB00X56123456', targetType: 'ASSET', targetEntityId: 3 }),
    h({ id: 6, fileId: 105, documentTitle: 'Facture lave-linge', attribute: 'Série', canonicalKey: 'productSeries', valueText: 'WAN28', targetType: 'EQUIPMENT', targetEntityId: 12 }),
  ];
  const port = (facts: FactHit[]): AccountDataPort & { calls: unknown[][] } => {
    const calls: unknown[][] = [];
    return {
      calls, today: () => '2026-10-30',
      findAssets: async () => [], listAssets: async () => [], countDocuments: async () => 0, countAgenda: async () => 0, upcomingAgenda: async () => [],
      sumDocumentAmounts: async () => ({ sumCents: 0, count: 0 }),
      searchFacts: async (...a) => { calls.push(a); return facts; },
      searchDocuments: async () => { calls.push(['documents']); return [{ fileId: 101, title: 'Ticket Decathlon', date: null, assetName: null, matchedTerms: 1 }]; },
    } as AccountDataPort & { calls: unknown[][] };
  };
  const seuils = { database: 0.9, text: 0.75 };

  it('objet résolu : faits bornés à l’objet (et documents rattachés), parasites rejetés AVANT revalidation, jamais de repli documentaire global', async () => {
    const p = port(PARASITES_FAITS);
    const r = await answerFromData({ port: p, accountId: 1, message: 'Et la série ?', thresholds: seuils as never, intent: 'UNKNOWN',
      object: { type: 'equipment', id: 8 }, requestedFacts: ['productSeries'] });
    expect(p.calls[0]).toEqual([1, ['serie'], null, { entity: { type: 'EQUIPMENT', id: 8 } }]);
    expect(p.calls.some((c) => c[0] === 'documents')).toBe(false);
    expect(r.handled).toBe(false);
    expect(r.revalidation).toBeUndefined();
    expect(r.contextSources).toEqual([]);
    expect(r.retrieval?.scope).toEqual({ kind: 'OBJECT', objectType: 'equipment', objectId: 8, assetId: null, reason: 'RESOLVED_OBJECT' });
    expect(r.retrieval?.candidates.map((c) => [c.factId, c.decision, c.reason])).toEqual([
      [1, 'REJECTED', 'DOCUMENT_NOT_LINKED'], [2, 'REJECTED', 'DOCUMENT_NOT_LINKED'], [3, 'REJECTED', 'DOCUMENT_NOT_LINKED'],
      [4, 'REJECTED', 'DOCUMENT_NOT_LINKED'], [5, 'REJECTED', 'OTHER_OBJECT'], [6, 'REJECTED', 'OTHER_OBJECT'],
    ]);
  });

  it('même sur un document RATTACHÉ à l’objet : propriété et valeur validées (prix ≠ numéro de série, VIN ≠ série, offre ≠ série)', () => {
    const lie = { linkedToEntity: true };
    const ctx = (requestedFacts: string[]) => ({ object: { type: 'equipment' as const, id: 8 }, requestedFacts });
    expect(validateFactCandidate({ ...PARASITES_FAITS[0], ...lie, attribute: 'Numéro de série', canonicalKey: 'serialNumber' }, ctx(['serialNumber'])))
      .toMatchObject({ decision: 'REJECTED', reason: 'VALUE_TYPE_INCOMPATIBLE' });
    expect(validateFactCandidate({ ...PARASITES_FAITS[2], ...lie, canonicalKey: 'productSeries' }, ctx(['productSeries'])))
      .toMatchObject({ decision: 'REJECTED', reason: 'VALUE_TYPE_INCOMPATIBLE' });
    expect(validateFactCandidate({ ...PARASITES_FAITS[4], ...lie, targetType: null, targetEntityId: null, canonicalKey: 'productSeries' }, ctx(['productSeries'])))
      .toMatchObject({ decision: 'REJECTED', reason: 'VALUE_TYPE_INCOMPATIBLE' });
    // Numéro de série ≠ série du produit.
    expect(validateFactCandidate({ ...PARASITES_FAITS[3], ...lie }, ctx(['productSeries']))).toMatchObject({ decision: 'REJECTED', reason: 'PROPERTY_MISMATCH' });
    // Propriété du fait inconnue sur un objet borné : refusée (aucune valeur « qui contient le mot »).
    expect(validateFactCandidate({ ...PARASITES_FAITS[1], ...lie }, ctx(['productSeries']))).toMatchObject({ decision: 'REJECTED', reason: 'PROPERTY_UNKNOWN' });
    // Le bon candidat : fait du micro-onde, propriété série, valeur de la bonne forme.
    expect(validateFactCandidate(h({ id: 9, fileId: 200, canonicalKey: 'productSeries', valueText: 'MG23K3515', targetType: 'EQUIPMENT', targetEntityId: 8 }), ctx(['productSeries'])))
      .toMatchObject({ decision: 'KEPT', reason: 'TARGET', sourceObject: { type: 'EQUIPMENT', id: 8 }, sourceProperty: ['productSeries'] });
  });

  it('revalidation impossible pour un candidat hors cible : seuls les candidats retenus peuvent être revalidés', async () => {
    const bon = h({ id: 20, fileId: 200, canonicalKey: 'serialNumber', valueText: '0B8K7WAM900123X', confidence: 'probable', targetType: 'EQUIPMENT', targetEntityId: 8 });
    const r = await answerFromData({ port: port([...PARASITES_FAITS, bon]), accountId: 1, message: 'Et son numéro de série ?', thresholds: seuils as never,
      intent: 'UNKNOWN', object: { type: 'equipment', id: 8 }, requestedFacts: ['serialNumber'] });
    const retenus = r.retrieval!.candidates.filter((c) => c.decision === 'KEPT').map((c) => c.factId);
    expect(retenus).toEqual([20]);
    if (r.revalidation) for (const id of r.revalidation.factIds) expect(retenus).toContain(id);
  });

  it('repli EXPLICITE compte entier (aucun objet) : propriété validée — un prix « série » n’est jamais candidat à un numéro de série', async () => {
    const r = await answerFromData({ port: port([PARASITES_FAITS[0], PARASITES_FAITS[2]]), accountId: 1, message: 'Quel est le numéro de série ?',
      thresholds: seuils as never, intent: 'UNKNOWN', requestedFacts: ['serialNumber'] });
    expect(r.retrieval?.scope.kind).toBe('ACCOUNT');
    expect(r.retrieval?.candidates.every((c) => c.decision === 'REJECTED')).toBe(true);
    expect(r.handled && r.answer ? r.answer : '').not.toContain('29,99');
  });
});

describe('L101A-U-I — diagnostic par tour : anomalies', () => {
  it('contextMessages > 0, requête elliptique, resolvedTargets = [] → ELLIPTIC_CONTEXT_UNRESOLVED ; recherche compte avec objet actif ; bascule d’objet', () => {
    const base = { contextMessages: 2, elliptical: true, resolvedTargets: [], activeObjectsBefore: [], retrievalScope: null, reference: null,
      answer: { supportLevel: null, clarification: false, sourceCount: 0, claimKeys: [] } };
    expect(turnAnomalies(base)).toEqual(['ELLIPTIC_CONTEXT_UNRESOLVED']);
    expect(turnAnomalies({ ...base, answer: { ...base.answer, clarification: true } })).toEqual([]);
    expect(turnAnomalies({ ...base, elliptical: false, activeObjectsBefore: [{ type: 'equipment', id: 8, via: 'lastSelected' }],
      retrievalScope: { kind: 'ACCOUNT', objectType: null, objectId: null, assetId: null, reason: 'x' } })).toEqual(['ACCOUNT_SEARCH_WITH_ACTIVE_OBJECT']);
    expect(turnAnomalies({ ...base, activeObjectsBefore: [{ type: 'equipment', id: 8, via: 'lastSelected' }], resolvedTargets: [{ type: 'equipment', id: 9, origin: 'thread' }] }))
      .toEqual(['ACTIVE_OBJECT_SWITCHED']);
  });
});
