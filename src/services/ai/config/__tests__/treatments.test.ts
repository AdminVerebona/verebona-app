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
  isPromptAdministrable, T5_TARGETS,
} from '../treatments';
import { emptyTreatmentConfig, normalizeTreatmentConfig } from '../config-types';
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
    expect(isTreatment('T6')).toBe(true);
    expect(isTreatment('T7')).toBe(false);
    expect(isTreatment('SOURCE_ANALYSIS')).toBe(false);
  });

  it('lève plutôt que de deviner sur un usage inconnu', () => {
    // Renvoyer un défaut appliquerait la configuration d'un autre traitement.
    expect(() => treatmentForUseCase('INEXISTANT' as never)).toThrow();
  });
});

describe('prompt administrable (T5-001, T5-003, écart E-02)', () => {
  it('T1 à T4 et T6 ont un prompt administrable, T5 non', () => {
    expect(TREATMENTS.filter(isPromptAdministrable)).toEqual(['T1', 'T2', 'T3', 'T4', 'T6']);
    // CDC Mascotte BO-008 : T5 peut faire évoluer la charte de voix de T6.
    expect(T5_TARGETS).toEqual(['T1', 'T2', 'T3', 'T4', 'T6']);
  });

  it('la normalisation vide le prompt de T5 et laisse les autres intacts', () => {
    const t5 = { ...emptyTreatmentConfig('T5'), prompt: 'texte hérité', primaryModel: 'm' };
    expect(normalizeTreatmentConfig(t5)).toEqual({ ...t5, prompt: '' });
    const t1 = { ...emptyTreatmentConfig('T1'), prompt: 'prompt T1' };
    expect(normalizeTreatmentConfig(t1)).toBe(t1);
  });
});
