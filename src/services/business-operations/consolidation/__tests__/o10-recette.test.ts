/**
 * Lot 48 (O10) — recette Opérations V1 : cas C29 vérifiables par règles
 * PURES, dont les deux corrections de comportement du lot :
 *   · F-055 (C7.7) : OTHER → type connu conserve l'identité (TYPE_CHANGED) ;
 *   · F-096 (C12) : une remise lue sur la facture qui porte le coût est déjà
 *     intégrée à son total (aucune REDUCTION recréée).
 * Barrière T1 (sorties enregistrées, sans modèle) : F-006, F-009, F-023,
 * F-190. Les mêmes cas avec un VRAI modèle sont dans la check-list de
 * recette préprod (docs/recette/operations-v1-rapport.md, RP-03).
 */
import { describe, expect, it } from 'vitest';
import { decideCandidate, hardNegatives, type ExistingOperation, type MatchContext } from '../matching';
import { componentsFromIdentity, consolidateOperationState, type CandidateIdentity, type PersistedFinancialHint } from '../model';
import { gateOperationCandidates, type AnchoredOperationCandidate, type CandidateGateContext } from '@/services/ai/source-analysis/operation-candidates/prepare';

function ident(over: Partial<CandidateIdentity> = {}): CandidateIdentity {
  return {
    candidateId: 1, candidateKey: 'op1', fileId: 10, established: true, confidence: 'certain', type: 'INTERVENTION', status: 'REALIZED',
    role: 'INVOICE', summary: 's', provider: 'Garage', providerKey: 'garage', assetIds: [1], targetAuthority: 'DOCUMENT', equipmentIds: [],
    refs: [], dates: { plannedDate: null, startDate: null, realizedDate: '2026-06-02', endDate: null }, hints: [], ...over,
  };
}
const ref = (kind: CandidateIdentity['refs'][number]['kind'], value: string) => ({ kind, value, normalized: value.replace(/[^A-Z0-9]/gi, '').toUpperCase() });
const hint = (role: string, amountMinor: number, over: Partial<PersistedFinancialHint> = {}): PersistedFinancialHint => ({ role, amountMinor, currency: 'EUR', ...over });
function op(over: Partial<ExistingOperation> = {}): ExistingOperation {
  return {
    id: 100, typeCode: 'INTERVENTION', status: 'REALIZED', providerKey: 'garage', assetIds: [1], refs: [],
    plannedDate: null, startDate: null, realizedDate: '2026-06-01', endDate: null, ...over,
  };
}
const ctx = (operations: ExistingOperation[]): MatchContext => ({ operations, confirmed: new Set(), rejected: new Set(), assetStatus: new Map() });

