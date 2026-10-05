/**
 * Centre d'aide : les encadrés « Limites et points d'attention » (consignes de
 * rédaction) ne sont jamais cités par l'assistant.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({
  pgClient: { unsafe: vi.fn(async () => { throw new Error('aucune requête base attendue'); }) },
  ensureUnaccent: vi.fn(async () => {}),
}));
vi.mock('../../events/business-events', () => ({ emitBusinessEvent: vi.fn(async () => {}) }));

const {
  isEditorialSection, parseHelpCorpus, stripEditorialParagraphs, loadHelpCorpus, resetHelpCorpusCacheForTests,
  setHelpCorpusStoreForTests, searchHelpCorpus,
} = await import('../help-corpus.service');

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

  it('encadré DANS le texte d’une section (forme du corpus publié) : paragraphe retiré, le reste conservé', () => {
    const texte = 'Le compte est créé.\nLimites et points d’attention — Le Centre d’aide ne doit pas promettre de contournement.\nRésultat attendu — Le compte est actif.';
    expect(stripEditorialParagraphs(texte)).toBe('Le compte est créé.\nRésultat attendu — Le compte est actif.');
    expect(stripEditorialParagraphs("limite et point d'attention : rien\n\nSuite")).toBe('Suite');
    // Mention ordinaire, sans encadré : conservée.
    expect(stripEditorialParagraphs('Voir les limites de l’offre Standard.')).toBe('Voir les limites de l’offre Standard.');

    const c = parseHelpCorpus({
      schema: 'verebona-help-t2-v1',
      articles: [{
        ...article,
        sections: [
          { anchor: 'p', heading: 'Procédure', text: 'Cliquez sur Ajouter.\nLimites et points d’attention — Le Centre d’aide ne doit pas promettre de contournement.' },
          { anchor: 'x', heading: 'Détails', text: "Limites et points d'attention — Seul paragraphe." },
        ],
      }],
    });
    expect(c?.articles[0].sections).toEqual([{ anchor: 'p', heading: 'Procédure', text: 'Cliquez sur Ajouter.' }]);
    expect(searchHelpCorpus(c!, 'promettre contournement')).toEqual([]);
  });

  it('encadré sur PLUSIEURS lignes : paragraphe entier retiré, jusqu’à la ligne vide ou au bloc suivant', () => {
    const avant = [
      'Cliquez sur Ajouter.',
      'Limites et points d’attention — Le Centre d’aide ne doit pas',
      'promettre de contournement du quota,',
      'ni citer de délai.',
      '',
      'Le bien est créé.',
    ].join('\n');
    expect(stripEditorialParagraphs(avant)).toBe('Cliquez sur Ajouter.\nLe bien est créé.');
    // Arrêt au bloc suivant (encadré, étape, intitulé), même sans ligne vide.
    for (const suivant of ['Résultat attendu — Le compte est actif.', '2. Validez.', '## Après', '- Puce']) {
      expect(stripEditorialParagraphs(`A.\nLimites et points d'attention — x\nsuite de x\n${suivant}`)).toBe(`A.\n${suivant}`);
    }
    // Deux encadrés successifs.
    expect(stripEditorialParagraphs('Limites et points d’attention — a\nb\n\nC.\nLimite et point d’attention : d\ne'))
      .toBe('C.');
  });

  it('dernier corpus valide relu en base : encadrés retirés aussi', async () => {
    process.env.NEXT_PUBLIC_APP_ENV = 'preprod';
    resetHelpCorpusCacheForTests();
    const stocke = {
      schema: 'verebona-help-t2-v1', version: 'v1', environment: 'preprod',
      articles: [{ ...article, sections: [
        { anchor: 'p', heading: 'Procédure', text: 'Cliquez sur Ajouter.\nLimites et points d’attention — Ne pas promettre de contournement.' },
        article.sections[1],
      ] }],
    };
    setHelpCorpusStoreForTests({ read: async () => ({ corpus: stocke, at: '2026-09-01T00:00:00.000Z' }), write: async () => {} });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = await loadHelpCorpus();
    expect(c?.articles[0].sections).toEqual([{ anchor: 'p', heading: 'Procédure', text: 'Cliquez sur Ajouter.' }]);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  setHelpCorpusStoreForTests(null);
  resetHelpCorpusCacheForTests();
});
