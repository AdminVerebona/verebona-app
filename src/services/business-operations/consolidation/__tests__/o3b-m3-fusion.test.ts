/**
 * Lot 42 (O3b) — règles PURES : niveau M3 (C6.1, C6.2), mémoire des décisions
 * (C6.3), fusion V1 (B8, ch. 8.4), réactivation (C8, F-052), montant
 * contradictoire (B19), empreinte M3 et reprise (NFR-OP-005).
 * Un test par règle : C6-xx, B8-xx, F-xxx du CDC cités.
 */
import { describe, expect, it } from 'vitest';
import {
  applyM3Verdict, canonicalOf, decideCandidate, hasBusinessImpact, operationsMergeable,
  type CandidateDecision, type ExistingOperation, type MatchContext,
} from '../matching';
import { consolidateComponentsDetailed, componentsFromIdentity, type CandidateIdentity } from '../model';
import { m3Due } from '../m3';
import {
  OPERATION_MATCH_MAX_CANDIDATES, operationMatchFingerprint, operationMatchVariables, translateOperationMatch,
  type OperationMatchCandidate, type OperationMatchSubject, type OperationMatchVerdict,
} from '@/services/ai/reconciliation/master/operation-match';
import { T3MasterOutput, T3OperationMatchOutput } from '@/services/ai/reconciliation/master/t3-contract';

function cand(over: Partial<CandidateIdentity> = {}): CandidateIdentity {
  return {
    candidateId: 1, candidateKey: 'op1', fileId: 10, established: true, confidence: 'certain', type: 'INTERVENTION',
    status: 'REALIZED', role: 'INVOICE', summary: 'Réparation', provider: 'Garage', providerKey: 'garage',
    assetIds: [1], targetAuthority: 'DOCUMENT', equipmentIds: [], refs: [],
    dates: { plannedDate: null, startDate: null, realizedDate: '2026-06-02', endDate: null }, hints: [],
    ...over,
  };
}
const ref = (kind: CandidateIdentity['refs'][number]['kind'], value: string) => ({ kind, value, normalized: value.replace(/[^A-Z0-9]/gi, '').toUpperCase() });
function op(over: Partial<ExistingOperation> = {}): ExistingOperation {
  return {
    id: 100, typeCode: 'INTERVENTION', status: 'REALIZED', providerKey: 'garage', assetIds: [1], refs: [],
    plannedDate: null, startDate: null, realizedDate: '2026-06-01', endDate: null, ...over,
  };
}
const ctx = (operations: ExistingOperation[], over: Partial<MatchContext> = {}): MatchContext => ({
  operations, confirmed: new Set(), rejected: new Set(), assetStatus: new Map(), ...over,
});
const verdict = (over: Partial<OperationMatchVerdict> = {}): OperationMatchVerdict => ({
  decision: 'SAME_OPERATION', matchedOperationId: 100, confidence: 'certain', concordantSignals: ['même bien'], contradictions: [], reason: 'x', ...over,
});
/** Décision « M3_REQUIRED » sur deux Opérations plausibles (100, 101). */
function m3Required(c: CandidateIdentity, ops: ExistingOperation[]): CandidateDecision {
  const d = decideCandidate(c, ctx(ops));
  expect(d).toMatchObject({ outcome: 'HOLD_UNRESOLVED', reason: 'M3_REQUIRED' });
  return d;
}
const facture = (over: Partial<CandidateIdentity> = {}) => cand({ hints: [{ role: 'REALIZED_COST', amountMinor: 24900, currency: 'EUR', amountScope: 'TOTAL' }], ...over });

