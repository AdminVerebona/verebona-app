/**
 * Aide produit en contexte — CDC Centre d'aide §5, T2-03, T2-04, T2-05,
 * ENV-02 ; CDC Assistant §8.1, §8.2, §10.5, §10.6, §13.3, §22.7, §27.1.
 *
 *  · choix des articles selon écran / type d'objet / plateforme / rôle ;
 *  · refus en cas de contradiction entre articles, renvoi au support ;
 *  · réponse utile en Standard : extrait + lien vers l'ARTICLE précis ;
 *  · contexte de page (bien ouvert) extrait, validé, transmis ;
 *  · suggestions propres à chaque page.
 */
import { describe, it, expect, vi } from 'vitest';
import type { HelpCorpus, HelpCorpusArticle } from '../help-corpus.service';

vi.mock('@/db', () => ({
  pgClient: { unsafe: vi.fn(async () => []) },
  db: {},
  ensureMigrations: vi.fn(async () => {}),
  ensureUnaccent: vi.fn(async () => {}),
}));

const help = await import('../help-corpus.service');
const { runAssistant } = await import('../assistant-orchestrator.service');
const { construireActionIntents } = await import('../ports');
const { resolveActions } = await import('../action-resolver.service');
const { routeForIntent } = await import('../intent-router.service');
const { sanitizePageContext } = await import('../page-context');
const { enrichPageContext, helpScreenForRoute } = await import('@/lib/help-center/screens');
const { isHelpPath } = await import('@/lib/help-center/open');
const { suggestionsForRoute } = await import('../../registries/capability-registry');

const art = (over: Partial<HelpCorpusArticle>): HelpCorpusArticle => ({
  id: 'AID-X', title: 'Titre', path: '/aide/titre', category: 'c', categoryName: 'C', summary: '',
  offers: ['standard', 'premium', 'premium_duo'], offersLabel: 'Toutes les offres', offersNote: null,
  synonyms: [], sections: [], ...over,
});

const CORPUS: HelpCorpus = {
  schema: 'verebona-help-t2-v1', version: 't', environment: 'preprod',
  articles: [
    art({
      id: 'AID-DOC-001', title: 'Ajouter un document', path: '/aide/ajouter-un-document', synonyms: ['déposer', 'importer'],
      screens: ['Mes documents'], platforms: ['web', 'mobile'],
      sections: [{ anchor: 'procedure', heading: 'Procédure', text: 'Ouvrez Documents puis choisissez Ajouter un document. Sélectionnez le fichier, 25 Mo maximum par document, puis validez.' }],
    }),
    art({
      id: 'AID-ASSET-010', title: 'Ajouter un document à un bien', path: '/aide/ajouter-document-bien', synonyms: ['déposer', 'importer'],
      screens: ['Fiche bien', 'Fiche bien > Documents'], objectTypes: ['bien'],
      sections: [{ anchor: 'procedure', heading: 'Procédure', text: 'Depuis la fiche du bien, onglet Documents, choisissez Ajouter un document puis sélectionnez le fichier.' }],
    }),
    art({
      id: 'AID-MOB-001', title: 'Scanner un document sur mobile', path: '/aide/scanner-mobile', platforms: ['mobile'],
      sections: [{ anchor: 'procedure', heading: 'Procédure', text: 'Sur mobile, touchez Scanner pour ajouter un document photographié.' }],
    }),
  ],
};

