/**
 * Lot 114 (Trello #750, issues B et C) — arbitrage DURABLE des contradictions
 * réelles d'attributs : décision de l'utilisateur (carte « À traiter »),
 * arbitrage T3 à preuve suffisante, réouverture sur preuve nouvelle,
 * protections, contrat `t3-attribute-arbitration-v1`, carte OPERATION-ATTRIBUTE.
 * Tests purs (aucune base, aucune IA).
 */
import { describe, expect, it } from 'vitest';
import { consolidateOperationState, type CandidateIdentity, type SourceContribution } from '../model';
import {
  attributeChoiceKey, needsArbitrationCard, qualifyAttributeConflicts, resolveAttributeChoices,
  type AttributeChoice, type AttributeReview, type QualificationContext,
} from '../attribute-conflicts';
import {
  ATTRIBUTE_ARBITRATION_CONTRACT_VERSION, arbitrationVariables, buildArbitrationInput, promptCarriesAttributeArbitration, validateArbitration,
  type RawArbitrationContext,
} from '../attribute-arbitration/contract';
import { arbitrationCapabilityOf } from '../attribute-arbitration/decider';
import { arbitrationFingerprint, eligibleForArbitration } from '../attribute-arbitration/review';
import { attributeProposals, attributeQuestion, attributeRelationKey, parseOperationCardChoice, OPERATION_ATTRIBUTE_RULE } from '@/services/to-process/operation-cards';

const TODAY = '2026-11-13';
function cand(over: Partial<CandidateIdentity> = {}): CandidateIdentity {
  return {
    candidateId: 1, candidateKey: 'op1', fileId: 10, established: true, confidence: 'certain', type: 'INTERVENTION',
    status: 'REALIZED', role: 'INVOICE', summary: 'Prestation', provider: null, providerKey: null,
    assetIds: [7], targetAuthority: 'INFERENCE', equipmentIds: [], refs: [],
    dates: { plannedDate: null, startDate: null, realizedDate: null, endDate: null }, hints: [], ...over,
  };
}
const ref = (value: string) => ({ kind: 'INVOICE' as CandidateIdentity['refs'][number]['kind'], value, normalized: value.toUpperCase() });
const src = (sourceId: number, identity: CandidateIdentity): SourceContribution => ({ sourceId, identity });

/** Deux factures de MÊME référence, deux prestataires : contradiction réelle (113AQ : SAME_REFERENCE). */
const FACTURES = (troisieme = false) => [
  src(1, cand({ provider: 'Plomberie Durand', providerKey: 'plomberie durand', refs: [ref('F-118')] })),
  src(2, cand({ candidateId: 2, fileId: 11, provider: 'Chauffage Martin', providerKey: 'chauffage martin', refs: [ref('F-118')] })),
  ...(troisieme ? [src(3, cand({ candidateId: 3, fileId: 12, provider: 'Sanitaire Leroy', providerKey: 'sanitaire leroy', refs: [ref('F-118')] }))] : []),
];

function relever(sources: SourceContribution[], extra: Partial<QualificationContext> = {}) {
  const s = consolidateOperationState('INTERVENTION', sources, TODAY);
  const ctx: QualificationContext = {
    type: s.type, contributions: sources, provenance: s.provenance,
    sourceMeta: new Map(sources.map((x) => [x.sourceId, { authority: 'DOCUMENT', kind: 'DOCUMENT' }])), suspectSourceIds: new Set(), ...extra,
  };
  return { state: s, ctx, ...qualifyAttributeConflicts(s.attributeConflicts, ctx) };
}
const normDe = (r: ReturnType<typeof relever>) => r.alerting.concat(r.divergences).find((c) => c.field === 'provider')!.values.map((v) => v.normalized);
/** Forme de comparaison RÉELLE de « Chauffage Martin » (celle que la carte et l'arbitrage enregistrent). */
const MARTIN = relever(FACTURES()).alerting[0].values.find((v) => v.value === 'Chauffage Martin')!.normalized;
const choix = (by: 'USER' | 'T3', normalized: string, known: string[]): Map<string, AttributeChoice> =>
  new Map([[attributeChoiceKey('provider', 'SUPPLIER'), { field: 'provider', role: 'SUPPLIER', normalized, known, by, ...(by === 'USER' ? { sourceId: 99 } : { reviewId: 5 }) }]]);