describe('C6.2 — niveau M3 : verdict sémantique appliqué par le serveur', () => {
  const deux = [op({ id: 100 }), op({ id: 101, realizedDate: '2026-05-20' })];

  it('C6-01 / F-059 SAME_OPERATION certain sur un candidat plausible → MATCH_AND_ENRICH (M3)', () => {
    const c = facture();
    const d = applyM3Verdict(c, m3Required(c, deux), verdict({ matchedOperationId: 101 }), ctx(deux));
    expect(d).toMatchObject({ outcome: 'MATCH_AND_ENRICH', operationId: 101, matchMethod: 'M3', reason: 'MATCH_M3' });
  });

  it('C6-02 / F-058 SAME_OPERATION probable → jamais de rattachement silencieux : ARBITRATION_REQUIRED, candidat désigné en tête', () => {
    const c = facture();
    const d = applyM3Verdict(c, m3Required(c, deux), verdict({ matchedOperationId: 101, confidence: 'probable' }), ctx(deux));
    expect(d).toMatchObject({ outcome: 'ARBITRATION_REQUIRED', reason: 'M3_AMBIGUOUS', operationId: null });
    expect(d.arbitration).toEqual({ basis: 'M3', operationIds: [101, 100] });
  });

  it('C6-03 / C5 DISTINCT_OPERATION certain : création si la source peut créer seule ; probable → attente ; « autre réalité » utilisateur → création', () => {
    const certain = facture();
    expect(applyM3Verdict(certain, m3Required(certain, deux), verdict({ decision: 'DISTINCT_OPERATION', matchedOperationId: null }), ctx(deux)))
      .toMatchObject({ outcome: 'CREATE_NEW', reason: 'M3_DISTINCT' });
    const probable = facture({ confidence: 'probable' });
    const base = m3Required(probable, deux);
    expect(applyM3Verdict(probable, base, verdict({ decision: 'DISTINCT_OPERATION', matchedOperationId: null }), ctx(deux)))
      .toMatchObject({ outcome: 'HOLD_UNRESOLVED', reason: 'PROBABLE_WITHOUT_MATCH' });
    expect(applyM3Verdict(probable, base, verdict({ decision: 'DISTINCT_OPERATION', matchedOperationId: null }), ctx(deux, { userDistinct: true })))
      .toMatchObject({ outcome: 'CREATE_NEW' });
  });

  it('C6-04 / C5 AMBIGUOUS sans impact métier (ni montant, ni bien, ni statut) → attente silencieuse, aucune question', () => {
    const c = cand({ assetIds: [], role: 'REPORT' });
    const ops = [op({ id: 100, assetIds: [] })];
    expect(hasBusinessImpact(c, ops)).toBe(false);
    const d = applyM3Verdict(c, m3Required(c, ops), verdict({ decision: 'AMBIGUOUS', matchedOperationId: null, confidence: 'conflictual' }), ctx(ops));
    expect(d).toMatchObject({ outcome: 'HOLD_UNRESOLVED', reason: 'M3_AMBIGUOUS_NO_IMPACT' });
    expect(d.arbitration).toBeUndefined();
  });

  it('C6-05 / U1 monde fermé : candidat hors du jeu fourni → AMBIGUOUS + avertissement, jamais un rattachement', () => {
    const out = { task: 'OPERATION_MATCH' as const, decision: 'SAME_OPERATION' as const, matchedCandidateId: 99, confidence: 'certain' as const, concordantSignals: [], contradictions: [], reason: 'r' };
    const { verdict: v, warnings } = translateOperationMatch(out, new Set([100, 101]));
    expect(v).toMatchObject({ decision: 'AMBIGUOUS', matchedOperationId: null, confidence: 'conflictual' });
    expect(warnings).toEqual([{ code: 'UNKNOWN_OPERATION_ID', id: 99 }]);
    // Verdict SAME certain sur une Opération qui n'est plus plausible : ambiguïté.
    const c = facture();
    expect(applyM3Verdict(c, m3Required(c, deux), verdict({ matchedOperationId: 555 }), ctx(deux)).outcome).toBe('ARBITRATION_REQUIRED');
  });

  it('C6-06 / C6.3 / F-046 une Opération REJECTED par l’utilisateur n’est jamais plausible, donc jamais soumise à l’IA', () => {
    const d = decideCandidate(facture(), ctx(deux, { rejected: new Set([100]) }));
    expect(d.detail.plausible).toEqual([101]);
    expect(d.detail.excluded).toContainEqual({ operationId: 100, why: 'USER_REJECTED' });
    const tous = decideCandidate(facture(), ctx(deux, { rejected: new Set([100, 101]) }));
    expect(tous).toMatchObject({ outcome: 'CREATE_NEW' });
  });

  it('C6-07 / F-047 décision CONFIRMED : ancre M0 prioritaire, aucun M3', () => {
    expect(decideCandidate(facture(), ctx(deux, { confirmed: new Set([101]) }))).toMatchObject({ outcome: 'MATCH_AND_ENRICH', operationId: 101, matchMethod: 'M0' });
  });

  it('C6-08 un verdict ne s’applique qu’à une décision M3_REQUIRED (jamais par-dessus un M1 / M2)', () => {
    const c = facture({ refs: [ref('INVOICE', 'F1')] });
    const d = decideCandidate(c, ctx([op({ id: 100, refs: [ref('INVOICE', 'F1')] })]));
    expect(applyM3Verdict(c, d, verdict({ decision: 'DISTINCT_OPERATION', matchedOperationId: null }), ctx([]))).toBe(d);
  });
});