describe('choix des articles selon le contexte (T2-05)', () => {
  it('écran : sur la fiche d’un bien, l’article de l’onglet Documents du bien passe devant', () => {
    const q = 'comment ajouter un document ?';
    const sans = help.searchHelpCorpus(CORPUS, q);
    const surBien = help.searchHelpCorpus(CORPUS, q, 4, help.helpContextFromPage({ route: '/assets/42', platform: 'web' }));
    expect(surBien[0].article.id).toBe('AID-ASSET-010');
    expect(sans[0].score).toBeLessThanOrEqual(surBien[0].score);
  });

  it('plateforme : un article réservé au mobile n’est pas proposé sur le web', () => {
    const web = help.searchHelpCorpus(CORPUS, 'scanner un document', 4, help.helpContextFromPage({ route: '/documents', platform: 'web' }));
    const mobile = help.searchHelpCorpus(CORPUS, 'scanner un document', 4, help.helpContextFromPage({ route: '/documents', platform: 'mobile' }));
    expect(web.some((h) => h.article.id === 'AID-MOB-001')).toBe(false);
    expect(mobile.some((h) => h.article.id === 'AID-MOB-001')).toBe(true);
  });

  it('rôle : un article réservé à un autre rôle est rétrogradé, pas masqué', () => {
    const a = art({ roles: ['billing_owner'] });
    expect(help.contextWeight(a, { screens: [], objectType: null, platform: null, role: 'duo_member' })).toBeCloseTo(0.6);
    expect(help.contextWeight(art({ roles: ['all'] }), { screens: [], objectType: null, platform: null, role: 'duo_member' })).toBe(1);
  });

  it('routes → libellés d’écran du référentiel du Centre d’aide', () => {
    expect(helpScreenForRoute('/assets/42').screens).toContain('Fiche bien');
    expect(helpScreenForRoute('/accueil/a-traiter').screens).toEqual(['À traiter']);
    expect(helpScreenForRoute('/documents/9?x=1').objectType).toBe('document');
  });
});

describe('contradiction entre articles (T2-04)', () => {
  const src = (id: string, titre: string, texte: string, score = 0.9) => ({
    id: `help_${id}__procedure`, type: 'help_entry', title: titre, content: texte, relevanceScore: score,
    meta: { articleId: id, path: `/aide/${id.toLowerCase()}` },
  }) as never;

  it('deux articles également pertinents, 25 Mo contre 10 Mo : contradiction détectée', () => {
    const c = help.detectHelpContradiction([src('AID-A', 'Ajouter', 'Taille maximale : 25 Mo par document.'), src('AID-B', 'Importer', 'Chaque fichier ne doit pas dépasser 10 Mo.', 0.85)]);
    expect(c).toMatchObject({ articles: ['AID-A', 'AID-B'], unit: 'mo' });
    expect(help.contradictionAnswer(c!)).toMatch(/ne peux pas vous répondre de façon fiable.*support/);
  });

  it('valeurs identiques, article nettement moins pertinent ou un seul article : pas de contradiction', () => {
    expect(help.detectHelpContradiction([src('AID-A', 'A', '25 Mo'), src('AID-B', 'B', '25 Mo')])).toBeNull();
    expect(help.detectHelpContradiction([src('AID-A', 'A', '25 Mo', 0.9), src('AID-B', 'B', '10 Mo', 0.3)])).toBeNull();
    expect(help.detectHelpContradiction([src('AID-A', 'A', '25 Mo'), src('AID-A', 'A', 'autre section 10 Mo')])).toBeNull();
  });

  it('orchestrateur : pas de réponse, étayage « conflicting », bouton « Contacter le support », alerte éditoriale', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sources = [src('AID-A', 'Ajouter', 'Taille maximale : 25 Mo par document.'), src('AID-B', 'Importer', 'Limite de 10 Mo.', 0.85)];
    const generateWithAI = vi.fn();
    const out = await runAssistant(
      { accountId: 1, userId: 1, planType: 'PREMIUM', message: 'Comment ajouter un document ?', clientRequestId: 'c', locale: 'fr-FR' },
      {
        retrieve: async () => sources, resolveSources: async (s) => s as never, persist: async () => null,
        hasPendingClarification: async () => false, generateWithAI,
        resolveActions: (route, input, s) => resolveActions({ accountId: 1, intent: route.intent, actionIntents: construireActionIntents(route, input, s), access: ACCESS }),
      },
    );
    expect(generateWithAI).not.toHaveBeenCalled();
    expect(out.supportLevel).toBe('conflicting');
    expect(out.answer).toMatch(/ne peux pas vous répondre de façon fiable/);
    expect(out.actions.map((a) => a.type)).toContain('OPEN_CONTACT');
    expect(out.actions.find((a) => a.type === 'OPEN_CONTACT')!.href).toBe('/aide?page=%2Fcontact');
    expect(warn.mock.calls.some((c) => /alerte-éditoriale.*AID-A.*AID-B/.test(String(c[0])))).toBe(true);
    warn.mockRestore();
  });
});