describe('F-055 / C7.7 — OTHER requalifié vers un type connu : même identité', () => {
  it('F-055 — même source réanalysée en CONTRACT sur une Opération OTHER → M2 (même id), plus de SAME_SOURCE_TYPE_CHANGED', () => {
    const d = decideCandidate(ident({ type: 'CONTRACT', role: 'CONTRACT_DOCUMENT' }), ctx([op({ typeCode: 'OTHER', sameSource: true })]));
    expect(d).toMatchObject({ outcome: 'MATCH_AND_ENRICH', operationId: 100, matchMethod: 'M2' });
  });
  it('F-055 — référence exacte commune avec une Opération OTHER : rapprochement M1 (requalification permise)', () => {
    const d = decideCandidate(ident({ type: 'CONTRACT', role: 'CONTRACT_DOCUMENT', refs: [ref('INVOICE', 'TS-1')] }), ctx([op({ typeCode: 'OTHER', refs: [ref('INVOICE', 'TS-1')] })]));
    expect(d).toMatchObject({ outcome: 'MATCH_AND_ENRICH', operationId: 100, matchMethod: 'M1' });
  });
  it('F-055 — l’inverse reste incompatible : type connu → OTHER, et entre deux types connus (C5-11 inchangé)', () => {
    expect(hardNegatives(ident({ type: 'OTHER' }), op({ typeCode: 'CONTRACT' }))).toContain('TYPE_INCOMPATIBLE');
    expect(hardNegatives(ident({ type: 'CONTRACT' }), op({ typeCode: 'INTERVENTION' }))).toContain('TYPE_INCOMPATIBLE');
    expect(hardNegatives(ident({ type: 'CONTRACT' }), op({ typeCode: 'OTHER' }))).not.toContain('TYPE_INCOMPATIBLE');
    const d = decideCandidate(ident({ type: 'CONTRACT' }), ctx([op({ sameSource: true })]));
    expect(d.detail.excluded[0].why).toBe('SAME_SOURCE_TYPE_CHANGED');
  });
  it('F-055 / F-054 — état consolidé : OTHER → type connu commun à toutes les sources typées ; sources divergentes → OTHER conservé', () => {
    const s = (id: number, type: CandidateIdentity['type']) => ({ sourceId: id, identity: ident({ type, role: 'CONTRACT_DOCUMENT', dates: { plannedDate: null, startDate: '2026-01-01', realizedDate: null, endDate: null } }) });
    expect(consolidateOperationState('OTHER', [s(1, 'CONTRACT')], '2026-10-12').type).toBe('CONTRACT');
    expect(consolidateOperationState('OTHER', [s(1, 'CONTRACT'), s(2, null)], '2026-10-12').type).toBe('CONTRACT');
    expect(consolidateOperationState('OTHER', [s(1, 'CONTRACT'), s(2, 'OTHER')], '2026-10-12').type).toBe('OTHER');
    expect(consolidateOperationState('OTHER', [s(1, 'OTHER')], '2026-10-12').type).toBe('OTHER');
    expect(consolidateOperationState('INTERVENTION', [s(1, 'CONTRACT')], '2026-10-12').type).toBe('INTERVENTION');
    expect(consolidateOperationState(null, [s(1, 'CONTRACT')], '2026-10-12').type).toBe('CONTRACT');
  });
});

describe('F-096 / C12 — remise déjà intégrée au total : aucune double réduction', () => {
  it('F-096 — facture portant le coût ET une remise : seule la composante de coût (total net)', () => {
    const cs = componentsFromIdentity(ident({ refs: [ref('INVOICE', 'F1')], hints: [hint('REALIZED_COST', 125000, { amountScope: 'TOTAL' }), hint('REDUCTION', 10000)] }));
    expect(cs.map((c) => [c.kind, c.amountMinor])).toEqual([['REALIZED_COST', 125000]]);
  });
  it('F-096 — devis portant un coût prévu et une remise : remise intégrée aussi', () => {
    const cs = componentsFromIdentity(ident({ role: 'QUOTE', status: 'ENVISAGED', hints: [hint('FORECAST_COST', 50000), hint('REDUCTION', 5000)] }));
    expect(cs.map((c) => c.kind)).toEqual(['FORECAST_COST']);
  });
  it('F-095 / F-120 — un avoir (document distinct) reste une REDUCTION, même supérieure au coût', () => {
    expect(componentsFromIdentity(ident({ role: 'CREDIT_NOTE', hints: [hint('REDUCTION', 10000)] })).map((c) => c.kind)).toEqual(['REDUCTION']);
    expect(componentsFromIdentity(ident({ role: 'CREDIT_NOTE', hints: [hint('REALIZED_COST', 200000)] })).map((c) => [c.kind, c.amountMinor])).toEqual([['REDUCTION', 200000]]);
  });
  it('F-096 — remise seule sur un document sans coût (remise après facturation) : REDUCTION conservée', () => {
    expect(componentsFromIdentity(ident({ role: 'OTHER_EVIDENCE', hints: [hint('REDUCTION', 3000)] }))).toEqual([]);
    expect(componentsFromIdentity(ident({ role: null, hints: [hint('REDUCTION', 3000)] })).map((c) => c.kind)).toEqual(['REDUCTION']);
  });
});