describe('C6.1 — contrat OPERATION_MATCH et empreinte de contexte (NFR-OP-005)', () => {
  it('C6-10 sortie fermée : SAME exige un candidat ; DISTINCT / AMBIGUOUS l’interdisent ; union discriminée T3', () => {
    const base = { task: 'OPERATION_MATCH', confidence: 'certain', concordantSignals: [], contradictions: [], reason: 'r' };
    expect(T3OperationMatchOutput.safeParse({ ...base, decision: 'SAME_OPERATION' }).success).toBe(false);
    expect(T3OperationMatchOutput.safeParse({ ...base, decision: 'DISTINCT_OPERATION', matchedCandidateId: 3 }).success).toBe(false);
    expect(T3OperationMatchOutput.safeParse({ ...base, decision: 'AMBIGUOUS', matchedCandidateId: null }).success).toBe(true);
    expect(T3MasterOutput.safeParse({ ...base, decision: 'SAME_OPERATION', matchedCandidateId: 3 }).success).toBe(true);
  });

  const subject: OperationMatchSubject = {
    document: { title: 'Facture', documentType: 'INVOICE', documentDate: '2026-06-05' },
    candidate: { type: 'INTERVENTION', status: 'REALIZED', sourceRole: 'INVOICE', summary: 'Freins', provider: 'Garage', assets: ['Clio'], references: [], dates: {}, amounts: [] },
  };
  const c = (id: number, over: Partial<OperationMatchCandidate> = {}): OperationMatchCandidate => ({
    candidateId: id, type: 'INTERVENTION', status: 'REALIZED', provider: 'Garage', dates: {}, assets: ['Clio'], references: [], amounts: [], documents: [], ...over,
  });

  it('C6-11 empreinte stable (ordre neutre des candidats), modifiée par tout changement de contexte', () => {
    const a = operationMatchFingerprint(operationMatchVariables(subject, [c(2), c(1)]));
    expect(operationMatchFingerprint(operationMatchVariables(subject, [c(1), c(2)]))).toBe(a);
    expect(operationMatchFingerprint(operationMatchVariables(subject, [c(1), c(2, { amounts: ['REALIZED_COST 10.00 EUR'] })]))).not.toBe(a);
    const v = operationMatchVariables(subject, [c(2), c(1)]);
    expect((v.CANDIDATES as OperationMatchCandidate[]).map((x) => x.candidateId)).toEqual([1, 2]);
    expect(Object.keys(v).sort()).toEqual(['CANDIDATES', 'CURRENT_STATE', 'EVIDENCES', 'FIELD', 'RELATION_TYPE', 'SUBJECT_CONTEXT']);
    expect(OPERATION_MATCH_MAX_CANDIDATES).toBe(5);
  });

  it('C6-12 / NFR-OP-005 reprise : jamais de rappel sans changement ; contexte changé, report échu, prompt modifié → nouvel essai', () => {
    const now = new Date('2026-10-12T10:00:00Z');
    const fait = { m3Fingerprint: 'F', m3: { status: 'DONE', fingerprint: 'F', at: '' } };
    expect(m3Due(fait, now, 'v1')).toBe(false);
    expect(m3Due({ ...fait, m3Fingerprint: 'G' }, now, 'v1')).toBe(true);
    expect(m3Due({ m3Fingerprint: 'F' }, now, 'v1')).toBe(true);
    expect(m3Due({ m3Fingerprint: 'F', m3: { status: 'DEFERRED', fingerprint: 'F', at: '', retryAfter: '2026-10-13T00:00:00Z' } }, now, 'v1')).toBe(false);
    expect(m3Due({ m3Fingerprint: 'F', m3: { status: 'DEFERRED', fingerprint: 'F', at: '', retryAfter: '2026-10-12T09:00:00Z' } }, now, 'v1')).toBe(true);
    expect(m3Due({ m3Fingerprint: 'F', m3: { status: 'PROMPT_UNAVAILABLE', fingerprint: 'F', at: '', promptVersion: 'v1' } }, now, 'v1')).toBe(false);
    expect(m3Due({ m3Fingerprint: 'F', m3: { status: 'PROMPT_UNAVAILABLE', fingerprint: 'F', at: '', promptVersion: 'v1' } }, now, 'v2')).toBe(true);
    expect(m3Due({ m3Fingerprint: 'F', m3: { status: 'TOO_MANY_CANDIDATES', fingerprint: 'F', at: '' } }, now, 'v1')).toBe(false);
    expect(m3Due(null, now, 'v1')).toBe(false);
  });
});

