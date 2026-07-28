/**
 * Tests du référentiel — CDC §1.1 (exigence structurante) et §5.1.
 *
 * Ces tests sont la première ligne de défense du critère d'acceptation n°1 :
 * ils échouent si quelqu'un ajoute un sixième usage ou rattache une opération
 * à un usage inexistant.
 */
import { describe, it, expect } from 'vitest';
import {
  AI_USE_CASE_CODES, AI_USE_CASES, listActiveUseCases, isAiUseCaseCode,
} from '../use-cases';
import { AI_OPERATIONS, getOperation, listLlmOperations, listOperationsByUseCase } from '../operations';
import { assertAiRegistryStartup } from '../index';

describe('référentiel des usages', () => {
  it('déclare exactement cinq usages', () => {
    expect(AI_USE_CASE_CODES).toHaveLength(5);
    expect(listActiveUseCases()).toHaveLength(5);
  });

  it('couvre les onze usages historiques sans en oublier', () => {
    const covered = new Set(Object.values(AI_USE_CASES).flatMap((u) => u.replacesLegacyUsages));
    for (let legacy = 1; legacy <= 11; legacy++) {
      expect(covered.has(legacy), `usage historique ${legacy} non absorbé`).toBe(true);
    }
  });

  it('rejette un code d\'usage inconnu', () => {
    expect(isAiUseCaseCode('DOCUMENT_ANALYSIS')).toBe(false);
    expect(isAiUseCaseCode('SOURCE_ANALYSIS')).toBe(true);
  });
});

describe('catalogue des opérations', () => {
  it('rattache chaque opération à l\'un des cinq usages', () => {
    for (const op of Object.values(AI_OPERATIONS)) {
      expect(isAiUseCaseCode(op.useCaseCode), `${op.operationCode} mal rattachée`).toBe(true);
    }
  });

  it('échoue explicitement sur une opération inconnue', () => {
    expect(() => getOperation('ancienne_operation')).toThrow(/Opération inconnue/);
  });

  it('donne au moins une opération à chaque usage', () => {
    for (const code of AI_USE_CASE_CODES) {
      expect(listOperationsByUseCase(code).length, `${code} sans opération`).toBeGreaterThan(0);
    }
  });

  it('déclare un fournisseur et un modèle pour chaque opération à tarifer', () => {
    // Les tarifs ne sont plus dans le code : ils viennent de `ai_model_pricing`,
    // alimentée par le lot de rafraîchissement. Le test vérifie donc que chaque
    // opération est identifiable dans le catalogue, pas qu'elle y a un prix.
    for (const op of listLlmOperations()) {
      expect(op.provider).not.toBe('none');
      expect(op.primaryModel).toBeTruthy();
    }
  });

  it('sépare les modèles par famille de traitement — CDC Assistant §15.10', () => {
    const assistant = new Set(listOperationsByUseCase('INTELLIGENT_ASSISTANT')
      .filter((o) => o.provider !== 'none').map((o) => o.primaryModel));
    const documentaire = new Set(listOperationsByUseCase('SOURCE_ANALYSIS')
      .filter((o) => o.provider !== 'none').map((o) => o.primaryModel));
    // Un changement de modèle sur l'assistant ne doit pas toucher l'analyse.
    for (const m of assistant) expect(documentaire.has(m)).toBe(false);
  });

  it("n'utilise aucun modèle Pro pour l'assistant — CDC Assistant §31.2", () => {
    for (const op of listOperationsByUseCase('INTELLIGENT_ASSISTANT')) {
      for (const m of [op.primaryModel, ...op.fallbackModels]) {
        expect(m).not.toMatch(/-pro$/);
      }
    }
  });

  it("n'utilise aucun alias `latest` ni modèle `preview` — CDC Assistant §15.12-13", () => {
    for (const op of listLlmOperations()) {
      for (const m of [op.primaryModel, ...op.fallbackModels]) {
        expect(m).not.toMatch(/latest|preview/i);
      }
    }
  });

  it('exige un prompt versionné, sauf pour les prompts fournis à l\'appel', () => {
    // Un appel modèle à sortie structurée doit toujours reposer sur un prompt
    // sous gouvernance : soit déclaré dans le référentiel, soit — pour la seule
    // évaluation d'une version candidate — fourni à l'appel et explicitement
    // marqué comme tel.
    for (const op of listLlmOperations()) {
      if (op.outputSchema === 'none') continue;
      expect(
        Boolean(op.promptCode) || op.dynamicPrompt === true,
        `${op.operationCode} : ni promptCode, ni dynamicPrompt`,
      ).toBe(true);
    }
  });

  it('ne tolère le prompt dynamique que pour la gouvernance', () => {
    // Ouvrir cette porte ailleurs permettrait d'injecter un prompt échappant
    // au workflow de validation du §4.5.
    for (const op of Object.values(AI_OPERATIONS)) {
      if (op.dynamicPrompt) expect(op.useCaseCode).toBe('AI_GOVERNANCE');
    }
  });
});

describe('contrôles de démarrage', () => {
  it('passe sur le référentiel courant', () => {
    expect(() => assertAiRegistryStartup()).not.toThrow();
  });
});
