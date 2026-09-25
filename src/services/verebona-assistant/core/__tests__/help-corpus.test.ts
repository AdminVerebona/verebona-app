/**
 * L'assistant répond aux questions d'usage depuis le Centre d'aide — CDC
 * Centre d'aide V1 §5, T2-01 à T2-08, ENV-02.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HelpCorpus } from '../help-corpus.service';

vi.mock('@/db', () => ({
  pgClient: { unsafe: vi.fn(async () => { throw new Error('aucune requête base attendue'); }) },
  ensureUnaccent: vi.fn(async () => {}),
}));

const {
  searchHelpCorpus, toHelpSources, fallbackFromHelpSources, parseHelpCorpus, setHelpCorpusForTests,
  helpArticlePublished, isHelpIntent, helpCorpusUrl,
} = await import('../help-corpus.service');
const { retrieve } = await import('../retrieval.service');
const { resolveSourcesForDisplay } = await import('../source-resolver.service');
const { INTENT_DEFINITIONS } = await import('../../registries/intent-registry');

const ALL = ['standard', 'premium', 'premium_duo'];
const CORPUS: HelpCorpus = {
  schema: 'verebona-help-t2-v1', version: 'test', environment: 'preprod',
  articles: [
    {
      id: 'AID-AGENDA-006', title: 'Synchroniser les échéances avec son agenda personnel',
      path: '/aide/synchroniser-agenda-personnel', category: 'agenda-echeances', categoryName: 'Agenda et échéances',
      summary: 'Ajouter l’agenda Verebona à Apple Agenda, Google Agenda ou Outlook.',
      offers: ['premium', 'premium_duo'], offersLabel: 'Premium, Premium Duo', offersNote: null,
      synonyms: ['agenda', 'synchronisation', 'calendrier', 'google'],
      sections: [
        { anchor: 'presentation', heading: 'Présentation', text: 'Les offres Premium publient un lien de calendrier.' },
        { anchor: 'procedure', heading: 'Procédure', text: '1. Ouvrez la synchronisation agenda — Depuis Mon compte.\n2. Générez le lien.' },
      ],
    },
    {
      id: 'AID-DOC-001', title: 'Ajouter un document', path: '/aide/ajouter-un-document',
      category: 'documents', categoryName: 'Documents', summary: 'Importer un fichier ou un justificatif.',
      offers: ALL, offersLabel: 'Toutes les offres', offersNote: null,
      synonyms: ['importer', 'téléverser', 'fichier', 'justificatif'],
      sections: [{ anchor: 'procedure', heading: 'Procédure', text: '1. Ouvrez Mes documents — Choisissez Ajouter un document.' }],
    },
  ],
};

beforeEach(() => setHelpCorpusForTests(CORPUS));

describe('intentions d’aide (§5)', () => {
  it('les cinq intentions d’usage déclenchent la recherche dans le Centre d’aide', () => {
    for (const i of ['PRODUCT_HELP_HOW_TO', 'PRODUCT_HELP_EXPLAIN', 'PRODUCT_HELP_STATUS', 'NAVIGATION_FIND', 'EXPORT_HELP'] as const) {
      expect(isHelpIntent(i), i).toBe(true);
      expect(INTENT_DEFINITIONS[i].requiresRetrieval, i).toBe(true);
    }
    expect(isHelpIntent('ACCOUNT_SEARCH_DOCUMENT')).toBe(false);
  });
});

describe('recherche dans le corpus', () => {
  it('retrouve l’article d’une question d’usage courante', () => {
    const hits = searchHelpCorpus(CORPUS, 'Comment synchroniser mon agenda Google ?');
    expect(hits[0].article.id).toBe('AID-AGENDA-006');
  });

  it('ne retient rien de hors sujet — T2-03 plutôt qu’une procédure inventée', () => {
    expect(searchHelpCorpus(CORPUS, 'quelle est la météo à Lyon ?')).toEqual([]);
  });

  it('cite au plus deux sections par article', () => {
    const hits = searchHelpCorpus(CORPUS, 'agenda synchronisation calendrier lien', 10);
    expect(hits.filter((h) => h.article.id === 'AID-AGENDA-006').length).toBeLessThanOrEqual(2);
  });
});

describe('sources citables (§5, T2-02, T2-06, T2-07, T2-08)', () => {
  it('une source par section, identifiée par l’ID stable, sans donnée du compte', () => {
    const [s] = toHelpSources(searchHelpCorpus(CORPUS, 'ajouter un document'), 'PREMIUM');
    expect(s.id).toBe('help_AID-DOC-001__procedure');
    expect(s.type).toBe('help_entry');
    expect(s.meta).toMatchObject({ articleId: 'AID-DOC-001', path: '/aide/ajouter-un-document#procedure' });
  });

  it('signale à un compte Standard qu’une fonction Premium n’est pas incluse (T2-07)', () => {
    const [s] = toHelpSources(searchHelpCorpus(CORPUS, 'synchroniser agenda'), 'STANDARD');
    expect(s.content).toMatch(/réservée à : Premium, Premium Duo/);
    expect(s.content).toMatch(/pas incluse dans l’offre actuelle/);
    expect(s.meta?.notIncludedInPlan).toBe(true);
  });

  it('ne pousse pas de changement d’offre (T2-08)', () => {
    const [s] = toHelpSources(searchHelpCorpus(CORPUS, 'synchroniser agenda'), 'STANDARD');
    expect(s.content).not.toMatch(/passez|abonnez|souscri|upgrade/i);
  });

  it('ne signale rien quand l’offre du compte inclut la fonction', () => {
    const [s] = toHelpSources(searchHelpCorpus(CORPUS, 'synchroniser agenda'), 'PREMIUM');
    expect(s.content).not.toMatch(/pas incluse/);
  });

  it('s’affiche comme une source cliquable vers l’article, dans l’aide intégrée', () => {
    const [shown] = resolveSourcesForDisplay(toHelpSources(searchHelpCorpus(CORPUS, 'ajouter un document')));
    expect(shown.typeLabel).toBe('Aide');
    expect(shown.openAction).toMatchObject({ type: 'OPEN_HELP', href: '/aide?page=%2Faide%2Fajouter-un-document' });
  });
});

describe('retrieval : pour une question d’usage, le Centre d’aide seul (§5, T2-01, T2-06)', () => {
  it('n’interroge aucune donnée du compte', async () => {
    const sources = await retrieve(
      { intent: 'PRODUCT_HELP_HOW_TO' } as never,
      { accountId: 1, userId: 1, message: 'comment ajouter un document ?', planType: 'PREMIUM' } as never,
    );
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((s) => s.type === 'help_entry')).toBe(true);
  });

  it('corpus indisponible : aucune source, donc l’aveu explicite (T2-03)', async () => {
    setHelpCorpusForTests(null);
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('réseau'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sources = await retrieve(
      { intent: 'PRODUCT_HELP_EXPLAIN' } as never,
      { accountId: 1, userId: 1, message: 'à quoi sert le Duo ?', planType: 'PREMIUM' } as never,
    );
    expect(sources).toEqual([]);
    expect(fallbackFromHelpSources(sources)).toMatch(/ne peux pas répondre de façon fiable.*contacter le support/);
  });
});

describe('repli sans modèle', () => {
  it('cite les articles trouvés', () => {
    const txt = fallbackFromHelpSources(toHelpSources(searchHelpCorpus(CORPUS, 'synchroniser agenda')));
    expect(txt).toMatch(/« Synchroniser les échéances avec son agenda personnel »/);
    expect(txt).not.toMatch(/votre compte/);
  });
});

describe('corpus de l’environnement (ENV-02)', () => {
  it('se lit sur le site public de l’environnement, ou HELP_CENTER_URL', () => {
    expect(helpCorpusUrl()).toMatch(/\/aide\/corpus-t2\.json$/);
    vi.stubEnv('HELP_CENTER_URL', 'https://preprod.verebona.fr/');
    expect(helpCorpusUrl()).toBe('https://preprod.verebona.fr/aide/corpus-t2.json');
    vi.unstubAllEnvs();
  });

  it('refuse un fichier au format inattendu', () => {
    expect(parseHelpCorpus({ schema: 'autre' })).toBeNull();
    expect(parseHelpCorpus(CORPUS)).not.toBeNull();
  });

  it('OPEN_HELP n’accepte qu’un article publié ici', async () => {
    await expect(helpArticlePublished('AID-DOC-001')).resolves.toBe(true);
    await expect(helpArticlePublished('AID-DOSSIER-007')).resolves.toBe(false);
  });
});

describe('génération : aucun échange précédent pour une question d’utilisation (T2-06)', () => {
  it('ne transmet pas le fil de conversation au modèle', async () => {
    const execute = vi.fn(async () => ({ data: { claims: [] }, model: 'm' }));
    vi.doMock('@/services/ai/gateway/ai-gateway', () => ({ AiGateway: { execute } }));
    vi.doMock('@/services/ai/flags/use-case-flags', () => ({ isUseCaseRunning: () => true }));
    vi.resetModules();
    const { generateAssistantAnswer } = await import('../generation.adapter');
    const sources = toHelpSources(searchHelpCorpus(CORPUS, 'ajouter un document'));
    await generateAssistantAnswer(
      { intent: 'PRODUCT_HELP_HOW_TO' } as never, sources,
      { accountId: 1, userId: 1, message: 'comment ajouter un document ?', threadContextText: 'Facture EDF 1 234 € du 12/03' } as never,
    );
    const vars = (execute.mock.calls[0] as unknown as [{ promptVariables: Record<string, string> }])[0].promptVariables;
    expect(vars.CONVERSATION).not.toMatch(/EDF|1 234/);
    expect(vars.CONVERSATION).toMatch(/Centre d’aide/);
  });
});
