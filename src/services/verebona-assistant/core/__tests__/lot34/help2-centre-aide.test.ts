/**
 * Lot 34G — ticket « T2 Aide produit : fiabiliser le Centre d'aide,
 * raccourcir les réponses et ouvrir directement les parcours de création ».
 *
 * Tests nommés HELP2-xx (tests obligatoires du §7 et critères
 * d'acceptation). Orchestrateur RÉEL (`runAssistant`), recherche d'aide
 * RÉELLE (`openHelpSearch` : chargement du corpus par HTTP — `fetch`
 * simulé —, dernier corpus valide, contexte), actions RÉELLES
 * (`construireActionIntents` + `resolveActions`), corpus RÉEL (instantané
 * publié du Centre d'aide). Le modèle est simulé et COMPTÉ.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@/db', () => ({
  pgClient: { unsafe: vi.fn(async () => []) },
  db: {}, ensureMigrations: vi.fn(async () => {}), ensureUnaccent: vi.fn(async () => {}),
}));
vi.mock('../../../events/business-events', () => ({ emitBusinessEvent: vi.fn(async () => {}), emitBusinessEvents: vi.fn(async () => {}) }));

const help = await import('../../help-corpus.service');
const { openHelpSearch } = await import('../../help-search.port');
const { runAssistant } = await import('../../assistant-orchestrator.service');
const { construireActionIntents } = await import('../../ports');
const { resolveActions } = await import('../../action-resolver.service');
const { toApiPayload } = await import('../../api-payload');
const { runHelpCascade } = await import('../../help-cascade');
const { buildT2ObservabilityTrace } = await import('@/services/ai/telemetry/t2-observability');
import type { HelpCorpus, HelpCorpusStore } from '../../help-corpus.service';
import type { OrchestratorPorts } from '../../assistant-orchestrator.service';
import type { AssistantRequestInput, AssistantRunResult, IntentRoute } from '../../../types/contracts';
import type { ResolvedSource, RetrievedSource } from '../../../types/sources';

const SNAPSHOT = join(__dirname, '../../../../../test/e2e/fixtures/help-corpus-t2.snapshot.json');
const BRUT = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Record<string, unknown>;
/** Corpus publié par le site de l'environnement donné. */
const publie = (environment: string, version = 'v-preprod-1') => ({ ...BRUT, environment, version });

const SITE_PREPROD = 'https://preprod.verebona.fr';
const FALLBACK = /pas trouvé dans le Centre d’aide d’information suffisamment fiable/;
const ACCESS = {
  assetInAccount: async (_a: number, id: number) => id !== 999,
  documentInAccount: async () => true,
  agendaItemInAccount: async () => true,
  helpEntryPublished: async (id: string) => id.startsWith('AID-'),
};

let reponse: () => Promise<Response>;
const fetchMock = vi.fn((..._a: unknown[]) => reponse());
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => async () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_ENV = 'preprod';
  process.env.NEXT_PUBLIC_PUBLIC_SITE_URL = SITE_PREPROD;
  delete process.env.HELP_CENTER_URL;
  help.resetHelpCorpusCacheForTests();
  help.setHelpCorpusStoreForTests(null);
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  reponse = json(publie('preprod'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  help.setHelpCorpusStoreForTests(null);
  delete process.env.NEXT_PUBLIC_APP_ENV;
  delete process.env.NEXT_PUBLIC_PUBLIC_SITE_URL;
  delete process.env.HELP_CENTER_URL;
});