const ACCESS = {
  assetInAccount: async () => true, documentInAccount: async () => true, agendaItemInAccount: async () => true,
  helpEntryPublished: async (id: string) => CORPUS.articles.some((a) => a.id === id) || id.startsWith('AID-'),
};

describe('réponse d’aide en Standard : extrait + lien vers l’article précis (§10.5, §10.6)', () => {
  it('le repli contient l’extrait de la section et nomme l’article', () => {
    const sources = help.toHelpSources(help.searchHelpCorpus(CORPUS, 'ajouter un document'), 'STANDARD');
    const txt = help.fallbackFromHelpSources(sources);
    expect(txt).toMatch(/D’après l’article « Ajouter un document/);
    expect(txt).toMatch(/choisissez Ajouter un document/);
    expect(txt.length).toBeLessThan(600);
  });

  it('orchestrateur Standard : aucune IA, extrait, bouton « Lire l’article » vers l’article', async () => {
    const generateWithAI = vi.fn();
    const out = await runAssistant(
      { accountId: 1, userId: 1, planType: 'STANDARD', message: 'Comment ajouter un document ?', clientRequestId: 'c', locale: 'fr-FR', pageContext: { route: '/documents', platform: 'web' } },
      {
        retrieve: async (_r, input) => help.toHelpSources(help.searchHelpCorpus(CORPUS, input.message, 4, help.helpContextFromPage(input.pageContext)), input.planType),
        resolveSources: async (s) => s as never, persist: async () => null, hasPendingClarification: async () => false, generateWithAI,
        resolveActions: (route, input, s) => resolveActions({ accountId: 1, intent: route.intent, actionIntents: construireActionIntents(route, input, s), access: ACCESS }),
      },
    );
    expect(generateWithAI).not.toHaveBeenCalled();
    expect(out.answer).toMatch(/Ouvrez Documents puis choisissez Ajouter un document/);
    const lire = out.actions.find((a) => a.type === 'OPEN_HELP');
    expect(lire?.label).toBe('Lire l’article');
    expect(lire?.href).toBe('/aide?page=%2Faide%2Fajouter-un-document');
    // L'action métier reste la principale (§22.9).
    expect(out.actions[0].type).toBe('START_ADD_DOCUMENT');
  });

  it('question d’aide sans article : aveu + « Contacter le support » (T2-03)', async () => {
    const out = await runAssistant(
      { accountId: 1, userId: 1, planType: 'STANDARD', message: 'Comment ajouter un document ?', clientRequestId: 'c', locale: 'fr-FR' },
      {
        retrieve: async () => [], resolveSources: async () => [], persist: async () => null, hasPendingClarification: async () => false,
        resolveActions: (route, input, s) => resolveActions({ accountId: 1, intent: route.intent, actionIntents: construireActionIntents(route, input, s), access: ACCESS }),
      },
    );
    expect(out.answer).toMatch(/ne peux pas répondre de façon fiable/);
    expect(out.actions.map((a) => a.type)).toContain('OPEN_CONTACT');
  });

  it('le lien d’aide n’accepte que des chemins d’aide et le contact', () => {
    expect(isHelpPath('/contact')).toBe(true);
    expect(isHelpPath('/contact?x=1')).toBe(false);
    const route = routeForIntent('PRODUCT_HELP_HOW_TO', 'STANDARD', 't');
    const intents = construireActionIntents(route, { message: 'aide', accountId: 1 } as never, [
      { id: 'h', type: 'help_entry', title: 'T', content: '', relevanceScore: 1, meta: { articleId: 'AID-DOC-001', path: 'https://evil.example' } } as never,
    ]);
    return resolveActions({ accountId: 1, intent: route.intent, actionIntents: intents, access: ACCESS }).then((a) => {
      expect(a.find((x) => x.type === 'OPEN_HELP')?.href).toBe('/aide');
    });
  });
});

