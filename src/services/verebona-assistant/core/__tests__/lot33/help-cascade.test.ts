/**
 * Lot 33 (33A) — T2 PRODUCT_HELP_HOW_TO : cascade du Centre d'aide.
 *
 * Ticket « corriger la cascade Centre d'aide et empêcher le fallback
 * immédiat après échec full-text ». Tests 1 à 8 du ticket (HELP-T1 … T8),
 * critères d'acceptation (HELP-ACxx) et non-régression « comment ajouter un
 * document ».
 *
 * Orchestrateur RÉEL (`runAssistant`), corpus RÉEL du Centre d'aide
 * (instantané publié, `test/e2e/fixtures/help-corpus-t2.snapshot.json`),
 * recherche RÉELLE (`searchHelpQueries`), actions RÉELLES
 * (`construireActionIntents` + `resolveActions`). Le modèle est simulé, et
 * COMPTÉ : `classify` (UNDERSTAND) et `generate` (ANSWER) — `llm()` vérifie
 * le compteur du client simulé ET `cascade.aiCalls`.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@/db', () => ({
  pgClient: { unsafe: vi.fn(async () => []) },
  db: {}, ensureMigrations: vi.fn(async () => {}), ensureUnaccent: vi.fn(async () => {}),
}));

const help = await import('../../help-corpus.service');
const { runAssistant } = await import('../../assistant-orchestrator.service');
const { construireActionIntents } = await import('../../ports');
const { resolveActions } = await import('../../action-resolver.service');
const { toIntentRoute } = await import('../../classification.adapter');
const { routeDeterministic } = await import('../../intent-router.service');
const { createAiCallBudget } = await import('../../ai-call-budget');
const { DEFAULT_THRESHOLDS } = await import('../../sufficiency');
const { detectHelpConcept, expandHelpQueries, canonicalizeHelpQuery, HELP_CONCEPTS } = await import('@/lib/help-center/concepts');
const { runHelpCascade, queriesFromUnderstanding, mergeHelpSources } = await import('../../help-cascade');
const { buildT2ObservabilityTrace } = await import('@/services/ai/telemetry/t2-observability');
import type { HelpCorpus, HelpCorpusArticle } from '../../help-corpus.service';
import type { OrchestratorPorts } from '../../assistant-orchestrator.service';
import type { AssistantRequestInput, AssistantRunResult, IntentRoute } from '../../../types/contracts';
import type { ResolvedSource, RetrievedSource } from '../../../types/sources';

const SNAPSHOT = join(__dirname, '../../../../../test/e2e/fixtures/help-corpus-t2.snapshot.json');
const CORPUS = help.parseHelpCorpus(JSON.parse(readFileSync(SNAPSHOT, 'utf8')))!;

/** Les neuf formulations du §3.1 du ticket. */
const FORMULATIONS_DEPOT = [
  'comment ajouter un document',
  'comment importer un document',
  'comment déposer un document',
  'comment mettre un document',
  'comment ajouter une facture',
  'où ajouter un document',
  'je veux ajouter un fichier',
  'comment joindre un fichier',
  'où déposer ma facture',
];

const ACCESS = {
  assetInAccount: async () => true, documentInAccount: async () => true, agendaItemInAccount: async () => true,
  helpEntryPublished: async (id: string) => id.startsWith('AID-'),
};

/** Compréhension UNDERSTAND simulée (sortie structurée, jamais une réponse). */
const compris = (intent: string, topics: string[], reason = 'test'): IntentRoute => ({
  ...toIntentRoute({ intent, confidence: 'exact', entityHints: [], reason }, 'PREMIUM'),
  understanding: { requestedFacts: [], requestedTopics: topics, filters: {} },
});

interface Banc {
  classify: ReturnType<typeof vi.fn>;
  generate: ReturnType<typeof vi.fn>;
  retrieve: ReturnType<typeof vi.fn>;
  ports: OrchestratorPorts;
  ask(message: string, extra?: Partial<AssistantRequestInput>): Promise<AssistantRunResult>;
  llmCalls(): number;
}