// ── Barrière T1 (sorties enregistrées : sans modèle) ─────────────────────────

const gateCtx = (over: Partial<CandidateGateContext> = {}): CandidateGateContext => ({
  hasExploitableContent: true, documentTypeCode: 'REPAIR_INVOICE',
  verifiedIds: { ASSET: new Set([12]), EQUIPMENT: new Set([7]), ROOM: new Set() },
  capabilities: { rooms: true, equipments: true }, keptFactRefs: new Set(['f1', 'f2']), ...over,
});
const ancre = (over: Partial<AnchoredOperationCandidate> = {}): AnchoredOperationCandidate => ({
  candidateKey: 'op1', established: true, confidence: 'certain', typeHint: 'INTERVENTION', statusHint: 'REALIZED',
  summary: 'Réparation', sourceRoleHint: 'INVOICE', provider: null, targetHints: [], businessReferences: [],
  temporalHints: {}, financialHints: [{ role: 'REALIZED_COST', amountMinor: 100, currency: 'EUR', amountScope: null, economicDate: null, periodStart: null, periodEnd: null, factRef: 'f2' }],
  evidenceFactRefs: ['f1'], visualOnlyEvidence: false, exclusionReason: null, origin: 'PASS_1', adjustments: [], ...over,
});

describe('Barrière T1 — cas C29 sans modèle (sorties enregistrées)', () => {
  it('F-006 — garantie avec date de fin (type GARANTIE) : candidat non établi, aucune Opération possible', () => {
    const [c] = gateOperationCandidates([ancre({ temporalHints: { endDate: '2028-05-01' } })], gateCtx({ documentTypeCode: 'WARRANTY_CERTIFICATE' })).candidates;
    expect(c).toMatchObject({ established: false, exclusionReason: 'DOCUMENT_TYPE_NOT_BUSINESS' });
  });
  it('F-009 — DPE descriptif (sortie enregistrée DESCRIPTIVE_ONLY) : conservé non établi, motif tracé', () => {
    const r = gateOperationCandidates([ancre({ established: false, exclusionReason: 'DESCRIPTIVE_ONLY', financialHints: [] })], gateCtx({ documentTypeCode: 'DPE' }));
    expect(r.candidates).toEqual([expect.objectContaining({ established: false, exclusionReason: 'DESCRIPTIVE_ONLY' })]);
  });
  it('F-008 — DPE avec prestation facturée : le type DPE n’est pas « non métier », le candidat établi passe', () => {
    const [c] = gateOperationCandidates([ancre()], gateCtx({ documentTypeCode: 'DPE' })).candidates;
    expect(c).toMatchObject({ established: true });
  });
  it('F-023 / INV-FINAL-002 — montant isolé d’un ticket illisible (aucun fait localisable) : non établi, montant retiré', () => {
    const [c] = gateOperationCandidates([ancre({ evidenceFactRefs: ['illisible'], financialHints: [{ ...ancre().financialHints[0], factRef: 'illisible' }] })], gateCtx()).candidates;
    expect(c).toMatchObject({ established: false, exclusionReason: 'NO_EVIDENCE', financialHints: [] });
  });
  it('F-190 — compte Standard (sans capacité équipement) : cible équipement retirée, aucune dépendance équipement', () => {
    const cible = { type: 'EQUIPMENT' as const, entityId: 7, rawLabel: 'Chaudière', confidence: 'certain' as const };
    const [std] = gateOperationCandidates([ancre({ targetHints: [cible] })], gateCtx({ capabilities: { rooms: false, equipments: false } })).candidates;
    expect(std.targetHints).toEqual([]);
    const [prem] = gateOperationCandidates([ancre({ targetHints: [cible] })], gateCtx()).candidates;
    expect(prem.targetHints).toEqual([cible]);
  });
});