/** Banc : ports réels de la cascade d'aide et des actions, modèle compté. */
function banc(o: { understand?: IntentRoute | null; generated?: string; openHelpSearch?: OrchestratorPorts['openHelpSearch'] } = {}) {
  const classify = vi.fn(async () => o.understand ?? null);
  const generate = vi.fn(async (_r: IntentRoute, sources: RetrievedSource[]) => (o.generated
    ? { answer: o.generated, claims: [{ text: o.generated, sourceIds: [sources[0]?.id].filter(Boolean) as string[] }], actions: [], supportLevel: 'supported' as const }
    : null));
  const retrieve = vi.fn(async () => [] as RetrievedSource[]);
  const ports: OrchestratorPorts = {
    retrieve,
    openHelpSearch: o.openHelpSearch ?? ((input) => openHelpSearch(input)),
    resolveSources: async (sources): Promise<ResolvedSource[]> => sources.map((s) => ({
      id: s.id, type: s.type, typeLabel: s.type, title: s.title, excerpt: s.content.slice(0, 240), isAvailable: true,
    })),
    classifyWithAI: classify,
    generateWithAI: generate as never,
    resolveActions: (route, input, s) => resolveActions({
      accountId: 1, intent: route.intent, actionIntents: construireActionIntents(route, input, s), access: ACCESS,
      planType: input.planType, planLimit: input.planLimit ?? null,
    }),
    persist: async () => null,
    hasPendingClarification: async () => false,
    isAiUnavailable: async () => false,
  };
  return {
    classify, generate, retrieve,
    ask: (message: string, extra: Partial<AssistantRequestInput> = {}) => runAssistant({
      accountId: 1, userId: 7, planType: 'PREMIUM', message, clientRequestId: `t-${Math.random()}`, locale: 'fr-FR', ...extra,
    } as AssistantRequestInput, ports),
    llmCalls: () => classify.mock.calls.length + generate.mock.calls.length,
  };
}

const articles = (r: AssistantRunResult) => [...new Set(r.sources.map((s) => s.id.replace(/^help_/, '').split('__')[0]))];
const verite = (r: AssistantRunResult) => buildT2ObservabilityTrace({ strategy: r.cascade?.strategy, sources: r.sources }).truthSource;
const phrases = (t: string) => t.split(/(?<=[.!?])\s+/).filter(Boolean);
const types = (r: AssistantRunResult) => r.actions.map((a) => a.type);

