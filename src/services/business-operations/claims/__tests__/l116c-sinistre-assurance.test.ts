/**
 * Lot 116C (carte Trello #806 §3) — règles PURES de la recherche de
 * l'assurance d'un sinistre : couverture à la date, une correspondance fiable,
 * question, abstention ; référentiel des justificatifs d'assurance ; carte de
 * proposition. Aucune base, aucune IA.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLAIM_INSURANCE_QUESTIONS_MAX, coverageAt, decideClaimInsurance, type CoveragePeriod, type InsuranceCandidate } from '../insurance-association';
import { INSURANCE_CONTRACT_DOCUMENT_TYPES, isInsuranceContractDocumentType } from '@/lib/referential/v2/insurance-contract-document-types';
import { DOCUMENT_TYPES } from '@/lib/referential/v2/document-types';
import { claimInsuranceQuestion, isOperationRelationContext } from '@/services/to-process/operation-relation-cards';

const p = (start: string | null, end: string | null, over: Partial<CoveragePeriod> = {}): CoveragePeriod => ({ start, end, openEnded: false, unsettled: false, ...over });
const c = (operationId: number, periods: CoveragePeriod[] = [], references: string[] = []): InsuranceCandidate => ({ operationId, periods, references });
const JOUR = '2026-03-12';

describe('L116C-A-U01 — couverture à la date de survenance', () => {
  it('une période établie aux bornes complètes couvre ; fin inconnue, date partielle ou période contestée ne prouvent rien', () => {
    expect(coverageAt([p('2026-01-01', '2026-12-31')], JOUR)).toBe('COVERS');
    expect(coverageAt([p('2026-03-12', '2026-03-12')], JOUR)).toBe('COVERS');
    expect(coverageAt([p('2026-01-01', null, { openEnded: true })], JOUR)).toBe('COVERS');
    expect(coverageAt([p('2026-01-01', null)], JOUR)).toBe('UNKNOWN');
    expect(coverageAt([p('2026', '2026-12-31')], JOUR)).toBe('UNKNOWN');
    expect(coverageAt([p(null, '2026-12-31')], JOUR)).toBe('UNKNOWN');
    expect(coverageAt([p('2026-01-01', '2026-12-31', { unsettled: true })], JOUR)).toBe('UNKNOWN');
    expect(coverageAt([], JOUR)).toBe('UNKNOWN');
    expect(coverageAt([p('2026-01-01', '2026-12-31')], null)).toBe('UNKNOWN');
    expect(coverageAt([p('2026-01-01', '2026-12-31')], '2026-03')).toBe('UNKNOWN');
  });
  it('toutes les périodes établies excluent la date → hors couverture ; une seule qui ne l’exclut pas suffit au doute', () => {
    expect(coverageAt([p('2024-01-01', '2024-12-31'), p('2025-01-01', '2025-12-31')], JOUR)).toBe('OUTSIDE');
    expect(coverageAt([p('2026-06-01', null)], JOUR)).toBe('OUTSIDE');
    expect(coverageAt([p('2024-01-01', '2024-12-31'), p('2026-01-01', null)], JOUR)).toBe('UNKNOWN');
    expect(coverageAt([p('2024-01-01', '2024-12-31'), p('2026-01-01', '2026-12-31')], JOUR)).toBe('COVERS');
  });
});

describe('L116C-A-U02 — une correspondance fiable, sinon question, sinon abstention', () => {
  const faits = (over: Partial<{ occurredOn: string | null; policyReferences: string[] }> = {}) => ({ occurredOn: JOUR, policyReferences: [], ...over });
  it('zéro contrat : abstention', () => {
    expect(decideClaimInsurance(faits(), [])).toEqual({ outcome: 'ABSTAIN', reason: 'NO_CONTRACT' });
  });
  it('un seul contrat qui couvre la date : association ; couverture non établie : question ; hors couverture : abstention', () => {
    expect(decideClaimInsurance(faits(), [c(7, [p('2026-01-01', '2026-12-31')])])).toEqual({ outcome: 'ASSOCIATE', contractOperationId: 7, basis: 'ASSET_AND_PERIOD' });
    expect(decideClaimInsurance(faits(), [c(7)])).toEqual({ outcome: 'ASK', contractOperationIds: [7], reason: 'COVERAGE_NOT_ESTABLISHED' });
    expect(decideClaimInsurance(faits({ occurredOn: null }), [c(7, [p('2026-01-01', '2026-12-31')])])).toEqual({ outcome: 'ASK', contractOperationIds: [7], reason: 'COVERAGE_NOT_ESTABLISHED' });
    expect(decideClaimInsurance(faits(), [c(7, [p('2024-01-01', '2024-12-31')])])).toEqual({ outcome: 'ABSTAIN', reason: 'NO_COMPATIBLE_CONTRACT' });
  });
  it('plusieurs contrats possibles : jamais de choix d’office — question, les plus probants d’abord, bornée', () => {
    const d = decideClaimInsurance(faits(), [c(9), c(7, [p('2026-01-01', '2026-12-31')]), c(8, [p('2026-01-01', '2026-12-31')])]);
    expect(d).toEqual({ outcome: 'ASK', contractOperationIds: [7, 8, 9], reason: 'SEVERAL_CONTRACTS' });
    const beaucoup = decideClaimInsurance(faits(), [1, 2, 3, 4, 5].map((id) => c(id)));
    expect(beaucoup.outcome === 'ASK' && beaucoup.contractOperationIds).toHaveLength(CLAIM_INSURANCE_QUESTIONS_MAX);
    // Deux contrats dont un hors couverture : il n'en reste qu'un, qui couvre → fiable.
    expect(decideClaimInsurance(faits(), [c(7, [p('2026-01-01', '2026-12-31')]), c(8, [p('2020-01-01', '2020-12-31')])]))
      .toEqual({ outcome: 'ASSOCIATE', contractOperationId: 7, basis: 'ASSET_AND_PERIOD' });
  });
  it('police citée par le sinistre : désigne le contrat qui la porte, écarte celui qui en porte une autre', () => {
    const cite = faits({ policyReferences: ['hab2026001'] });
    expect(decideClaimInsurance(cite, [c(7, [], ['hab2026001']), c(8, [p('2026-01-01', '2026-12-31')], ['emp77'])]))
      .toEqual({ outcome: 'ASSOCIATE', contractOperationId: 7, basis: 'POLICY_REFERENCE' });
    // La police désignée mais hors couverture établie : plus aucune correspondance fiable, l'autre police reste écartée.
    expect(decideClaimInsurance(cite, [c(7, [p('2020-01-01', '2020-12-31')], ['hab2026001']), c(8, [], ['emp77'])]))
      .toEqual({ outcome: 'ABSTAIN', reason: 'NO_COMPATIBLE_CONTRACT' });
    // Deux contrats portent la police citée : question entre eux seulement.
    expect(decideClaimInsurance(cite, [c(7, [], ['hab2026001']), c(8, [], ['hab2026001']), c(9)]))
      .toEqual({ outcome: 'ASK', contractOperationIds: [7, 8], reason: 'SEVERAL_CONTRACTS' });
    // Un contrat sans référence connue n'est pas contredit par la police citée.
    expect(decideClaimInsurance(cite, [c(9, [p('2026-01-01', '2026-12-31')])])).toEqual({ outcome: 'ASSOCIATE', contractOperationId: 9, basis: 'ASSET_AND_PERIOD' });
  });
});

describe('L116C-A-U03 — référentiel et carte', () => {
  it('justificatifs d’assurance : codes du référentiel V2 (rubrique Assurances et sinistres), anciens codes par correspondance certaine, jamais une pièce de sinistre', () => {
    const codes = new Map(DOCUMENT_TYPES.map((t) => [t.code, t.rubric]));
    for (const code of INSURANCE_CONTRACT_DOCUMENT_TYPES) expect(codes.get(code), code).toBe('INSURANCE_CLAIMS');
    for (const code of ['INSURANCE_POLICY', 'INSURANCE_CERTIFICATE', 'INSURANCE_DUE_NOTICE', 'CONTRAT_ASSURANCE', 'ATTESTATION_ASSURANCE', 'POLICE_ASSURANCE']) expect(isInsuranceContractDocumentType(code), code).toBe(true);
    for (const code of ['CLAIM_DECLARATION', 'CLAIM_REPORT', 'CLAIM_INDEMNITY', 'MAINTENANCE_CONTRACT', 'WARRANTY_CERTIFICATE', 'DECLARATION_SINISTRE', '', null, undefined]) expect(isInsuranceContractDocumentType(code), String(code)).toBe(false);
  });
  it('aucune règle métier écrite dans la recherche : ni libellé, ni assureur, ni type de sinistre, ni IA', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/business-operations/claims/insurance-association.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/ILIKE|technical_label|provider|claim_type|DEGAT|INCENDIE|gateway|prompt/i);
    expect(src).not.toMatch(/\b(INSERT INTO|UPDATE |DELETE FROM)\b/);
    expect(src).not.toMatch(/mergeOperations/);
  });
  it('question de la proposition : neutre, dit « opérations », ne promet aucune prise en charge', () => {
    const q = claimInsuranceQuestion('Sinistre — Dégât des eaux', 'Contrat — Assurance habitation');
    expect(q).toBe('Faut-il associer « Sinistre — Dégât des eaux » et « Contrat — Assurance habitation » ? Associer ces deux opérations permet de consulter le contrat d’assurance depuis le sinistre ; cela ne dit pas que l’assureur prend le sinistre en charge.');
    expect(q).not.toMatch(/événement de référence/);
  });
  it('contexte de carte : arbitrage (relation refusée connue) OU proposition (aucune relation) — jamais un mélange', () => {
    const base = { kind: 'operation_relation', pairKey: '1:2', fromOperationId: 1, toOperationId: 2, nature: 'ASSOCIATED', evidence: [], evidenceKeys: [], events: [], documents: [] };
    expect(isOperationRelationContext({ ...base, relationId: 5, relationVersion: 2 })).toBe(true);
    expect(isOperationRelationContext({ ...base, relationId: null, relationVersion: null, proposal: 'CLAIM_INSURANCE' })).toBe(true);
    expect(isOperationRelationContext({ ...base, relationId: null, relationVersion: null })).toBe(false);
    expect(isOperationRelationContext({ ...base, relationId: 5, relationVersion: 2, proposal: 'CLAIM_INSURANCE' })).toBe(false);
    expect(isOperationRelationContext({ ...base, relationId: null, relationVersion: null, proposal: 'AUTRE' })).toBe(false);
  });
});