function banc(o: {
  corpus?: HelpCorpus | null;
  understand?: IntentRoute | null | (() => Promise<IntentRoute | null>);
  generated?: string;
  aiUnavailable?: boolean;
  /** Sans port dédié : la cascade passe par `retrieve` (contrat historique). */
  sansPortAide?: boolean;
  retrieved?: RetrievedSource[];
} = {}): Banc {
  const corpus = o.corpus === undefined ? CORPUS : o.corpus;
  const classify = vi.fn(async () => (typeof o.understand === 'function' ? o.understand() : o.understand ?? null));
  const generate = vi.fn(async (_r: IntentRoute, sources: RetrievedSource[]) => (o.generated
    ? { answer: o.generated, claims: [{ text: o.generated, sourceIds: [sources[0]?.id].filter(Boolean) as string[] }], actions: [], supportLevel: 'supported' as const }
    : null));
  const retrieve = vi.fn(async () => o.retrieved ?? []);
  const ports: OrchestratorPorts = {
    retrieve,
    ...(o.sansPortAide ? {} : {
      openHelpSearch: async (input: AssistantRequestInput) => ({
        search: async (queries: string[], stage: 'fulltext' | 'expanded' | 'reformulated') => (corpus
          ? help.searchHelpQueries(corpus, queries, stage, { limit: 8, ctx: help.helpContextFromPage(input.pageContext, ['owner']), planType: input.planType })
          : help.HELP_CORPUS_UNAVAILABLE_RESULT),
        article: (id: string) => corpus?.articles.find((a) => a.id === id) ?? null,
      }),
    }),
    resolveSources: async (sources): Promise<ResolvedSource[]> => sources.map((s) => ({
      id: s.id, type: s.type, typeLabel: s.type, title: s.title, excerpt: s.content.slice(0, 240), isAvailable: true,
    })),
    classifyWithAI: classify,
    generateWithAI: generate as never,
    resolveActions: (route, input, s) => resolveActions({ accountId: 1, intent: route.intent, actionIntents: construireActionIntents(route, input, s), access: ACCESS }),
    persist: async () => null,
    hasPendingClarification: async () => false,
    isAiUnavailable: async () => o.aiUnavailable ?? false,
  };
  return {
    classify, generate, retrieve, ports,
    ask: (message, extra = {}) => runAssistant({
      accountId: 1, userId: 7, planType: 'PREMIUM', message, clientRequestId: `t-${Math.random()}`, locale: 'fr-FR', ...extra,
    } as AssistantRequestInput, ports),
    llmCalls: () => classify.mock.calls.length + generate.mock.calls.length,
  };
}

/** Appels LLM : compteur du client simulé ET trace de l'orchestrateur. */
const llm = (b: Banc, r: AssistantRunResult, n: number) => {
  expect(b.llmCalls()).toBe(n);
  expect(r.cascade?.aiCalls).toBe(n);
};
const verite = (r: AssistantRunResult) => buildT2ObservabilityTrace({ strategy: r.cascade?.strategy, sources: r.sources }).truthSource;
const articles = (r: AssistantRunResult) => [...new Set(r.sources.map((s) => s.id.replace(/^help_/, '').split('__')[0]))];
const FALLBACK = /pas trouvé dans le Centre d’aide d’information suffisamment fiable/;

/**
 * Cohérence de trace (§14 du ticket) : jamais « SYNTHESIS_REQUIRED + 0 appel
 * + repli » ; toute absence d'escalade est motivée ; repli = aucune source.
 */
function traceCoherente(r: AssistantRunResult): void {
  const c = r.cascade!;
  expect(c.escalationReasons).not.toContain('N2:SYNTHESIS_REQUIRED');
  if (c.answeredBy === 'fallback') {
    expect(r.sources).toEqual([]);
    expect(c.fallbackReason).toBeTruthy();
    if (c.aiCalls === 0) expect(c.fallbackReason).not.toBe('NO_RELIABLE_SOURCE');
  } else {
    expect(c.fallbackReason ?? null).toBeNull();
  }
  for (const a of c.attempts) expect(typeof a.threshold).toBe('number');
}