describe('B8 — fusion V1 (ch. 8.4) : seulement sur preuve forte', () => {
  it('B8-01 / F-049 référence commune découverte : deux Opérations compatibles citées exactement → MATCH sur la canonique (la plus ancienne), l’autre absorbée', () => {
    const d = decideCandidate(cand({ refs: [ref('QUOTE', 'D1'), ref('WORK_ORDER', 'OT9')] }), ctx([
      op({ id: 7, refs: [ref('WORK_ORDER', 'OT9')] }), op({ id: 3, refs: [ref('QUOTE', 'D1')] }),
    ]));
    expect(d).toMatchObject({ outcome: 'MATCH_AND_ENRICH', operationId: 3, reason: 'MATCH_MERGE', mergeIds: [7] });
  });

  it('B8-02 jamais de fusion sur des Opérations incompatibles : type, bien, prestataire, références divergentes, deux factures finales', () => {
    const a = op({ id: 1 });
    expect(operationsMergeable(a, op({ id: 2, typeCode: 'CONTRACT' }))).toBe(false);
    expect(operationsMergeable(a, op({ id: 2, assetIds: [9] }))).toBe(false);
    expect(operationsMergeable(a, op({ id: 2, providerKey: 'autre' }))).toBe(false);
    expect(operationsMergeable(op({ id: 1, refs: [ref('WORK_ORDER', 'A')] }), op({ id: 2, refs: [ref('WORK_ORDER', 'B')] }))).toBe(false);
    expect(operationsMergeable(op({ id: 1, refs: [ref('INVOICE', 'F1')] }), op({ id: 2, refs: [ref('INVOICE', 'F2')] }))).toBe(false);
    expect(operationsMergeable(op({ id: 1, typeCode: null }), op({ id: 2, providerKey: null }))).toBe(true);
  });

  it('B8-03 / F-046 une décision utilisateur qui sépare deux Opérations interdit leur fusion → ARBITRATION', () => {
    const c = cand({ refs: [ref('QUOTE', 'D1'), ref('WORK_ORDER', 'OT9')] });
    const ops = [op({ id: 1, refs: [ref('QUOTE', 'D1')] }), op({ id: 2, refs: [ref('WORK_ORDER', 'OT9')] })];
    expect(decideCandidate(c, ctx(ops, { nonMergeable: new Set(['1:2']) }))).toMatchObject({ outcome: 'ARBITRATION_REQUIRED', arbitration: { basis: 'CERTAIN' } });
  });

  it('B8-04 une règle de cycle de possession (M2) ou une décision M0 ne déclenche jamais de fusion', () => {
    const acq = (id: number) => op({ id, typeCode: 'ACQUISITION', realizedDate: null });
    const d = decideCandidate(cand({ type: 'ACQUISITION', dates: { plannedDate: null, startDate: null, realizedDate: null, endDate: null } }), ctx([acq(1), acq(2)]));
    expect(d.outcome).toBe('ARBITRATION_REQUIRED');
    expect(canonicalOf([op({ id: 5, invalidated: true }), op({ id: 8 })]).id).toBe(8);
  });
});

