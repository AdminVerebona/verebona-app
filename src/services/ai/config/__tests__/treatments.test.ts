/**
 * CDC BO IA §1.3 — correspondance traitements T1-T5 ↔ usages du référentiel.
 *
 * Deux documents écrits à deux mois d'intervalle nomment les mêmes cinq
 * traitements différemment. Si la correspondance se déséquilibre, une version
 * de configuration s'appliquerait au mauvais traitement — ou ne couvrirait pas
 * tout le périmètre IA, ce que le GEN-002 exige pourtant.
 */
import { describe, it, expect } from 'vitest';
import {
  TREATMENTS, TREATMENT_DEFINITIONS, treatmentForUseCase,
  listBatchTreatments, assertTreatmentMapping, isTreatment,
} from '../treatments';
import { AI_USE_CASE_CODES } from '../../registry/use-cases';

describe('la correspondance est bijective', () => {
  it('couvre les cinq usages du référentiel, sans doublon', () => {
    expect(() => assertTreatmentMapping()).not.toThrow();
    expect(TREATMENTS).toHaveLength(AI_USE_CASE_CODES.length);
  });

  it('se parcourt dans les deux sens', () => {
    for (const t of TREATMENTS) {
      expect(treatmentForUseCase(TREATMENT_DEFINITIONS[t].useCaseCode)).toBe(t);
    }
  });

  it('associe chaque traitement à l’usage attendu', () => {
    expect(TREATMENT_DEFINITIONS.T1.useCaseCode).toBe('SOURCE_ANALYSIS');
    expect(TREATMENT_DEFINITIONS.T2.useCaseCode).toBe('INTELLIGENT_ASSISTANT');
    expect(TREATMENT_DEFINITIONS.T3.useCaseCode).toBe('DATA_RECONCILIATION');
    expect(TREATMENT_DEFINITIONS.T4.useCaseCode).toBe('AGENDA_INTELLIGENCE');
    expect(TREATMENT_DEFINITIONS.T5.useCaseCode).toBe('AI_GOVERNANCE');
  });
});

describe('file globale (GEN-004)', () => {
  it('ne retient que T1, T3 et T4', () => {
    // T2 et T5 sont synchrones : ils n'ont ni file ni déclencheurs, et l'écran
    // ne doit pas leur en proposer.
    expect(listBatchTreatments()).toEqual(['T1', 'T3', 'T4']);
  });
});

describe('garde-fous', () => {
  it('reconnaît un code de traitement valide', () => {
    expect(isTreatment('T3')).toBe(true);
    expect(isTreatment('T6')).toBe(false);
    expect(isTreatment('SOURCE_ANALYSIS')).toBe(false);
  });

  it('lève plutôt que de deviner sur un usage inconnu', () => {
    // Renvoyer un défaut appliquerait la configuration d'un autre traitement.
    expect(() => treatmentForUseCase('INEXISTANT' as never)).toThrow();
  });
});