describe('L114-U-CARTE — issue C : contradiction réelle → une carte, valeurs réellement différentes', () => {
  it('C-01 — même référence, deux prestataires : conflit réel non tranché, carte demandée', () => {
    const r = relever(FACTURES());
    expect(r.alerting).toEqual([expect.objectContaining({ field: 'provider', role: 'SUPPLIER', qualification: 'REAL_CONFLICT_UNRESOLVED', reasonCode: 'SAME_REFERENCE' })]);
    expect(needsArbitrationCard(r.alerting[0])).toBe(true);
    expect(eligibleForArbitration(r.alerting[0])).toBe(true);
  });

  it('C-02 — jamais de carte pour une divergence légitime, une preuve insuffisante, un doute de rattachement ou un examen T3 attendu', () => {
    const roles = relever([
      src(1, cand({ provider: 'Plomberie Durand', providerKey: 'plomberie durand' })),
      src(2, cand({ candidateId: 2, fileId: 11, role: 'PAYMENT_PROOF', provider: 'Banque Populaire', providerKey: 'banque populaire' })),
    ]);
    expect(roles.alerting).toEqual([]);
    expect(roles.divergences.every((c) => !needsArbitrationCard(c))).toBe(true);
    const sansRef = relever([
      src(1, cand({ provider: 'Plomberie Durand', providerKey: 'plomberie durand' })),
      src(2, cand({ candidateId: 2, fileId: 11, provider: 'Chauffage Martin', providerKey: 'chauffage martin' })),
    ]);
    expect(sansRef.alerting[0]).toMatchObject({ qualification: 'INSUFFICIENT_EVIDENCE', reasonCode: 'FACT_IDENTITY_NOT_ESTABLISHED' });
    expect(needsArbitrationCard(sansRef.alerting[0])).toBe(false);
    const suspect = relever(FACTURES(), { suspectSourceIds: new Set([2]) });
    expect(suspect.alerting[0]).toMatchObject({ qualification: 'SOURCE_LINK_ERROR_SUSPECTED' });
    expect(needsArbitrationCard(suspect.alerting[0])).toBe(false);
    const attendu = relever(FACTURES());
    expect(needsArbitrationCard({ ...attendu.alerting[0], t3: { outcome: 'PENDING' } })).toBe(false);
  });

  it('C-03 — textes de la carte : jamais « Opération » ; toutes les valeurs différentes ; valeur en place en dernier, marquée', () => {
    expect(attributeQuestion('provider', 'INTERVENTION')).toBe('Ces documents indiquent des prestataires différents pour la même intervention : lequel est le bon ?');
    expect(attributeQuestion('realizedDate', 'ACQUISITION')).toBe('Ces documents indiquent des dates de réalisation différentes pour le même achat : laquelle est la bonne ?');
    for (const f of ['plannedDate', 'startDate', 'realizedDate', 'endDate', 'provider'] as const) expect(attributeQuestion(f, null)).not.toMatch(/op[ée]ration/i);
    const p = attributeProposals('provider', [
      { value: 'Plomberie Durand', normalized: 'plomberie durand', title: 'Facture A' },
      { value: 'Chauffage Martin', normalized: 'chauffage martin', title: 'Facture B' },
      { value: 'Sanitaire Leroy', normalized: 'sanitaire leroy', title: null },
      { value: 'PLOMBERIE DURAND', normalized: 'plomberie durand', title: 'Doublon de forme' },
    ], 'Plomberie Durand');
    expect(p.map((x) => x.value)).toEqual(['ATTRIBUTE:chauffage martin', 'ATTRIBUTE:sanitaire leroy', 'ATTRIBUTE:plomberie durand']);
    expect(p.at(-1)).toMatchObject({ isCurrentValue: true, label: 'Plomberie Durand — « Facture A »' });
    expect(attributeProposals('realizedDate', [{ value: '2026-03-12', normalized: '2026-03-12', title: null }, { value: '2026-03-19', normalized: '2026-03-19', title: 'Facture' }], null)
      .map((x) => x.label)).toEqual(['12/03/2026', '19/03/2026 — « Facture »']);
    expect(attributeRelationKey(8, 'provider', 'SUPPLIER')).toBe('operationAttribute:8:provider:SUPPLIER');
  });

  it('C-04 — réponse : seule une valeur présentée est acceptée (requête forgée refusée)', () => {
    const ctx = { kind: 'operation_attribute', operationId: 8, field: 'provider', role: 'SUPPLIER', options: [{ value: 'Plomberie Durand', normalized: 'plomberie durand' }, { value: 'Chauffage Martin', normalized: 'chauffage martin' }] };
    expect(parseOperationCardChoice(OPERATION_ATTRIBUTE_RULE, 'ATTRIBUTE:chauffage martin', ctx)).toEqual({ kind: 'ATTRIBUTE', normalized: 'chauffage martin', value: 'Chauffage Martin' });
    expect(parseOperationCardChoice(OPERATION_ATTRIBUTE_RULE, 'ATTRIBUTE:autre', ctx)).toBeNull();
    expect(parseOperationCardChoice(OPERATION_ATTRIBUTE_RULE, 'AMOUNT:100:EUR', ctx)).toBeNull();
    expect(parseOperationCardChoice(OPERATION_ATTRIBUTE_RULE, 'ATTRIBUTE:chauffage martin', { options: 'x' })).toBeNull();
  });
});