describe('C8 / F-052 / F-053 — Opération invalidée', () => {
  it('F-052 même référence exacte → rattachement certain (réactivation, même identifiant)', () => {
    const d = decideCandidate(cand({ refs: [ref('INVOICE', 'F1')] }), ctx([op({ id: 9, invalidated: true, refs: [ref('INVOICE', 'F1')] })]));
    expect(d).toMatchObject({ outcome: 'MATCH_AND_ENRICH', operationId: 9, matchMethod: 'M1' });
  });

  it('F-053 preuve d’un événement distinct → l’invalidée n’est ni certaine ni plausible : nouvelle Opération', () => {
    const d = decideCandidate(cand({ refs: [ref('INVOICE', 'F2')] }), ctx([op({ id: 9, invalidated: true, refs: [ref('INVOICE', 'F1')] })]));
    expect(d).toMatchObject({ outcome: 'CREATE_NEW' });
    expect(d.detail.plausible).toEqual([]);
  });
});

describe('B19 — montant contradictoire de même rôle', () => {
  const comps = (sourceId: number, amountMinor: number) => ({
    sourceId, components: componentsFromIdentity(cand({ refs: [ref('INVOICE', 'FA-1')], hints: [{ role: 'REALIZED_COST', amountMinor, currency: 'EUR', amountScope: 'TOTAL' }] })),
  });

  it('C19-10 même facture, deux montants : contradiction signalée, la plus ancienne preuve reste retenue (aucune donnée ambiguë modifiée)', () => {
    const r = consolidateComponentsDetailed([comps(2, 120000), comps(1, 100000)]);
    expect(r.components).toHaveLength(1);
    expect(r.components[0]).toMatchObject({ amountMinor: 100000, sourceIds: [1, 2] });
    expect(r.conflicts).toEqual([expect.objectContaining({
      kind: 'REALIZED_COST', resolvedByUser: false, retained: { amountMinor: 100000, currency: 'EUR' },
      options: [{ amountMinor: 100000, currency: 'EUR', sourceIds: [1] }, { amountMinor: 120000, currency: 'EUR', sourceIds: [2] }],
    })]);
  });

  it('C19-11 décision utilisateur : le montant choisi l’emporte, jamais additionné ; F-062 une seule preuve n’est jamais une contradiction', () => {
    const fp = componentsFromIdentity(cand({ refs: [ref('INVOICE', 'FA-1')], hints: [{ role: 'REALIZED_COST', amountMinor: 1, currency: 'EUR', amountScope: 'TOTAL' }] }))[0].fingerprint;
    const r = consolidateComponentsDetailed([comps(1, 100000), comps(2, 120000)], new Map([[fp, { amountMinor: 120000, currency: 'EUR' }]]));
    expect(r.components).toHaveLength(1);
    expect(r.components[0].amountMinor).toBe(120000);
    expect(r.conflicts[0].resolvedByUser).toBe(true);
    expect(consolidateComponentsDetailed([comps(1, 120000)]).conflicts).toEqual([]);
  });
});
