/**
 * Centre d'aide : les encadrés « Limites et points d'attention » (consignes de
 * rédaction) ne sont jamais cités par l'assistant.
 */
import { describe, expect, it } from 'vitest';
import { isEditorialSection, parseHelpCorpus } from '../help-corpus.service';

const article = {
  id: 'AID-ASSET-001', title: 'Créer un bien', path: '/aide/creer-un-bien', category: 'c', categoryName: 'C',
  summary: '', offers: [], offersLabel: '', offersNote: null, synonyms: [], status: 'published', validatedAt: '2026-09-01',
  sections: [
    { anchor: 'etapes', heading: 'Étapes', text: 'Cliquez sur Ajouter.' },
    { anchor: 'limites', heading: 'Limites et points d’attention', text: 'Le Centre d’aide ne doit pas promettre de contournement.' },
  ],
};

describe('sections éditoriales', () => {
  it('reconnues (apostrophes droite et typographique, singulier, casse)', () => {
    for (const h of ['Limites et points d’attention', "Limites et points d'attention", 'limite et point d’attention']) {
      expect(isEditorialSection({ heading: h })).toBe(true);
    }
    expect(isEditorialSection({ heading: 'Limites de l’offre Standard' })).toBe(false);
  });

  it('retirées du corpus lu par l’assistant ; le reste de l’article est conservé', () => {
    const c = parseHelpCorpus({ schema: 'verebona-help-t2-v1', articles: [article] });
    expect(c?.articles[0].sections.map((s) => s.heading)).toEqual(['Étapes']);
  });
});