describe('L114-U-DECISION — décision durable, application, réouverture motivée', () => {
  it('D-01 — choix de l’utilisateur : conflit tranché, valeur à écrire, plus d’alerte ni de carte', () => {
    const avant = relever(FACTURES());
    const known = normDe(avant);
    const r = relever(FACTURES(), { choices: choix('USER', MARTIN, known) });
    expect(r.alerting).toEqual([]);
    expect(r.divergences).toEqual([expect.objectContaining({
      qualification: 'REAL_CONFLICT_RESOLVED', reasonCode: 'USER_ARBITRATED', protection: 'USER', impact: [],
      resolution: { by: 'USER', value: 'Chauffage Martin', sourceId: 99 },
    })]);
    expect(resolveAttributeChoices(r.state.attributeConflicts, r.ctx)).toEqual([{ field: 'provider', role: 'SUPPLIER', value: 'Chauffage Martin', by: 'USER', sourceId: 2 }]);
  });

  it('D-02 — constat identique rejoué : jamais rouvert (AC13)', () => {
    const known = normDe(relever(FACTURES()));
    const c = choix('USER', MARTIN, known);
    const a = relever(FACTURES(), { choices: c });
    const b = relever(FACTURES(), { choices: c });
    expect(b.alerting).toEqual([]);
    expect(JSON.stringify(b.divergences)).toBe(JSON.stringify(a.divergences));
  });

  it('D-03 — troisième valeur NOUVELLE après la décision : réouverture avec son motif, carte de nouveau demandée, valeur non réécrite', () => {
    const known = normDe(relever(FACTURES()));
    const r = relever(FACTURES(true), { choices: choix('USER', MARTIN, known) });
    expect(r.alerting).toEqual([expect.objectContaining({ qualification: 'REAL_CONFLICT_UNRESOLVED', reasonCode: 'NEW_EVIDENCE_AFTER_DECISION', protection: 'USER' })]);
    expect(r.alerting[0].values).toHaveLength(3);
    expect(needsArbitrationCard(r.alerting[0])).toBe(true);
    expect(eligibleForArbitration(r.alerting[0])).toBe(false); // valeur protégée par l'utilisateur : jamais renvoyée à T3
    expect(resolveAttributeChoices(r.state.attributeConflicts, r.ctx)).toEqual([]);
  });

  it('D-04 — la source de la valeur retenue disparaît alors que la contradiction demeure : réouverture motivée', () => {
    const known = [...normDe(relever(FACTURES(true)))];
    const restantes = [FACTURES(true)[0], FACTURES(true)[2]];
    const r = relever(restantes, { choices: choix('USER', MARTIN, known) });
    expect(r.alerting).toEqual([expect.objectContaining({ reasonCode: 'DECIDED_VALUE_WITHDRAWN', qualification: 'REAL_CONFLICT_UNRESOLVED' })]);
  });

  it('D-05 — arbitrage T3 certain : tranché, tracé « T3 », sans protection utilisateur ; doute de rattachement : jamais appliqué', () => {
    const known = normDe(relever(FACTURES()));
    const r = relever(FACTURES(), { choices: choix('T3', MARTIN, known) });
    expect(r.divergences).toEqual([expect.objectContaining({ qualification: 'REAL_CONFLICT_RESOLVED', reasonCode: 'T3_ARBITRATED', resolution: { by: 'T3', value: 'Chauffage Martin', reviewId: 5 } })]);
    expect(r.divergences[0].protection).toBeUndefined();
    expect(resolveAttributeChoices(r.state.attributeConflicts, r.ctx)).toEqual([expect.objectContaining({ by: 'T3', value: 'Chauffage Martin' })]);
    const suspect = relever(FACTURES(), { choices: choix('T3', MARTIN, known), suspectSourceIds: new Set([2]) });
    expect(suspect.alerting[0]).toMatchObject({ qualification: 'SOURCE_LINK_ERROR_SUSPECTED' });
    expect(resolveAttributeChoices(suspect.state.attributeConflicts, suspect.ctx)).toEqual([]);
  });

  it('D-06 — examens T3 sans valeur retenue : faits distincts (pas un conflit), indécidable (carte), attente (pas de carte), document étranger', () => {
    const known = normDe(relever(FACTURES()));
    const examen = (outcome: AttributeReview['outcome']): Map<string, AttributeReview> =>
      new Map([[attributeChoiceKey('provider', 'SUPPLIER'), { field: 'provider', role: 'SUPPLIER', known, outcome, reviewId: 6 }]]);
    const distincts = relever(FACTURES(), { reviews: examen('LEGITIMATE_DIFFERENCE') });
    expect(distincts.alerting).toEqual([]);
    expect(distincts.divergences[0]).toMatchObject({ qualification: 'LEGITIMATE_DIFFERENCE', reasonCode: 'T3_DISTINCT_FACTS' });
    const indecidable = relever(FACTURES(), { reviews: examen('UNDECIDABLE') });
    expect(indecidable.alerting[0]).toMatchObject({ qualification: 'REAL_CONFLICT_UNRESOLVED', t3: { outcome: 'UNDECIDABLE', reviewId: 6 } });
    expect(needsArbitrationCard(indecidable.alerting[0])).toBe(true);
    const attente = relever(FACTURES(), { reviews: examen('PENDING') });
    expect(needsArbitrationCard(attente.alerting[0])).toBe(false);
    const etranger = relever(FACTURES(), { reviews: examen('LINK_ERROR') });
    expect(etranger.alerting[0]).toMatchObject({ qualification: 'SOURCE_LINK_ERROR_SUSPECTED', reasonCode: 'T3_LINK_ERROR_SUSPECTED' });
    // Un examen d'AUTRES valeurs ne couvre pas le constat actuel.
    const autre = relever(FACTURES(true), { reviews: examen('LEGITIMATE_DIFFERENCE') });
    expect(autre.alerting[0]).toMatchObject({ qualification: 'REAL_CONFLICT_UNRESOLVED', reasonCode: 'SAME_REFERENCE' });
  });

  it('D-07 — identité du fait non établie + T3 « indécidable » : devient un conflit réel à arbitrer par l’utilisateur', () => {
    const sources = [
      src(1, cand({ provider: 'Plomberie Durand', providerKey: 'plomberie durand' })),
      src(2, cand({ candidateId: 2, fileId: 11, provider: 'Chauffage Martin', providerKey: 'chauffage martin' })),
    ];
    const known = normDe(relever(sources));
    const r = relever(sources, { reviews: new Map([[attributeChoiceKey('provider', 'SUPPLIER'), { field: 'provider', role: 'SUPPLIER', known, outcome: 'UNDECIDABLE' }]]) });
    expect(r.alerting[0]).toMatchObject({ qualification: 'REAL_CONFLICT_UNRESOLVED', reasonCode: 'T3_UNDECIDABLE' });
    expect(needsArbitrationCard(r.alerting[0])).toBe(true);
  });

  it('D-08 — empreinte du constat : stable, indépendante de l’ordre, différente dès qu’une valeur change', () => {
    expect(arbitrationFingerprint(8, 'provider', 'SUPPLIER', ['b', 'a'])).toBe(arbitrationFingerprint(8, 'provider', 'SUPPLIER', ['a', 'b', 'a']));
    expect(arbitrationFingerprint(8, 'provider', 'SUPPLIER', ['a', 'b'])).not.toBe(arbitrationFingerprint(8, 'provider', 'SUPPLIER', ['a', 'b', 'c']));
    expect(arbitrationFingerprint(8, 'provider', 'SUPPLIER', ['a', 'b'])).not.toBe(arbitrationFingerprint(9, 'provider', 'SUPPLIER', ['a', 'b']));
  });
});

