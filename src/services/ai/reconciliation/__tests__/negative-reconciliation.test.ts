/**
 * Réconciliation négative — CDC 15 T3-04 (lot 13). Fonctions pures.
 */
import { describe, it, expect } from 'vitest';
import {
  planRetractions, retractionDecision, withoutStaleAuthority, NEGATIVE_REASON,
} from '../negative-reconciliation';
import { isUnprovenAutomaticValue } from '../evidence-collector';
import { decide } from '../decision/decision-matrix';
import type { DecisionInput, EvidenceCandidate } from '../types';

const kc = {
  acquisitionDate: '2024-01-02', acquisitionDate__origin: 'RECONCILIATION', acquisitionDate__authority: 60,
  insurer: 'MAIF', insurer__origin: 'USER',
  mileage: 1000, mileage__origin: 'DOCUMENT_EXTRACTION',
  serialNumber: 'SN', serialNumber__origin: 'IMPORT',
  prixAchat: '749', prixAchat__origin: 'RECONCILIATION',
  vieux: 'x', vieux_origin: 'auto',
  coherenceAlerts: [],
};

describe('planRetractions', () => {
  const r = (fieldKey: string, value: unknown) => ({ fieldKey, value });

  it('retire seulement une valeur AUTOMATIQUE dont la preuve retirée portait CETTE valeur', () => {
    const out = planRetractions(kc, [], [r('acquisitionDate', '2024-01-02'), r('insurer', 'MAIF'), r('serialNumber', 'SN'), r('mileage', 1000)]);
    expect(out.map((x) => x.fieldKey).sort()).toEqual(['acquisitionDate', 'mileage']);
  });

  it('jamais USER/ADMIN, jamais IMPORT/SYSTEM_RULE, jamais une valeur sans historique de preuve', () => {
    expect(planRetractions(kc, [], [r('insurer', 'MAIF'), r('serialNumber', 'SN')])).toEqual([]);
    // `vieux` (ancien `_origin = auto`) n'a jamais eu de preuve : conservé.
    expect(planRetractions(kc, [], [])).toEqual([]);
  });

  it('relecture lot 13 : preuve retirée d’un AUTRE document, de valeur différente → la valeur historique reste', () => {
    expect(planRetractions(kc, [], [r('acquisitionDate', '2019-05-05'), r('mileage', 2000)])).toEqual([]);
    // Même valeur, écriture différente (normalisation) : retirée.
    expect(planRetractions(kc, [], [r('acquisitionDate', '02/01/2024')]).map((x) => x.fieldKey)).toEqual(['acquisitionDate']);
  });

  it('une preuve ACTIVE restante (même sous un alias) empêche le retrait', () => {
    expect(planRetractions(kc, ['acquisitionDate'], [r('acquisitionDate', '2024-01-02')])).toEqual([]);
    expect(planRetractions(kc, ['acquisitionPrice'], [r('prixAchat', '749')])).toEqual([]);
    expect(planRetractions(kc, [], [r('acquisitionPrice', 749)]).map((x) => x.fieldKey)).toEqual(['prixAchat']);
  });

  it('décision enregistrée : update vers vide (plus de mode observation, lot 16b-3)', () => {
    const c = { fieldKey: 'mileage', currentValue: 1000, origin: 'DOCUMENT_EXTRACTION' as const };
    expect(retractionDecision(c)).toMatchObject({ action: 'update', proposedValue: null, reasonCode: NEGATIVE_REASON.RETRACT });
    expect(NEGATIVE_REASON).not.toHaveProperty('SHADOW_RETRACT');
  });
});

describe('valeur automatique qui n’est plus prouvée', () => {
  const cand = (over: Partial<EvidenceCandidate>): EvidenceCandidate => ({
    evidenceId: 1, value: '2024-05-05', normalized: '2024-05-05', confidence: 'certain', authorityScore: 55,
    documentType: 'FACTURE', documentDate: new Date('2024-05-05'), sourceId: 9, excerpt: 'x', ...over,
  });
  const input: DecisionInput = {
    fieldKey: 'acquisitionDate', isCritical: false,
    current: { value: '2024-01-02', normalized: '2024-01-02', origin: 'RECONCILIATION', updatedAt: new Date(), authorityScore: 100, sourceDate: new Date('2030-01-01') },
    candidates: [cand({})],
  };

  it('détection : automatique, renseignée, aucune preuve ne la reproduit', () => {
    expect(isUnprovenAutomaticValue(input.current, input.candidates)).toBe(true);
    expect(isUnprovenAutomaticValue({ ...input.current!, origin: 'USER' }, input.candidates)).toBe(false);
    expect(isUnprovenAutomaticValue(input.current, [cand({ normalized: '2024-01-02' })])).toBe(false);
    expect(isUnprovenAutomaticValue(input.current, [])).toBe(false);
    // Relecture lot 13 : IMPORT et SYSTEM_RULE ne perdent jamais leur autorité.
    expect(isUnprovenAutomaticValue({ ...input.current!, origin: 'IMPORT' }, input.candidates)).toBe(false);
    expect(isUnprovenAutomaticValue({ ...input.current!, origin: 'SYSTEM_RULE' }, input.candidates)).toBe(false);
    expect(isUnprovenAutomaticValue({ ...input.current!, origin: 'DOCUMENT_EXTRACTION' }, input.candidates)).toBe(true);
  });

  it('sans l’autorité mémorisée de la preuve disparue, la meilleure preuve restante l’emporte', () => {
    expect(decide(input).action).toBe('keep'); // autorité 100 mémorisée : la valeur fantôme résistait
    expect(decide(withoutStaleAuthority(input))).toMatchObject({ action: 'update', proposedValue: '2024-05-05' });
  });

  it('une valeur USER contredite reste un conflit (jamais écrasée)', () => {
    const user = { ...input, current: { ...input.current!, origin: 'USER' as const } };
    expect(decide(withoutStaleAuthority(user)).action).toBe('create_conflict');
  });
});
