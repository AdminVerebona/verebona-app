/**
 * Matrice de décision — CDC V2.0 §10.1, §11.3.
 *
 * Les sept lignes de la matrice sont testées une par une, ainsi que les
 * critères AI-01, AI-02 et AI-03. Ce sont les règles dont la violation ne se
 * voit pas : une valeur utilisateur écrasée ne produit aucune erreur, juste
 * un utilisateur qui ne retrouve plus ce qu'il avait saisi.
 */
import { describe, it, expect } from 'vitest';
import { decide, producesAction } from '@/services/to-process/decision-engine';
import type { ActionProposal } from '@/services/to-process/action-model';

const proposal = (
  value: string,
  confidence: number,
  extra: Partial<ActionProposal> = {},
): ActionProposal => ({ value, label: value, confidence, ...extra });

const documentRubric = {
  targetType: 'DOCUMENT' as const,
  key: 'rubricCode',
};

describe('donnée absente (§11.3, lignes 1 à 3)', () => {
  it('AI-01 — applique automatiquement à 90 %', () => {
    const decision = decide({
      ...documentRubric,
      currentValue: null,
      userValidated: false,
      proposals: [proposal('MAINTENANCE_WORKS', 0.9)],
    });
    expect(decision.decision).toBe('APPLY');
    expect(decision.valueToWrite).toBe('MAINTENANCE_WORKS');
    expect(decision.origin).toBe('RECONCILIATION');
  });

  it('n’applique pas à 89 % — le seuil est un seuil', () => {
    const decision = decide({
      ...documentRubric,
      currentValue: null,
      userValidated: false,
      proposals: [proposal('MAINTENANCE_WORKS', 0.89)],
    });
    expect(decision.decision).toBe('ARBITRATE');
    expect(decision.reasonCode).toBe('LOW_CONFIDENCE_PROPOSAL');
  });

  it('crée une complétion quand une règle attend la donnée', () => {
    const decision = decide({
      ...documentRubric,
      currentValue: null,
      userValidated: false,
      proposals: [],
    });
    expect(decision.decision).toBe('COMPLETE');
    expect(decision.ruleCode).toBe('DOC-RUB');
  });

  it('P-06 — n’en crée aucune sans règle justificative', () => {
    const decision = decide({
      targetType: 'DOCUMENT',
      key: 'notes',
      currentValue: null,
      userValidated: false,
      proposals: [],
    });
    expect(decision.decision).toBe('IGNORE');
    expect(decision.reasonCode).toBe('NO_RULE_JUSTIFIES_COMPLETION');
  });

  it('§10.5 — un champ couvert mais sans complétion autorisée reste ignoré', () => {
    // DATA-SUPPLIER porte completePriority: null — « absence seule : aucune action ».
    const decision = decide({
      targetType: 'DOCUMENT',
      key: 'supplier',
      currentValue: null,
      userValidated: false,
      proposals: [],
    });
    expect(decision.decision).toBe('IGNORE');
  });
});

describe('valeur validée par l’utilisateur (§12.2, AI-02, AI-03)', () => {
  it('AI-02 — n’est jamais écrasée, même à 100 %', () => {
    const decision = decide({
      ...documentRubric,
      currentValue: 'PROPERTY_MANAGEMENT',
      userValidated: true,
      proposals: [proposal('MAINTENANCE_WORKS', 1)],
    });
    expect(decision.decision).toBe('ARBITRATE');
    expect(decision.valueToWrite).toBeUndefined();
  });

  it('AI-03 — la valeur actuelle reste active et figure dans l’arbitrage', () => {
    const decision = decide({
      ...documentRubric,
      currentValue: 'PROPERTY_MANAGEMENT',
      userValidated: true,
      proposals: [proposal('MAINTENANCE_WORKS', 0.95)],
    });
    const current = decision.proposals?.find((p) => p.isCurrentValue);
    expect(current?.value).toBe('PROPERTY_MANAGEMENT');
    expect(decision.proposals?.some((p) => p.value === 'MAINTENANCE_WORKS')).toBe(true);
  });

  it('ne demande rien quand la proposition confirme la valeur utilisateur', () => {
    const decision = decide({
      ...documentRubric,
      currentValue: 'MAINTENANCE_WORKS',
      userValidated: true,
      proposals: [proposal('MAINTENANCE_WORKS', 0.95)],
    });
    expect(decision.decision).toBe('KEEP');
    expect(decision.reasonCode).toBe('USER_VALUE_CONFIRMED');
  });
});

describe('valeur existante non protégée (§11.3, ligne 5)', () => {
  it('remplace une valeur d’origine IA sur meilleure preuve', () => {
    const decision = decide({
      ...documentRubric,
      currentValue: 'OTHER_DOCUMENTS',
      currentOrigin: 'RECONCILIATION',
      userValidated: false,
      currentConfidence: 0.6,
      proposals: [proposal('COMPLIANCE_CONTROLS', 0.97)],
    });
    expect(decision.decision).toBe('UPDATE');
    expect(decision.valueToWrite).toBe('COMPLIANCE_CONTROLS');
  });

  it('n’écrit pas sous le seuil, même sans protection', () => {
    const decision = decide({
      ...documentRubric,
      currentValue: 'OTHER_DOCUMENTS',
      userValidated: false,
      proposals: [proposal('COMPLIANCE_CONTROLS', 0.7)],
    });
    expect(decision.decision).toBe('ARBITRATE');
  });

  it('ne fait rien quand la proposition confirme la valeur en place', () => {
    const decision = decide({
      ...documentRubric,
      currentValue: 'COMPLIANCE_CONTROLS',
      userValidated: false,
      proposals: [proposal('COMPLIANCE_CONTROLS', 0.99)],
    });
    expect(decision.decision).toBe('KEEP');
  });
});

describe('sources contradictoires (§11.3, avant-dernière ligne)', () => {
  it('n’écrase rien lorsque deux propositions se valent', () => {
    const decision = decide({
      ...documentRubric,
      currentValue: null,
      userValidated: false,
      proposals: [
        proposal('MAINTENANCE_WORKS', 0.95),
        proposal('PROPERTY_MANAGEMENT', 0.93),
      ],
    });
    expect(decision.decision).toBe('ARBITRATE');
    expect(decision.reasonCode).toBe('CONTRADICTORY_SOURCES');
  });

  it('tranche lorsqu’une proposition se détache nettement', () => {
    const decision = decide({
      ...documentRubric,
      currentValue: null,
      userValidated: false,
      proposals: [
        proposal('MAINTENANCE_WORKS', 0.97),
        proposal('PROPERTY_MANAGEMENT', 0.4),
      ],
    });
    expect(decision.decision).toBe('APPLY');
  });
});

describe('production d’actions', () => {
  it('seuls ARBITRATE et COMPLETE alimentent la file', () => {
    expect(producesAction('ARBITRATE')).toBe(true);
    expect(producesAction('COMPLETE')).toBe(true);
    expect(producesAction('APPLY')).toBe(false);
    expect(producesAction('UPDATE')).toBe(false);
    expect(producesAction('KEEP')).toBe(false);
    expect(producesAction('IGNORE')).toBe(false);
  });
});