// ════════════════════════════════════════════════════════════════════════
// §1 et §7 — le bon article quand le corpus est disponible
// ════════════════════════════════════════════════════════════════════════
describe('HELP2 — Centre d’aide : le bon article, sans repli, sans IA', () => {
  it('HELP2-01 — « Comment ajouter un document ? » (préprod, corpus lu par HTTP) → PRODUCT_HELP_HOW_TO, AID-DOC-001, sourceCount ≥ 1, truthSource centre_aide, fallbackReason null, aiCalls 0, observabilité complète', async () => {
    const b = banc({ generated: 'ne doit pas servir' });
    const r = await b.ask('Comment ajouter un document ?');
    expect(fetchMock).toHaveBeenCalledWith(`${SITE_PREPROD}/aide/corpus-t2.json`, expect.anything());
    expect(r.route.intent).toBe('PRODUCT_HELP_HOW_TO');
    expect(articles(r)[0]).toBe('AID-DOC-001');
    expect(r.cascade?.sourceCount).toBeGreaterThanOrEqual(1);
    expect(verite(r)).toBe('centre_aide');
    expect(r.cascade?.fallbackReason ?? null).toBeNull();
    expect(r.cascade?.aiCalls).toBe(0);
    expect(b.llmCalls()).toBe(0);
    expect(r.answer).not.toMatch(FALLBACK);
    expect(r.cascade!.help!.observability).toMatchObject({
      corpusAvailable: true, corpusSource: 'live', corpusVersion: 'v-preprod-1',
      applicationEnvironment: 'preprod', corpusEnvironment: 'preprod', corpusDiagnostic: null,
      articleId: 'AID-DOC-001', fallbackReason: null,
    });
    expect(r.cascade!.help!.observability!.candidateCount).toBeGreaterThan(0);
    expect(r.cascade!.help!.observability!.sourceCount).toBeGreaterThanOrEqual(1);
  });

  it('HELP2-02 — « Comment importer un document ? » → AID-DOC-001, réponse courte, 0 appel IA', async () => {
    const b = banc();
    const r = await b.ask('Comment importer un document ?');
    expect(articles(r)[0]).toBe('AID-DOC-001');
    expect(phrases(r.answer).length).toBeLessThanOrEqual(2);
    expect(r.cascade?.fallbackReason ?? null).toBeNull();
    expect(b.llmCalls()).toBe(0);
  });

  it('HELP2-03 — « Comment ajouter un bien ? » → AID-ASSET-001, [Ajouter un bien] [Lire l’article], 0 appel IA', async () => {
    const b = banc();
    const r = await b.ask('Comment ajouter un bien ?');
    expect(r.route.intent).toBe('PRODUCT_HELP_HOW_TO');
    expect(articles(r)[0]).toBe('AID-ASSET-001');
    expect(r.answer).toBe('Pour créer un bien, choisissez la catégorie, choisissez le type puis donnez un nom clair. '
      + 'Enregistrez : le bien apparaît dans votre portefeuille et peut recevoir des documents et échéances.');
    expect(r.actions.slice(0, 2).map((a) => [a.type, a.label])).toEqual([['START_ADD_ASSET', 'Ajouter un bien'], ['OPEN_HELP', 'Lire l’article']]);
    expect(b.llmCalls()).toBe(0);
  });

  it('HELP2-04 — « Comment créer une échéance ? » → AID-AGENDA-001, [Créer une échéance] [Lire l’article], 0 appel IA', async () => {
    const b = banc();
    const r = await b.ask('Comment créer une échéance ?');
    expect(r.route.intent).toBe('PRODUCT_HELP_HOW_TO');
    expect(articles(r)[0]).toBe('AID-AGENDA-001');
    expect(phrases(r.answer).length).toBeLessThanOrEqual(2);
    expect(r.answer).toMatch(/^Pour créer un élément d’agenda, /);
    expect(r.actions.slice(0, 2).map((a) => [a.type, a.label])).toEqual([['START_ADD_AGENDA_ITEM', 'Créer une échéance'], ['OPEN_HELP', 'Lire l’article']]);
    expect(b.llmCalls()).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════
// §1 — diagnostics distincts du corpus
// ════════════════════════════════════════════════════════════════════════
describe('HELP2 — problèmes de corpus explicitement diagnostiqués', () => {
  it('HELP2-05 — timeout : HELP_CORPUS_TIMEOUT (vrai délai du téléchargement)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    reponse = () => new Promise<Response>(() => {});
    fetchMock.mockImplementationOnce((_u: unknown, init?: unknown) => new Promise<Response>((_res, rej) => {
      (init as RequestInit).signal!.addEventListener('abort', () => rej(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
    }));
    const p = help.loadHelpCorpus();
    await vi.advanceTimersByTimeAsync(help.HELP_CORPUS_FETCH_TIMEOUT_MS + 10);
    expect(await p).toBeNull();
    expect(help.helpCorpusHealth()).toMatchObject({ source: 'none', alert: { code: 'HELP_CORPUS_TIMEOUT' }, lastAttempt: { code: 'HELP_CORPUS_TIMEOUT' } });
  });

  it('HELP2-05b — timeout à la question : repli motivé HELP_CORPUS_TIMEOUT, support proposé, 0 appel IA', async () => {
    fetchMock.mockImplementationOnce(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); });
    const b = banc();
    const r = await b.ask('Comment ajouter un document ?');
    expect(r.answer).toMatch(FALLBACK);
    expect(r.cascade?.fallbackReason).toBe('HELP_CORPUS_TIMEOUT');
    expect(r.cascade!.help!.observability).toMatchObject({ corpusAvailable: false, corpusSource: 'none', corpusDiagnostic: 'HELP_CORPUS_TIMEOUT', articleId: null, sourceCount: 0 });
    expect(types(r)).toContain('OPEN_CONTACT');
    expect(b.llmCalls()).toBe(0);
  });

  it('HELP2-06 — HTTP KO : HELP_CORPUS_HTTP_ERROR (statut tracé), distinct d’un corpus injoignable', async () => {
    reponse = async () => new Response('Service Unavailable', { status: 503 });
    const r = await banc().ask('Comment ajouter un document ?');
    expect(r.cascade?.fallbackReason).toBe('HELP_CORPUS_HTTP_ERROR');
    expect(help.helpCorpusHealth()).toMatchObject({ alert: { code: 'HELP_CORPUS_HTTP_ERROR' }, lastAttempt: { httpStatus: 503 } });
    help.resetHelpCorpusCacheForTests();
    reponse = async () => { throw new TypeError('fetch failed'); };
    expect(await help.loadHelpCorpus()).toBeNull();
    expect(help.helpCorpusHealth().alert?.code).toBe('HELP_CORPUS_UNAVAILABLE');
  });

  it('HELP2-07 — corpus invalide : HELP_CORPUS_INVALID (page HTML servie à la place du JSON, schéma inattendu)', async () => {
    reponse = async () => new Response('<html>SPA</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    const r = await banc().ask('Comment ajouter un document ?');
    expect(r.cascade?.fallbackReason).toBe('HELP_CORPUS_INVALID');
    help.resetHelpCorpusCacheForTests();
    reponse = json({ schema: 'autre', articles: [] });
    await help.loadHelpCorpus();
    expect(help.helpCorpusHealth().alert?.code).toBe('HELP_CORPUS_INVALID');
  });

  it('HELP2-08 — mauvais environnement : la préproduction refuse le corpus de production (HELP_CORPUS_WRONG_ENVIRONMENT, environnements nommés)', async () => {
    reponse = json(publie('production'), 200, { 'x-verebona-environment': 'production' });
    const r = await banc().ask('Comment ajouter un document ?');
    expect(r.answer).toMatch(FALLBACK);
    expect(r.cascade?.fallbackReason).toBe('HELP_CORPUS_WRONG_ENVIRONMENT');
    expect(r.cascade!.help!.observability).toMatchObject({ applicationEnvironment: 'preprod', corpusAvailable: false });
    const h = help.helpCorpusHealth();
    expect(h.alert?.message).toMatch(/« production » refusé : application « preprod »/);
    expect(h.alert?.message).toMatch(/site déclaré « production »/);
  });

  it('HELP2-08b — préproduction mal configurée : jamais de lecture silencieuse du site de production (URL absente ou site de production), aucun appel réseau', async () => {
    delete process.env.NEXT_PUBLIC_PUBLIC_SITE_URL;
    expect(help.resolveHelpCorpusConfig()).toMatchObject({ urlSource: 'default_production', problem: { code: 'HELP_CORPUS_WRONG_ENVIRONMENT' } });
    expect(await help.loadHelpCorpus()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(help.helpCorpusHealth().alert?.code).toBe('HELP_CORPUS_WRONG_ENVIRONMENT');
    process.env.NEXT_PUBLIC_PUBLIC_SITE_URL = 'https://www.verebona.fr';
    expect(help.resolveHelpCorpusConfig().problem?.code).toBe('HELP_CORPUS_WRONG_ENVIRONMENT');
    // Environnement de l'application illisible (hors test) : aucun corpus n'est le sien.
    process.env.NEXT_PUBLIC_APP_ENV = 'inconnu';
    vi.stubEnv('NODE_ENV', 'production');
    expect(help.resolveHelpCorpusConfig().problem?.code).toBe('HELP_CORPUS_WRONG_ENVIRONMENT');
    vi.unstubAllEnvs();
    // Production : le site de production est le sien.
    process.env.NEXT_PUBLIC_APP_ENV = 'production';
    delete process.env.NEXT_PUBLIC_PUBLIC_SITE_URL;
    expect(help.resolveHelpCorpusConfig()).toMatchObject({ url: 'https://www.verebona.fr/aide/corpus-t2.json', problem: null });
  });

  it('HELP2-08c — variables lues À L’EXÉCUTION : HELP_CENTER_URL puis NEXT_PUBLIC_PUBLIC_SITE_URL, changement vu sans nouveau build', () => {
    expect(help.helpCorpusUrl()).toBe(`${SITE_PREPROD}/aide/corpus-t2.json`);
    process.env.HELP_CENTER_URL = 'https://aide-preprod.example.org/';
    expect(help.resolveHelpCorpusConfig()).toMatchObject({ url: 'https://aide-preprod.example.org/aide/corpus-t2.json', urlSource: 'HELP_CENTER_URL', problem: null });
    process.env.NEXT_PUBLIC_APP_ENV = 'production';
    expect(help.helpApplicationEnvironment()).toBe('production');
  });
});

// ════════════════════════════════════════════════════════════════════════
// Dernier corpus valide : live → mémoire → base, même environnement
// ════════════════════════════════════════════════════════════════════════
describe('HELP2 — dernier corpus valide, du même environnement seulement', () => {
  it('HELP2-09 — live puis HTTP KO : dernier corpus valide en mémoire servi, réponse trouvée, diagnostic tracé', async () => {
    await help.loadHelpCorpus();
    help.invalidateHelpCorpusCache();
    reponse = async () => new Response('KO', { status: 502 });
    // Relecture en échec : le dernier corpus valide reste servi.
    expect((await help.loadHelpCorpus())?.version).toBe('v-preprod-1');
    const r = await banc().ask('Comment ajouter un document ?');
    expect(articles(r)[0]).toBe('AID-DOC-001');
    expect(r.cascade?.fallbackReason ?? null).toBeNull();
    expect(r.cascade!.help!.observability).toMatchObject({
      corpusAvailable: true, corpusSource: 'last_valid_memory', corpusDiagnostic: 'HELP_CORPUS_HTTP_ERROR', corpusEnvironment: 'preprod',
    });
  });

  it('HELP2-09b — redémarrage : dernier corpus valide relu en base (même environnement) ; celui d’un autre environnement est ignoré', async () => {
    const stock = new Map<string, { corpus: unknown; at: string }>();
    const store: HelpCorpusStore = { read: async (env) => stock.get(env) ?? null, write: async () => {} };
    help.setHelpCorpusStoreForTests(store);
    reponse = async () => new Response('KO', { status: 503 });
    stock.set('preprod', { corpus: publie('production', 'v-prod'), at: '2026-10-01T00:00:00.000Z' });
    expect(await help.loadHelpCorpus()).toBeNull();
    help.resetHelpCorpusCacheForTests();
    stock.set('preprod', { corpus: publie('preprod', 'v-db'), at: '2026-10-01T00:00:00.000Z' });
    const c = await help.loadHelpCorpus();
    expect(c?.version).toBe('v-db');
    expect(help.helpCorpusHealth()).toMatchObject({ source: 'last_valid_db', alert: { code: 'HELP_CORPUS_HTTP_ERROR' } });
  });

  it('HELP2-10 — cache échu : la question n’attend pas le réseau (dernier corpus valide servi, relecture en arrière-plan, un seul téléchargement)', async () => {
    await help.loadHelpCorpus();
    help.invalidateHelpCorpusCache();
    let liberer!: (r: Response) => void;
    reponse = () => new Promise<Response>((res) => { liberer = res; });
    const [a, b2] = await Promise.all([
      help.loadHelpCorpusDetailed({ staleWhileRevalidate: true }),
      help.loadHelpCorpusDetailed({ staleWhileRevalidate: true }),
    ]);
    expect(a.corpus?.version).toBe('v-preprod-1');
    expect(b2.info).toMatchObject({ corpusAvailable: true, corpusSource: 'last_valid_memory' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    liberer(new Response(JSON.stringify(publie('preprod', 'v-preprod-2')), { status: 200 }));
    await vi.waitFor(async () => expect((await help.loadHelpCorpus())?.version).toBe('v-preprod-2'));
  });

  it('HELP2-11 — ouverture de la recherche d’aide hors délai : HELP_CORPUS_TIMEOUT tracé, jamais le repli muet « corpus disponible »', async () => {
    const lente = () => new Promise<never>(() => {});
    const b = banc({ openHelpSearch: lente as never });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const p = b.ask('Comment ajouter un document ?');
    await vi.advanceTimersByTimeAsync(help.HELP_CORPUS_OPEN_BUDGET_MS + 50);
    const r = await p;
    expect(b.retrieve).not.toHaveBeenCalled();
    expect(r.cascade?.fallbackReason).toBe('HELP_CORPUS_TIMEOUT');
    expect(r.cascade!.help!.corpus).toMatchObject({ available: false, diagnostic: 'HELP_CORPUS_TIMEOUT' });
  });
});

// ════════════════════════════════════════════════════════════════════════
// Motifs de repli de la recherche et contradiction
// ════════════════════════════════════════════════════════════════════════
describe('HELP2 — NO_RELEVANT_HELP_ARTICLE, HELP_SCORE_INSUFFICIENT, HELP_CONTRADICTION', () => {
  const vide = { corpusAvailable: true, corpusVersion: 'v', sources: [], candidateCount: 0, rejected: { lowCoverage: 0, contextExcluded: 0 } };
  it('HELP2-12 — aucun candidat → NO_RELEVANT_HELP_ARTICLE ; candidats sous le seuil (jamais abaissé) → HELP_SCORE_INSUFFICIENT', async () => {
    const u = { status: 'called' as const, intent: 'PRODUCT_HELP_HOW_TO', queries: ['tesla'] };
    const aucun = await runHelpCascade({ message: 'x y', threshold: 0.6, maxSources: 4, search: async () => vide, understand: async () => u });
    expect(aucun.trace.fallbackReason).toBe('NO_RELEVANT_HELP_ARTICLE');
    const faible = await runHelpCascade({
      message: 'x y', threshold: 0.6, maxSources: 4, understand: async () => u,
      search: async (q, stage) => ({ ...vide, candidateCount: 1, sources: [{ id: 'help_A__p', type: 'help_entry', title: 'A', content: 'a', relevanceScore: 0.3, meta: { articleId: 'A' }, stage, query: q[0], queryHits: 1 }] }),
    });
    expect(faible.trace.fallbackReason).toBe('HELP_SCORE_INSUFFICIENT');
    expect(faible.trace.observability).toMatchObject({ articleId: null, sourceCount: 0, fallbackReason: 'HELP_SCORE_INSUFFICIENT' });
  });

  it('HELP2-13 — deux articles également pertinents qui se contredisent : HELP_CONTRADICTION, support proposé', async () => {
    const contradictoire = (titre: string, id: string, limite: string) => ({
      id, title: titre, path: `/aide/${id.toLowerCase()}`, category: 'documents', categoryName: 'Documents', summary: 'Ajouter un document.',
      offers: ['standard', 'premium', 'premium_duo'], offersLabel: 'Toutes les offres', offersNote: null, synonyms: [],
      status: 'published', validatedAt: '2026-09-01',
      sections: [{ anchor: 'presentation', heading: 'Présentation', text: `Pour ajouter un document, le fichier ne doit pas dépasser ${limite} Mo.` }],
    });
    reponse = json({ ...publie('preprod'), articles: [contradictoire('Ajouter un document', 'AID-T-001', '25'), contradictoire('Ajouter un document', 'AID-T-002', '10')] });
    const r = await banc().ask('Comment ajouter un document ?');
    expect(r.cascade?.fallbackReason).toBe('HELP_CONTRADICTION');
    expect(r.cascade!.help!.observability).toMatchObject({ fallbackReason: 'HELP_CONTRADICTION', articleId: null });
    expect(types(r)).toContain('OPEN_CONTACT');
  });
});

// ════════════════════════════════════════════════════════════════════════
// §2 — réponses HOW_TO courtes, fondées sur l'article seul
// ════════════════════════════════════════════════════════════════════════
describe('HELP2 — réponse HOW_TO courte et déterministe', () => {
  const CORPUS = help.parseHelpCorpus(publie('preprod')) as HelpCorpus;
  const art = (id: string) => CORPUS.articles.find((a) => a.id === id)!;

  it('HELP2-14 — 1 à 2 phrases, uniquement des intitulés et précisions de l’article, jamais « D’après l’article… »', () => {
    for (const id of ['AID-DOC-001', 'AID-ASSET-001', 'AID-AGENDA-001', 'AID-DOC-002']) {
      const a = art(id);
      const r = help.shortHowToAnswer(a)!;
      expect(r, id).toBeTruthy();
      expect(phrases(r).length, id).toBeLessThanOrEqual(2);
      expect(r, id).not.toMatch(/D’après l’article/);
      // Chaque étape citée l'est avec les mots de l'article.
      const procedure = a.sections.find((s) => s.anchor === 'procedure')!.text.toLowerCase();
      for (const morceau of r.replace(/^Pour [^,]+, /, '').split(/,\s|\spuis\s|\.\s|\s:\s/).map((m) => m.replace(/\.$/, '').trim().toLowerCase()).filter(Boolean)) {
        expect(procedure, `${id} : « ${morceau} »`).toContain(morceau);
      }
    }
    expect(help.shortHowToAnswer(art('AID-DOC-001'))).toBe('Pour ajouter un document, sélectionnez le fichier, choisissez le bien si nécessaire puis lancez l’import. '
      + 'Laissez le traitement se poursuivre : lorsque l’analyse automatique est active, elle peut continuer en arrière-plan après l’envoi.');
    // Sans procédure : pas de synthèse inventée.
    expect(help.shortHowToAnswer({ title: 'X', sections: [{ anchor: 'presentation', text: 'Texte.' }] })).toBeNull();
  });

  it('HELP2-15 — aucun appel IA pour raccourcir : HOW_TO sous le seuil « exact » mais au-dessus du seuil de suffisance → synthèse déterministe, ANSWER jamais appelé', async () => {
    const b = banc({ generated: 'Rédaction du modèle.' });
    const r = await b.ask('Comment créer une échéance ?');
    expect(r.cascade?.strategy).toMatch(/^help\.(exact_article|short_synthesis)$/);
    expect(b.generate).not.toHaveBeenCalled();
    expect(r.answer).not.toBe('Rédaction du modèle.');
  });

  it('HELP2-16 — offre : une condition indispensable est conservée (fonction non incluse)', () => {
    const src = help.toHelpSources(help.searchHelpCorpus(CORPUS, 'synchroniser agenda personnel'), 'STANDARD');
    const r = help.helpAnswerFromSources(src, 'PRODUCT_HELP_HOW_TO', art(String(src[0].meta!.articleId)));
    expect(r).toMatch(/n’est pas incluse dans votre offre actuelle/);
  });
});

// ════════════════════════════════════════════════════════════════════════
// §3 à §6 — actions : création directe, article précis, support, droits
// ════════════════════════════════════════════════════════════════════════
describe('HELP2 — actions de la réponse', () => {
  it('HELP2-17 — [Ajouter un document] [Lire l’article] : action métier AVANT l’aide, article PRÉCIS, pas de support', async () => {
    const r = await banc().ask('Comment ajouter un document ?');
    expect(r.actions[0]).toMatchObject({ type: 'START_ADD_DOCUMENT', label: 'Ajouter un document', href: null, command: { kind: 'CREATE', flow: 'document', assetId: null } });
    expect(r.actions[1]).toMatchObject({ type: 'OPEN_HELP', label: 'Lire l’article', href: '/aide?page=%2Faide%2Fajouter-un-document' });
    expect(types(r)).not.toContain('OPEN_CONTACT');
  });

  it('HELP2-18 — START_ADD_* ≠ navigation : aucune action de création n’a de href (/documents, /assets, /agenda)', async () => {
    for (const q of ['Comment ajouter un document ?', 'Comment ajouter un bien ?', 'Comment créer une échéance ?']) {
      const r = await banc().ask(q);
      const creations = r.actions.filter((a) => a.type.startsWith('START_ADD_'));
      expect(creations.length, q).toBe(1);
      for (const a of creations) {
        expect(a.href, q).toBeNull();
        expect(a.command?.kind, q).toBe('CREATE');
      }
    }
  });

  it('HELP2-19 — contexte déjà résolu présélectionné : bien de la page ou référence du fil (document, échéance) ; jamais pour un bien', async () => {
    const page = await banc().ask('Comment ajouter un document ?', { pageContext: { route: '/assets/42', assetId: '42', platform: 'web' } });
    expect(page.actions.filter((a) => a.type === 'START_ADD_DOCUMENT')).toEqual([expect.objectContaining({ command: { kind: 'CREATE', flow: 'document', assetId: 42 } })]);
    const fil = await banc().ask('Comment créer une échéance ?', { reference: { type: 'asset', id: 42, method: 'thread' } });
    expect(fil.actions.find((a) => a.type === 'START_ADD_AGENDA_ITEM')?.command).toEqual({ kind: 'CREATE', flow: 'agenda_item', assetId: 42 });
    const bien = await banc().ask('Comment ajouter un bien ?', { pageContext: { route: '/assets/42', assetId: '42' } });
    expect(bien.actions.find((a) => a.type === 'START_ADD_ASSET')?.command).toEqual({ kind: 'CREATE', flow: 'asset', assetId: null });
  });

  it('HELP2-20 — droits et quotas inchangés côté serveur : lecture seule → aucune création ; bien d’un autre compte → jamais présélectionné', async () => {
    const lecture = await banc().ask('Comment ajouter un document ?', { planLimit: 'TRIAL_EXPIRED' });
    expect(types(lecture).filter((t) => t.startsWith('START_ADD_'))).toEqual([]);
    const etranger = await banc().ask('Comment ajouter un document ?', { pageContext: { route: '/assets/999', assetId: '999' } });
    expect(etranger.actions.filter((a) => a.type === 'START_ADD_DOCUMENT').every((a) => a.command?.assetId !== 999)).toBe(true);
  });

  it('HELP2-21 — API : la commande est exposée, la cible interne non ; une ancienne action enregistrée avec href est rejouée en commande', async () => {
    const r = await banc().ask('Comment ajouter un document ?', { pageContext: { route: '/assets/42', assetId: '42' } });
    const api = toApiPayload(r);
    const ajout = api.actions.find((a) => a.type === 'START_ADD_DOCUMENT')!;
    expect(ajout).toMatchObject({ href: null, command: { kind: 'CREATE', flow: 'document', assetId: 42 } });
    expect(ajout).not.toHaveProperty('targetRef');
    const ancien = toApiPayload({ ...r, actions: [{ ...ajout, href: '/assets/42?tab=documents', command: undefined, targetRef: 'asset:42' }] });
    expect(ancien.actions[0]).toMatchObject({ href: null, command: { kind: 'CREATE', flow: 'document', assetId: 42 } });
  });
});