// ════════════════════════════════════════════════════════════════════════
// Référentiel unique des synonymes et concepts (§6 du ticket)
// ════════════════════════════════════════════════════════════════════════
describe('Lot 33 — référentiel des concepts du Centre d’aide (pur)', () => {
  it('HELP-AC01 — ajouter / importer / déposer / joindre / téléverser → DOCUMENT_UPLOAD (verbe ET objet)', () => {
    for (const q of [...FORMULATIONS_DEPOT, 'comment téléverser un justificatif', 'Je veux mettre une facture dans Verebona', 'Ajouter un fichier']) {
      expect(detectHelpConcept(q)?.concept.id, q).toBe('DOCUMENT_UPLOAD');
      expect(detectHelpConcept(q)?.certain, q).toBe(true);
    }
    // Un verbe seul, un objet seul ou « mettre à jour » ne sont pas un dépôt.
    expect(detectHelpConcept('comment mettre à jour un document')).toBeNull();
    expect(detectHelpConcept('comment ajouter')).toBeNull();
    expect(detectHelpConcept('mes factures')).toBeNull();
    // Objet le plus proche du verbe : « ajouter un document à ma voiture » reste un dépôt.
    expect(detectHelpConcept('comment ajouter un document à ma voiture')?.concept.id).toBe('DOCUMENT_UPLOAD');
    expect(detectHelpConcept('comment créer une échéance')?.concept.id).toBe('AGENDA_ITEM_CREATE');
    expect(detectHelpConcept('comment ajouter ma voiture')?.concept.id).toBe('ASSET_CREATE');
  });

  it('HELP-AC02 — recherche élargie : question réécrite dans le vocabulaire des articles + requêtes canoniques du concept', () => {
    expect(canonicalizeHelpQuery('Comment déposer un fichier ?')).toBe('comment ajouter un document');
    expect(canonicalizeHelpQuery('comment joindre une pièce jointe')).toBe('comment ajouter une document');
    const { queries, concept } = expandHelpQueries('où déposer ma facture');
    expect(concept?.concept.id).toBe('DOCUMENT_UPLOAD');
    expect(queries).toEqual(expect.arrayContaining(['ajouter un document', 'importer un document']));
    // Jamais la question d'origine (déjà cherchée au plein texte).
    expect(expandHelpQueries('ajouter un document').queries.map((q) => q.toLowerCase())).not.toContain('ajouter un document');
    // Le référentiel est la seule source : chaque concept a ses requêtes et son action.
    for (const c of HELP_CONCEPTS) {
      expect(c.queries.length).toBeGreaterThan(0);
      expect(c.action).toMatch(/^START_ADD_/);
    }
  });

  it('HELP-AC03 — l’article d’ajout de document EXISTE dans le vrai corpus et l’index couvre titre, mots-clés, catégorie, libellés d’écran', () => {
    const a = CORPUS.articles.find((x) => x.id === 'AID-DOC-001') as HelpCorpusArticle;
    expect(a).toBeTruthy();
    expect(a.title).toBe('Ajouter un document');
    expect(a.sections.map((s) => s.anchor)).toContain('procedure');
    // « Ajout rapide » n'est qu'un libellé d'écran (`screens`) : il est indexé.
    const [hit] = help.searchHelpCorpus(CORPUS, 'ajout rapide', 1);
    expect(hit?.article.screens).toContain('Ajout rapide');
  });

  it('HELP-AC04 — les neuf formulations du §3.1 convergent vers AID-DOC-001, SANS IA, sans abaisser le seuil 0,6', async () => {
    expect(DEFAULT_THRESHOLDS.text).toBe(0.6);
    for (const q of FORMULATIONS_DEPOT) {
      const understand = vi.fn(async () => ({ status: 'blocked' as const, reason: 'AI_NOT_ALLOWED' as const }));
      const r = await runHelpCascade({
        message: q, threshold: 0.6, maxSources: 8, understand,
        search: async (queries, stage) => help.searchHelpQueries(CORPUS, queries, stage),
      });
      expect(r.sufficient, q).toBe(true);
      expect(r.sources[0].meta?.articleId, q).toBe('AID-DOC-001');
      expect(r.bestScore, q).toBeGreaterThanOrEqual(0.6);
      expect(understand, q).not.toHaveBeenCalled();
      expect(r.trace.levels.every((l) => l.threshold === 0.6), q).toBe(true);
    }
  });

  it('HELP-AC05 — fusion des étapes : meilleur score par section, consensus des requêtes, étape tracée', () => {
    const s = (id: string, score: number, stage: 'fulltext' | 'expanded'): never => ({ id, type: 'help_entry', title: id, content: '', relevanceScore: score, stage, query: 'q', queryHits: 1 }) as never;
    const m = mergeHelpSources([s('a', 0.4, 'fulltext'), s('b', 0.9, 'fulltext')], [s('a', 0.9, 'expanded')]);
    expect(m.map((x) => [x.id, x.relevanceScore, x.stage, x.queryHits])).toEqual([['a', 0.9, 'expanded', 2], ['b', 0.9, 'fulltext', 1]]);
  });

  it('HELP-AC06 — requêtes tirées d’UNDERSTAND : sujets, indices d’aide, justification — jamais la question d’origine', () => {
    const q = queriesFromUnderstanding({
      requestedTopics: ['importer un document'], entityHints: [{ type: 'document', value: 'PDF' }, { type: 'asset', value: 'Polo' }],
      reason: 'classification modèle — l’utilisateur veut ajouter un document',
    }, 'comment je fais pour mon pdf');
    expect(q).toEqual(expect.arrayContaining(['importer un document', 'PDF', 'l’utilisateur veut ajouter un document']));
    expect(q).not.toContain('Polo');
    expect(q.length).toBeLessThanOrEqual(8);
  });

  it('HELP-AC07 — routage : besoin d’usage reconnu par le référentiel (verbe ET objet) → PRODUCT_HELP_HOW_TO', () => {
    for (const q of [...FORMULATIONS_DEPOT, 'Je veux mettre une facture dans Verebona', 'Ajouter un fichier', 'Comment ajouter un document ?']) {
      const o = routeDeterministic({ message: q, planType: 'premium', hasPendingClarification: false });
      expect(o.kind === 'route' ? o.route.intent : 'UNKNOWN', q).toBe('PRODUCT_HELP_HOW_TO');
    }
    // Les recherches dans le compte restent des recherches.
    for (const q of ['Retrouve mes factures', 'Où est la facture de mon vélo ?', 'comment mettre à jour un document']) {
      const o = routeDeterministic({ message: q, planType: 'premium', hasPendingClarification: false });
      expect(o.kind === 'route' ? o.route.intent : 'UNKNOWN', q).not.toBe('PRODUCT_HELP_HOW_TO');
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// Tests 1 à 8 du ticket (§15), orchestrateur réel
// ════════════════════════════════════════════════════════════════════════
describe('Lot 33 — tests 1 à 8 du ticket (orchestrateur réel, corpus réel, compteur LLM)', () => {
  it('HELP-T1 — « Comment ajouter un document ? » : Centre d’aide, sourceCount ≥ 1, pas de repli, procédure de l’article (non-régression)', async () => {
    const b = banc({ understand: compris('PRODUCT_HELP_HOW_TO', ['importer un document']), generated: 'ne doit pas servir' });
    const r = await b.ask('Comment ajouter un document ?');
    expect(r.route.intent).toBe('PRODUCT_HELP_HOW_TO');
    expect(r.cascade?.sourceCount).toBeGreaterThanOrEqual(1);
    expect(articles(r)[0]).toBe('AID-DOC-001');
    expect(verite(r)).toBe('centre_aide');
    expect(r.cascade?.answeredBy).not.toBe('fallback');
    expect(r.cascade?.notices ?? []).not.toContain('NO_RELEVANT_SOURCE');
    expect(r.answer).not.toMatch(FALLBACK);
    // Réponse directement utile : les étapes RÉELLES de l'article.
    expect(r.answer).toContain('D’après l’article « Ajouter un document » du Centre d’aide');
    expect(r.answer).toContain('1. Ouvrez l’ajout de document — Utilisez « Ajouter un document » depuis la page ou le raccourci d’ajout.');
    expect(r.answer).toContain('4. Lancez l’import');
    expect(r.answer).not.toMatch(/Consultez le Centre d’aide\.?$/);
    // Action comprise avec certitude : « Ajouter un document » et l'article.
    expect(r.actions.map((a) => a.type)).toEqual(expect.arrayContaining(['START_ADD_DOCUMENT', 'OPEN_HELP']));
    llm(b, r, 0);
    traceCoherente(r);
  });

  it('HELP-T2 — « Comment importer un document ? » : même article', async () => {
    const b = banc();
    const r = await b.ask('Comment importer un document ?');
    expect(r.route.intent).toBe('PRODUCT_HELP_HOW_TO');
    expect(articles(r)[0]).toBe('AID-DOC-001');
    expect(r.answer).toContain('Ajouter un document');
    llm(b, r, 0);
    traceCoherente(r);
  });

  it('HELP-T3 — « Je veux mettre une facture dans Verebona » : besoin compris, contenu correspondant retrouvé', async () => {
    const b = banc();
    const r = await b.ask('Je veux mettre une facture dans Verebona');
    expect(r.route.intent).toBe('PRODUCT_HELP_HOW_TO');
    expect(articles(r)[0]).toBe('AID-DOC-001');
    expect(r.answer).toContain('1. Ouvrez l’ajout de document');
    // Le plein texte seul retient « facture » (article de facturation) ; le
    // concept DOCUMENT_UPLOAD (verbe ET objet) mène la recherche élargie, qui
    // corrige le classement.
    const niveaux = r.cascade!.help!.levels;
    expect(niveaux[0]).toMatchObject({ level: 2, stage: 'fulltext' });
    expect(niveaux[1]).toMatchObject({ level: 3, stage: 'expanded', status: 'SUFFICIENT' });
    expect(articles(r)).not.toContain('AID-BILL-007');
    expect(r.cascade!.help!.concept).toEqual({ id: 'DOCUMENT_UPLOAD', certain: true });
    expect(r.cascade!.help!.sources[0]).toMatchObject({ stage: 'expanded', type: 'help_entry' });
    llm(b, r, 0);
    traceCoherente(r);
  });

  it('HELP-T4 — l’article dit « Importer un document », l’utilisateur demande « Ajouter un fichier » : retrouvé', async () => {
    const importer: HelpCorpus = {
      ...CORPUS,
      articles: [{
        ...CORPUS.articles.find((a) => a.id === 'AID-DOC-001')!,
        id: 'AID-IMP-001', title: 'Importer un document', path: '/aide/importer-un-document', summary: 'Téléverser un justificatif.',
        synonyms: ['import'], screens: [], categoryName: 'Divers',
        sections: [
          { anchor: 'presentation', heading: 'Présentation', text: 'Vous pouvez importer un document depuis la page des documents.' },
          { anchor: 'procedure', heading: 'Procédure', text: '1. Ouvrez la page — Choisissez « Importer ».\n2. Choisissez le document — Sélectionnez-le puis validez.' },
        ],
      // Autres articles : facturation et agenda (aucun ne traite du dépôt).
      }, ...CORPUS.articles.filter((a) => a.category === 'abonnement-facturation-parrainage' || a.category === 'agenda-echeances')],
    };
    const b = banc({ corpus: importer });
    const r = await b.ask('Ajouter un fichier');
    expect(r.route.intent).toBe('PRODUCT_HELP_HOW_TO');
    expect(articles(r)[0]).toBe('AID-IMP-001');
    expect(r.answer).toContain('1. Ouvrez la page — Choisissez « Importer ».');
    expect(r.cascade!.help!.levels.find((l) => l.status === 'SUFFICIENT')?.stage).toBe('expanded');
    llm(b, r, 0);
    traceCoherente(r);
  });

  it('HELP-T5 — déterminisme suffisant : aiCalls = 0 alors que l’IA est permise (UNDERSTAND et ANSWER branchés)', async () => {
    const b = banc({ understand: compris('PRODUCT_HELP_HOW_TO', ['x']), generated: 'rédaction inutile' });
    const r = await b.ask('comment ajouter un document');
    expect(r.cascade?.sourceCount).toBeGreaterThanOrEqual(1);
    expect(r.cascade?.answeredBy).toBe('retrieval');
    expect(r.cascade?.strategy).toBe('help.exact_article');
    // Niveaux déterministes seulement (plein texte, recherche élargie).
    expect(r.cascade!.help!.levels.every((l) => l.level <= 3)).toBe(true);
    expect(r.cascade!.help!.levels[0]).toMatchObject({ level: 2, status: 'SUFFICIENT' });
    expect(r.cascade!.help!.understanding).toBeNull();
    expect(b.classify).not.toHaveBeenCalled();
    expect(b.generate).not.toHaveBeenCalled();
    llm(b, r, 0);
    traceCoherente(r);
  });

  it('HELP-T6 — plein texte insuffisant, reformulation par UNDERSTAND : escalade EXÉCUTÉE, source retrouvée, réponse', async () => {
    const b = banc({ understand: compris('PRODUCT_HELP_HOW_TO', ['importer un document'], 'l’utilisateur veut ajouter un document') });
    const r = await b.ask('Comment je fais pour que mon PDF apparaisse dans l’appli ?');
    expect(r.route.intent).toBe('PRODUCT_HELP_HOW_TO');
    const h = r.cascade!.help!;
    expect(h.levels.map((l) => [l.level, l.status])).toEqual([[2, 'INSUFFICIENT'], [3, 'SKIPPED'], [4, 'EXECUTED'], [5, 'SUFFICIENT']]);
    expect(h.understanding).toMatchObject({ task: 'UNDERSTAND', operation: 't2_understand', status: 'called' });
    expect(h.retrievalQueriesExpanded).toContain('importer un document');
    expect(h.sources[0]).toMatchObject({ stage: 'reformulated' });
    expect(r.cascade?.sourceCount).toBeGreaterThanOrEqual(1);
    expect(articles(r)).toContain('AID-DOC-001');
    expect(r.answer).not.toMatch(FALLBACK);
    expect(r.cascade?.answeredBy).not.toBe('fallback');
    expect(r.cascade?.escalationReasons).toEqual(expect.arrayContaining(['HELP:N2:LOW_RELEVANCE', 'HELP:N4:UNDERSTAND_CALLED']));
    // UNDERSTAND seul (l'article répond nettement : pas de rédaction).
    expect(b.classify).toHaveBeenCalledTimes(1);
    llm(b, r, 1);
    traceCoherente(r);
  });

  it('HELP-T7 — fonctionnalité non documentée : plein texte → élargie → UNDERSTAND → rien de fiable → repli légitime', async () => {
    const b = banc({ understand: compris('PRODUCT_HELP_HOW_TO', ['connecter une Tesla', 'synchronisation véhicule connecté']) });
    const r = await b.ask('Comment connecter Verebona à ma Tesla ?');
    expect(r.route.intent).toBe('PRODUCT_HELP_HOW_TO');
    const h = r.cascade!.help!;
    expect(h.levels.map((l) => l.level)).toEqual([2, 3, 4, 5]);
    expect(h.fallbackReason).toBe('NO_RELIABLE_SOURCE');
    expect(r.cascade?.fallbackReason).toBe('NO_RELIABLE_SOURCE');
    expect(r.cascade?.strategy).toBe('fallback.help');
    expect(r.answer).toMatch(FALLBACK);
    expect(r.sources).toEqual([]);
    expect(verite(r)).toBe('aucune');
    // Demande non comprise avec certitude : aucune action métier précise.
    expect(r.actions.map((a) => a.type).filter((t) => t.startsWith('START_'))).toEqual([]);
    expect(r.actions.map((a) => a.type)).toEqual(expect.arrayContaining(['OPEN_HELP', 'OPEN_CONTACT']));
    llm(b, r, 1);
    traceCoherente(r);
  });

  it('HELP-T8 — interdiction d’hallucination : sans source, ANSWER n’est jamais appelé, aucune procédure inventée', async () => {
    const b = banc({
      understand: compris('PRODUCT_HELP_HOW_TO', ['connexion Tesla']),
      generated: 'Allez dans Réglages > Véhicules connectés > Tesla puis validez.',
    });
    const r = await b.ask('Comment connecter Verebona à ma Tesla ?');
    expect(b.generate).not.toHaveBeenCalled();
    expect(r.answer).not.toContain('Réglages');
    expect(r.answer).toMatch(FALLBACK);
    expect(verite(r)).toBe('aucune');
    expect(r.claims).toEqual([]);
    llm(b, r, 1);
    traceCoherente(r);
  });
});

// ════════════════════════════════════════════════════════════════════════
// SYNTHESIS_REQUIRED : escalade réelle, ou motif explicite (§8, §14)
// ════════════════════════════════════════════════════════════════════════
describe('Lot 33 — escalade réelle ou motif explicite (jamais de repli silencieux)', () => {
  const NON_DOC = 'Comment connecter Verebona à ma Tesla ?';

  it('HELP-AC08 — reproduction de la trace du 07/10 (recherche vide) : plus de « N2:SYNTHESIS_REQUIRED + 0 appel », UNDERSTAND exécuté', async () => {
    // Port historique (`retrieve`) qui ne trouve RIEN, comme en préproduction.
    const b = banc({ sansPortAide: true, retrieved: [], understand: compris('PRODUCT_HELP_HOW_TO', ['ajouter un document']) });
    const r = await b.ask('comment ajouter un document');
    expect(r.cascade?.escalationReasons).not.toContain('N2:SYNTHESIS_REQUIRED');
    expect(r.cascade!.help!.levels.map((l) => l.strategy)).toEqual(['help.fulltext', 'help.expanded', 'help.understand', 'help.reformulated']);
    // Chaque requête est passée au port : initiale, élargies, reformulées.
    const messages = b.retrieve.mock.calls.map((c) => (c[1] as AssistantRequestInput).message);
    expect(messages[0]).toBe('comment ajouter un document');
    expect(messages).toEqual(expect.arrayContaining(['ajouter un document', 'importer un document']));
    expect(r.cascade?.fallbackReason).toBe('NO_RELIABLE_SOURCE');
    expect(r.cascade!.help!.failureKind).toBe('NO_CANDIDATE');
    llm(b, r, 1);
    traceCoherente(r);
  });

  it('HELP-AC09 — IA non permise (Standard) : motif AI_NOT_ALLOWED, 0 appel', async () => {
    const b = banc({ understand: compris('PRODUCT_HELP_HOW_TO', ['x']) });
    const r = await b.ask(NON_DOC, { planType: 'STANDARD' });
    expect(r.cascade?.fallbackReason).toBe('AI_NOT_ALLOWED');
    expect(r.cascade?.escalationReasons).toContain('HELP:N4:AI_NOT_ALLOWED');
    expect(r.cascade!.help!.levels.at(-1)).toMatchObject({ level: 4, status: 'SKIPPED', reason: 'AI_NOT_ALLOWED' });
    llm(b, r, 0);
    traceCoherente(r);
  });

  it('HELP-AC10 — T2 arrêté (EStop, traitement suspendu) : AI_UNAVAILABLE, 0 appel', async () => {
    const b = banc({ understand: compris('PRODUCT_HELP_HOW_TO', ['x']), aiUnavailable: true });
    const r = await b.ask(NON_DOC);
    expect(r.cascade?.fallbackReason).toBe('AI_UNAVAILABLE');
    llm(b, r, 0);
    traceCoherente(r);
  });

  it('HELP-AC11 — budget d’appels épuisé : AI_BUDGET_BLOCKED, 0 appel', async () => {
    const b = banc({ understand: compris('PRODUCT_HELP_HOW_TO', ['x']) });
    const budget = createAiCallBudget(2);
    budget.consume(2);
    const r = await b.ask(NON_DOC, { aiBudget: budget });
    expect(r.cascade?.fallbackReason).toBe('AI_BUDGET_BLOCKED');
    expect(b.llmCalls()).toBe(0);
    traceCoherente(r);
  });

  it('HELP-AC12 — UNDERSTAND hors délai : AI_TIMEOUT ; en échec : AI_UNAVAILABLE (appel compté)', async () => {
    let b = banc({ understand: () => Promise.reject(new Error('REQUEST_TIMEOUT')) });
    let r = await b.ask(NON_DOC);
    expect(r.cascade?.fallbackReason).toBe('AI_TIMEOUT');
    expect(r.cascade!.help!.levels.at(-1)).toMatchObject({ level: 4, status: 'FAILED', reason: 'AI_TIMEOUT' });
    llm(b, r, 1);
    b = banc({ understand: null });
    r = await b.ask(NON_DOC);
    expect(r.cascade?.fallbackReason).toBe('AI_UNAVAILABLE');
    llm(b, r, 1);
    traceCoherente(r);
  });

  it('HELP-AC13 — corpus indisponible : 0 résultat TECHNIQUE (distinct), aucune IA ; action certaine conservée, incertaine retirée', async () => {
    let b = banc({ corpus: null, understand: compris('PRODUCT_HELP_HOW_TO', ['x']) });
    let r = await b.ask('Comment ajouter un document ?');
    expect(r.cascade?.fallbackReason).toBe('HELP_CORPUS_UNAVAILABLE');
    expect(r.cascade!.help!.failureKind).toBe('TECHNICAL_NO_CORPUS');
    expect(r.cascade!.help!.corpus.available).toBe(false);
    expect(r.answer).toMatch(FALLBACK);
    // « Ajouter un document » : verbe ET objet reconnus → action certaine.
    expect(r.actions.map((a) => a.type)).toContain('START_ADD_DOCUMENT');
    llm(b, r, 0);
    traceCoherente(r);
    // « télécharger » : `helpPrimaryAction` proposerait « Ajouter un document »,
    // mais rien n'est compris avec certitude → aucune action métier.
    b = banc({ corpus: null });
    r = await b.ask('Comment télécharger un document ?');
    expect(r.answer).toMatch(FALLBACK);
    expect(r.actions.map((a) => a.type).filter((t) => t.startsWith('START_'))).toEqual([]);
    traceCoherente(r);
  });

  it('HELP-AC14 — candidats sous le seuil (LOW_SCORE) distincts de « aucun candidat » ; scores et seuils tracés', async () => {
    const b = banc({ understand: compris('PRODUCT_HELP_HOW_TO', ['véhicule connecté']) });
    const r = await b.ask(NON_DOC);
    const h = r.cascade!.help!;
    expect(h.levels[0].candidateCount).toBeGreaterThan(0);
    expect(h.levels[0].bestScore).toBeGreaterThan(0);
    expect(h.levels[0].bestScore).toBeLessThan(0.6);
    expect(h.levels[0].threshold).toBe(0.6);
    expect(h.failureKind).toBe('LOW_SCORE');
    expect(h.retrievalQueryInitial).toBe(NON_DOC);
    expect(r.cascade?.retrievalQueryInitial).toBe(NON_DOC);
    expect(r.cascade?.attempts.map((a) => a.strategy)).toEqual(['help.fulltext', 'help.expanded', 'help.understand', 'help.reformulated']);
  });

  it('HELP-AC15 — compris au routage par UNDERSTAND : réutilisé (aucun second appel)', async () => {
    const b = banc({ understand: compris('PRODUCT_HELP_HOW_TO', ['importer un document']) });
    // Aucune règle ne tranche : UNDERSTAND classe la question (1 appel)…
    const r = await b.ask('Bidule machin truc ?');
    expect(r.route.intent).toBe('PRODUCT_HELP_HOW_TO');
    // …puis la cascade réutilise sa compréhension.
    expect(r.cascade!.help!.understanding?.status).toBe('reused');
    expect(articles(r)).toContain('AID-DOC-001');
    llm(b, r, 1);
    traceCoherente(r);
  });

  it('HELP-AC16 — source fiable mais non nette (0,6 ≤ score < 0,75) : ANSWER rédige À PARTIR de l’article (Centre d’aide = vérité)', async () => {
    const corpus: HelpCorpus = {
      ...CORPUS,
      articles: [{
        ...CORPUS.articles[0], id: 'AID-EXP-001', title: 'Exporter ses données', path: '/aide/exporter', summary: '', synonyms: [], screens: [], categoryName: 'Divers',
        sections: [{ anchor: 'presentation', heading: 'Présentation', text: 'Exportez vos données : une archive ZIP est générée.' }],
      }],
    };
    const b = banc({ corpus, generated: 'D’après le Centre d’aide, une archive ZIP est générée.' });
    const r = await b.ask('Comment exporter une archive ?', { pageContext: { route: '/inconnue' } });
    const h = r.cascade!.help!;
    expect(h.sufficiency).toBe('SUFFICIENT');
    expect(h.sources[0].score).toBeGreaterThanOrEqual(0.6);
    expect(h.sources[0].score).toBeLessThan(0.75);
    expect(b.generate).toHaveBeenCalledTimes(1);
    const [, envoyees] = b.generate.mock.calls[0] as [IntentRoute, RetrievedSource[]];
    expect(envoyees.every((s) => s.type === 'help_entry')).toBe(true);
    expect(r.cascade?.answeredBy).toBe('llm');
    expect(verite(r)).toBe('centre_aide');
    llm(b, r, 1);
  });
});

describe('Lot 33 — cohérence des traces hors Centre d’aide (§14)', () => {
  it('HELP-AC17 — N2 « SYNTHESIS_REQUIRED » sans appel : le motif de non-escalade est TOUJOURS explicite', async () => {
    for (const [plan, motif] of [['STANDARD', 'AI_NOT_ALLOWED'], ['PREMIUM', 'NO_SOURCE_FOR_SYNTHESIS']] as const) {
      const b = banc({ sansPortAide: true, retrieved: [] });
      const r = await b.ask('Explique-moi l’évolution de mes dépenses', { planType: plan });
      expect(r.route.intent.startsWith('ACCOUNT_'), r.route.intent).toBe(true);
      expect(r.cascade?.escalationReasons).toContain('N2:SYNTHESIS_REQUIRED');
      expect(r.cascade?.escalationReasons).toContain(`N3:NOT_EXECUTED:${motif}`);
      expect(r.cascade?.fallbackReason).toBe(motif);
      llm(b, r, 0);
    }
  });
});