describe('L114-U-CONTRAT — contrat t3-attribute-arbitration-v1 : contexte fermé, validation stricte', () => {
  const RAW: RawArbitrationContext = {
    today: TODAY, field: 'realizedDate', role: 'REALIZATION', operation: { typeCode: 'INTERVENTION', label: 'Chauffe-eau' },
    values: [
      { value: '2026-03-19', normalized: '2026-03-19', fileIds: [22], held: false, userProtected: false },
      { value: '2026-03-12', normalized: '2026-03-12', fileIds: [21], held: true, userProtected: false },
    ],
    documents: [
      { id: 21, type: 'INVOICE', title: 'Facture', date: '2026-03-20', provider: 'Plomberie Durand', references: [], excerpts: ['Intervention réalisée le 12/03/2026'] },
      { id: 22, type: 'INVOICE', title: 'Facture rectificative', date: '2026-03-27', provider: 'Plomberie Durand', references: [], excerpts: ['Annule et remplace la facture F-118', 'Intervention réalisée le 19/03/2026'] },
    ],
  };
  const sortie = (over: Record<string, unknown> = {}) => ({
    task: 'ATTRIBUTE_ARBITRATION', outcome: 'RESOLVED', retainedValue: 'V2', foreignDocument: null, confidence: 'certain',
    evidence: [{ document: 'D2', excerpt: 'annule et remplace la facture F-118' }], reason: 'Rectificative.', ...over,
  });

  it('K-01 — références opaques stables (valeurs triées, documents par identifiant), six emplacements T3, aucun nouveau', () => {
    const { input, scope } = buildArbitrationInput(RAW);
    expect(input.values.map((v) => [v.ref, v.value, v.documents, v.heldByEvent])).toEqual([['V1', '2026-03-12', ['D1'], true], ['V2', '2026-03-19', ['D2'], false]]);
    expect(scope.documents).toEqual({ D1: 21, D2: 22 });
    expect(scope.complete).toBe(true);
    expect(Object.keys(arbitrationVariables(input)).sort()).toEqual(['CANDIDATES', 'CURRENT_STATE', 'EVIDENCES', 'FIELD', 'RELATION_TYPE', 'SUBJECT_CONTEXT']);
    expect(JSON.stringify(input)).not.toMatch(/"fileIds"|"normalized"/);
  });

  it('K-02 — RESOLVED certain, preuve citée dans le document qui porte la valeur : valeur retenue', () => {
    const v = validateArbitration(sortie(), buildArbitrationInput(RAW).scope);
    expect(v).toMatchObject({ ok: true, ignored: null, effect: { outcome: 'RESOLVED', value: '2026-03-19', normalized: '2026-03-19', citation: { fileId: 22 } } });
  });

  it('K-03 — refus en bloc : extrait inventé, preuve hors du document porteur, valeur de l’utilisateur, référence inconnue, schéma', () => {
    const scope = buildArbitrationInput(RAW).scope;
    const issues = (o: unknown, s = scope) => { const v = validateArbitration(o, s); return v.ok ? [] : v.problems.map((p) => p.issue); };
    expect(issues(sortie({ evidence: [{ document: 'D2', excerpt: 'texte jamais écrit' }] }))).toEqual(['EXCERPT_NOT_FOUND', 'RETAINED_EVIDENCE_MISSING'].filter((x) => x !== 'RETAINED_EVIDENCE_MISSING'));
    expect(issues(sortie({ evidence: [{ document: 'D1', excerpt: 'Intervention réalisée le 12/03/2026' }] }))).toEqual(['RETAINED_EVIDENCE_MISSING']);
    const protege = buildArbitrationInput({ ...RAW, values: [RAW.values[0], { ...RAW.values[1], userProtected: true }] }).scope;
    expect(issues(sortie(), protege)).toEqual(['PROTECTED_VALUE']);
    expect(issues(sortie({ evidence: [{ document: 'D5', excerpt: 'x' }] }))).toContain('UNKNOWN_REFERENCE');
    expect(issues(sortie({ retainedValue: null }))).toEqual(['SCHEMA']);
    expect(issues(sortie({ outcome: 'UNDECIDABLE', retainedValue: null, evidence: [] }))).toEqual(['SCHEMA']);
    expect(issues({ task: 'AUTRE' })).toContain('SCHEMA');
  });

  it('K-04 — confiance insuffisante ou abstention : aucun effet ; autres issues certaines : effet sans valeur', () => {
    const scope = buildArbitrationInput(RAW).scope;
    expect(validateArbitration(sortie({ confidence: 'probable' }), scope)).toMatchObject({ ok: true, effect: null, ignored: 'NOT_CERTAIN' });
    expect(validateArbitration(sortie({ outcome: 'ABSTAIN', retainedValue: null, evidence: [] }), scope)).toMatchObject({ ok: true, effect: null, ignored: 'ABSTAIN' });
    expect(validateArbitration(sortie({ outcome: 'DISTINCT_FACTS', retainedValue: null }), scope)).toMatchObject({ ok: true, effect: { outcome: 'DISTINCT_FACTS' } });
    expect(validateArbitration(sortie({ outcome: 'UNDECIDABLE', retainedValue: null }), scope)).toMatchObject({ ok: true, effect: { outcome: 'UNDECIDABLE' } });
    expect(validateArbitration(sortie({ outcome: 'LINK_ERROR', retainedValue: null, foreignDocument: 'D2' }), scope)).toMatchObject({ ok: true, effect: { outcome: 'LINK_ERROR', foreignFileId: 22 } });
  });

  it('K-05 — contexte au-delà des bornes : aucun arbitrage sur un contexte partiel', () => {
    const beaucoup: RawArbitrationContext = { ...RAW, values: ['01', '02', '03', '04', '05'].map((j, i) => ({ value: `2026-03-${j}`, normalized: `2026-03-${j}`, fileIds: [30 + i], held: i === 0, userProtected: false })), documents: [] };
    const b = buildArbitrationInput(beaucoup);
    expect(b.input.values).toHaveLength(4);
    expect(b.input.bounds).toMatchObject({ complete: false, droppedValues: 1 });
    expect(b.scope.known).toHaveLength(5);
    const v = validateArbitration({ task: 'ATTRIBUTE_ARBITRATION', outcome: 'RESOLVED', retainedValue: 'V1', foreignDocument: null, confidence: 'certain', evidence: [{ document: 'D1', excerpt: 'x' }], reason: 'r' }, b.scope);
    expect(v.ok).toBe(false);
  });

  it('K-06 — activation prudente : branche ET marqueur dans le prompt effectif, sinon aucune demande', () => {
    expect(promptCarriesAttributeArbitration(`… ${ATTRIBUTE_ARBITRATION_CONTRACT_VERSION} …`, ['ATTRIBUTE_ARBITRATION'])).toBe(true);
    expect(arbitrationCapabilityOf({ text: 'sans marqueur', version: 'v9', branches: ['ATTRIBUTE_ARBITRATION'] })).toMatchObject({ available: false, reason: 'CONTRACT_PENDING', contractState: 'MARKER_MISSING' });
    expect(arbitrationCapabilityOf({ text: ATTRIBUTE_ARBITRATION_CONTRACT_VERSION, version: 'v9', branches: [] })).toMatchObject({ available: false, contractState: 'BRANCH_MISSING' });
    expect(arbitrationCapabilityOf({ text: ATTRIBUTE_ARBITRATION_CONTRACT_VERSION, version: 'v9', branches: ['ATTRIBUTE_ARBITRATION'] })).toEqual({ available: true, version: 'v9', reason: 'AVAILABLE' });
  });
});
