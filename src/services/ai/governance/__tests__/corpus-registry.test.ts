/**
 * Corpus de référence — CDC §11.1 et critère d'acceptation n°22.
 *
 * Le corpus reste à constituer (décision du 28/07/2026 : « le recetteur s'en
 * chargera »). Ces tests garantissent que son absence est SIGNALÉE plutôt que
 * silencieuse : un corpus vide ne doit jamais laisser croire que la
 * non-régression a été vérifiée.
 */
import { describe, it, expect } from 'vitest';
import {
  CORPUS_CATEGORIES, registerCorpusCase, listCorpusCases,
  listEmptyCategories, isCorpusComplete, computeRunSummary,
} from '../corpus/corpus-registry';

describe('couverture attendue', () => {
  it('déclare les treize catégories du §11.1', () => {
    expect(CORPUS_CATEGORIES).toHaveLength(13);
  });

  it.each([
    'acte_immobilier', 'dpe', 'facture_multibiens', 'carte_grise',
    'contrat_loa_lld', 'avis_echeance', 'rapport_entretien', 'garantie',
    'facture_equipement', 'document_contradictoire',
    'multi_fichiers_meme_document', 'page_web', 'document_sans_information',
  ])('inclut « %s »', (cat) => {
    expect(CORPUS_CATEGORIES).toContain(cat);
  });
});

describe('signalement d\'un corpus incomplet', () => {
  it('signale toutes les catégories vides tant qu\'aucun cas n\'est fourni', () => {
    const { complete, missing } = isCorpusComplete();
    if (listCorpusCases().length === 0) {
      expect(complete).toBe(false);
      expect(missing).toHaveLength(13);
    }
  });

  it('retire une catégorie des manquantes dès qu\'un cas est enregistré', () => {
    registerCorpusCase({
      caseId: 'dpe-anonymise-1', category: 'dpe',
      fixturePath: 'dpe/cas-1.json', expected: { documentType: 'DPE' },
    });
    expect(listEmptyCategories()).not.toContain('dpe');
    expect(listCorpusCases('dpe')).toHaveLength(1);
  });
});

describe('synthèse d\'exécution', () => {
  it('calcule les moyennes de coût et de durée', () => {
    const summary = computeRunSummary('p', 'v1', [
      { caseId: 'a', category: 'dpe', schemaValid: true, expectedMatch: true, documentTypeCorrect: true, crossAssetLeak: false, usedFallback: false, costMicros: 100, durationMs: 1000 },
      { caseId: 'b', category: 'dpe', schemaValid: true, expectedMatch: true, documentTypeCorrect: true, crossAssetLeak: false, usedFallback: false, costMicros: 200, durationMs: 3000 },
    ], 5);
    expect(summary.avgCostMicros).toBe(150);
    expect(summary.avgDurationMs).toBe(2000);
    expect(summary.criticalFieldsCorrect).toBe(5);
  });

  it('ne divise jamais par zéro sur un corpus vide', () => {
    const summary = computeRunSummary('p', 'v1', [], 0);
    expect(summary.avgCostMicros).toBe(0);
    expect(summary.avgDurationMs).toBe(0);
  });
});
