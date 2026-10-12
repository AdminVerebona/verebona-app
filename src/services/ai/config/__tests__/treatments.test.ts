/**
 * CDC BO IA §1.3 — correspondance traitements ↔ usages du référentiel.
 * Lot 49 (ticket 12) : T5 supprimé ; AI_GOVERNANCE devient un usage
 * TECHNIQUE, indépendant des traitements.
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
  RETIRED_TREATMENTS, TECHNICAL_USE_CASES, isRetiredTreatment, isTechnicalUseCase, treatmentOfUseCase,
  isMasterPromptAdministrable,
} from '../treatments';
import { AI_USE_CASE_CODES } from '../../registry/use-cases';

describe('la correspondance est bijective', () => {
  it('T12-AC05 — couvre les usages MÉTIER du référentiel, sans doublon : exactement T1, T2, T3, T4, T6', () => {
    expect(() => assertTreatmentMapping()).not.toThrow();
    expect([...TREATMENTS]).toEqual(['T1', 'T2', 'T3', 'T4', 'T6']);
    expect(TREATMENTS).toHaveLength(AI_USE_CASE_CODES.length - TECHNICAL_USE_CASES.length);
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
    expect(TREATMENT_DEFINITIONS.T6.useCaseCode).toBe('HOME_MASCOT');
    expect(Object.keys(TREATMENT_DEFINITIONS)).not.toContain('T5');
  });
});

describe('file globale (GEN-004)', () => {
  it('ne retient que T1, T3 et T4', () => {
    // T2 et T6 sont synchrones : ils n'ont ni file ni déclencheurs, et l'écran
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

describe('Lot 49 — T5 retiré, AI_GOVERNANCE technique (ticket 12)', () => {
  it('T12-AC05 / T12-AC11 — T5 n’est plus un traitement : inconnu du référentiel, connu seulement comme retiré (historique)', () => {
    expect(isTreatment('T5')).toBe(false);
    expect([...RETIRED_TREATMENTS]).toEqual(['T5']);
    expect(isRetiredTreatment('T5')).toBe(true);
    expect(isRetiredTreatment('T1')).toBe(false);
    expect(isMasterPromptAdministrable('T5')).toBe(false);
    expect(TREATMENTS.every(isMasterPromptAdministrable)).toBe(true);
  });

  it('T12-AC06 — AI_GOVERNANCE est un usage TECHNIQUE sans traitement (ne requiert plus T5)', () => {
    expect(isTechnicalUseCase('AI_GOVERNANCE')).toBe(true);
    expect(treatmentOfUseCase('AI_GOVERNANCE')).toBeNull();
    expect(() => treatmentForUseCase('AI_GOVERNANCE')).toThrow();
    expect(treatmentOfUseCase('HOME_MASCOT')).toBe('T6');
    expect(AI_USE_CASE_CODES).toContain('AI_GOVERNANCE');
  });
});