describe('corpus de l’environnement (ENV-02)', () => {
  it('production ne lit que le corpus de production, préproduction le sien ; local libre', () => {
    expect(help.corpusMatchesEnvironment('production', 'production')).toBe(true);
    expect(help.corpusMatchesEnvironment('preprod', 'production')).toBe(false);
    expect(help.corpusMatchesEnvironment('production', 'staging')).toBe(false);
    expect(help.corpusMatchesEnvironment('preprod', 'local')).toBe(true);
    expect(help.corpusMatchesEnvironment('preprod', undefined)).toBe(true);
  });
});

describe('contexte de page (§13.3, §27.1)', () => {
  it('le bien / document ouverts sont extraits de la route, avec la plateforme', () => {
    expect(enrichPageContext({ route: '/assets/42' }, 'web')).toEqual({ route: '/assets/42', assetId: '42', platform: 'web' });
    expect(enrichPageContext({ route: '/documents/9' }, 'mobile')).toMatchObject({ documentId: '9', platform: 'mobile' });
    expect(enrichPageContext({ route: '/assets/42', assetId: '7' })!.assetId).toBe('7');
  });

  it('le serveur ne garde que les clés connues, aux formats attendus', () => {
    expect(sanitizePageContext({ route: '/assets/42', assetId: '42', platform: 'web', accountId: 99, extra: 'x' })).toEqual({ route: '/assets/42', assetId: '42', platform: 'web' });
    expect(sanitizePageContext({ route: '//evil', assetId: '42 OR 1=1', documentId: -3, platform: 'tv' })).toBeUndefined();
    expect(sanitizePageContext('x')).toBeUndefined();
    expect(sanitizePageContext({ assetId: 42 })).toEqual({ assetId: '42' });
  });

  it('« Ajouter un document » vise le bien ouvert', async () => {
    const route = routeForIntent('ACCOUNT_MISSING_INFORMATION', 'PREMIUM', 't');
    const intents = construireActionIntents(route, { message: 'que manque-t-il ?', accountId: 1, pageContext: { assetId: '42' } } as never, []);
    expect(intents).toContainEqual({ type: 'START_ADD_DOCUMENT', targetId: 'asset_42' });
  });
});

describe('suggestions contextuelles par page (§8.1, §8.2)', () => {
  const labels = (r: string) => suggestionsForRoute(r).map((s) => s.id);
  it('fiche d’un bien : suggestions du bien, jamais celles de l’accueil', () => {
    const l = labels('/assets/42');
    expect(l.slice(0, 3)).toEqual(['asset_docs', 'asset_deadlines', 'asset_complete']);
    expect(l.some((x) => x.startsWith('home_'))).toBe(false);
  });
  it('accueil : suggestions d’accueil ; agenda, À traiter, compte : les leurs', () => {
    expect(labels('/accueil')[0]).toBe('home_priority');
    expect(labels('/')[0]).toBe('home_priority');
    expect(labels('/agenda')[0]).toBe('agenda_next');
    expect(labels('/accueil/a-traiter')[0]).toBe('todo_explain');
    expect(labels('/mon-compte')[0]).toBe('account_plan');
  });
  it('page sans suggestion propre : 3 génériques, sans doublon', () => {
    const l = suggestionsForRoute('/page-inconnue');
    expect(l).toHaveLength(3);
    expect(new Set(l.map((s) => s.label)).size).toBe(3);
  });
});
