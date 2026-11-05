/**
 * Lot 110E — T2 : réponses issues des Ressources, couverture effective des
 * suggestions, journal BO « Questions sans réponse ».
 *
 *   U01  cause racine reproduite sur le corpus réel (instantané = `pub108p`) ;
 *   U02  E03 traite la périodicité : preuve VERIFIED, réponse structurée ;
 *   U03  catalogue : chaque question Ressources du stock a une preuve vérifiée ;
 *   U04  invalidation : retrait, révision, texte modifié, section disparue ;
 *   U05  routage des questions libres par intention (Ressources / compte / aide) ;
 *   U06  homonymie et sujets voisins ; score élevé mais hors sujet ;
 *   U07  décision après la cascade : preuve, focalisation, replis motivés ;
 *   U08  journal : motifs distincts, regroupement, statuts, filtres, expurgation ;
 *   U09  BO : accès administrateur, charte, pas de journal concurrent ;
 *   U10  accueil : aucune IA, nombre et présentation inchangés (CA11).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseHelpCorpus, searchHelpQueries, helpAnswerFromSources, type HelpCorpus } from '../help-corpus.service';
import {
  asHelpSearchCorpus, parseResourcesCorpus, resetResourcesCorpusForTests, setResourcesCorpusForTests, type ResourcesCorpus,
} from '../resources-corpus.service';
import { mergeHelpAndResources } from '../help-search.port';
import { runHelpCascade, type HelpCascadeResult } from '../help-cascade';
import {
  applyResourceAnswering, guardResourceSources, isDocumentaryQuestion, questionKind, resourceAnswerFromSources,
  RESOURCES_NO_ANSWER_MESSAGE, RESOURCES_UNAVAILABLE_MESSAGE, type ResourceGuardDecision,
} from '../resources-answer';
import { routeResourceTopic } from '../resources-routing';
import { aggregateJournal, classifyJournalRow, groupKeyOf, type JournalRow } from '../unanswered-journal';
import { GUIDE_STOCK } from '@/services/suggestions/shared/stock';
import {
  RESOURCE_QUESTION_CATALOG, resetResourceEvidenceMemo, verifyResourceEvidence,
} from '@/services/suggestions/shared/resource-questions';
import { guideAnswerability, resetAnswerabilityMemo } from '@/services/suggestions/shared/answerability';
import type { SuggestionEvidence } from '../../types/contracts';

const ROOT = process.cwd();
const FIX = join(ROOT, 'src/test/e2e/fixtures');
const help = parseHelpCorpus(JSON.parse(readFileSync(join(FIX, 'help-corpus-t2.snapshot.json'), 'utf8')))!;
const resRaw = parseResourcesCorpus(JSON.parse(readFileSync(join(FIX, 'ressources-corpus-t2.snapshot.json'), 'utf8')))!;
const res = asHelpSearchCorpus(resRaw);
const QUESTION = 'Quand faire la révision d’une voiture ?';
const SEUIL = 0.6;

/** Recherche « comme T2 » (Centre d'aide + Ressources), avec ou sans la garde du lot 110E. */
const chercheur = (prefer: 'HELP' | 'RESOURCES', message: string, garde: boolean, resources: HelpCorpus | null = res, examined?: ResourceGuardDecision[]) =>
  async (queries: string[], stage: 'fulltext' | 'expanded' | 'reformulated') => {
    const aide = searchHelpQueries(help, queries, stage, { limit: 6 });
    let ress = resources ? searchHelpQueries(resources, queries, stage, { limit: 6 }) : null;
    if (ress && garde) {
      const g = guardResourceSources(message, ress.sources);
      examined?.push(...g.decisions);
      ress = { ...ress, sources: g.kept };
    }
    return mergeHelpAndResources(aide, ress, prefer, 6);
  };
const cascade = (message: string, prefer: 'HELP' | 'RESOURCES', garde = true, resources: HelpCorpus | null = res, examined?: ResourceGuardDecision[]) =>
  runHelpCascade({ message, threshold: SEUIL, search: chercheur(prefer, message, garde, resources, examined), understand: async () => ({ status: 'blocked', reason: 'AI_NOT_ALLOWED' }), maxSources: 6 });
const articleDe = (s: { id: string }) => s.id.replace(/^help_/, '').split('__')[0];
const evidenceOf = (id: string, corpus: Parameters<typeof verifyResourceEvidence>[1] = resRaw): SuggestionEvidence => {
  const c = verifyResourceEvidence(id, corpus);
  return { questionId: id, status: c.status, articleId: c.articleId, revision: c.revision, revisionChanged: c.revisionChanged, corpusVersion: c.corpusVersion,
    environment: c.environment, answerSections: c.answerSections, reserveSections: c.reserveSections, missingSubjects: c.missingSubjects, answerSentences: c.answerSentences };
};
const articleOf = (c: HelpCorpus) => (id: string) => c.articles.find((a) => a.id === id) ?? null;
const CORPUS_OK = { available: true, version: resRaw.version, environment: resRaw.environment };
const avecArticle = (id: string, f: (a: ResourcesCorpus['articles'][number]) => ResourcesCorpus['articles'][number] | null, version = 'v-modif'): ResourcesCorpus => ({
  ...resRaw, version, articles: resRaw.articles.map((a) => (a.id === id ? f(a) : a)).filter((a): a is ResourcesCorpus['articles'][number] => a != null),
});

beforeEach(() => { resetResourceEvidenceMemo(); resetAnswerabilityMemo(); });
afterEach(() => resetResourcesCorpusForTests());

describe('L110E-U01 — cause racine démontrée sur le corpus réel', () => {
  it('l’instantané de l’application est le corpus du tag pub108p (31 articles, même version)', () => {
    expect(resRaw.version).toBe('contenu-5d45dee305e31e56');
    expect(resRaw.articles).toHaveLength(31);
  });

  it('AVANT : C01 (coût annuel) et E03 (révision) à égalité 1,000 ; l’ordre du corpus met C01 en tête', async () => {
    const r = await cascade(QUESTION, 'RESOURCES', false);
    expect(r.sufficient).toBe(true);
    expect(r.sources[0].id).toBe('help_RES-C01__presentation');
    expect(r.sources[0].relevanceScore).toBe(1);
    expect(r.sources.find((s) => s.id === 'help_RES-E03__presentation')?.relevanceScore).toBe(1);
    // … et la réponse sans modèle (score ≥ 0,75) était l'extrait de C01, avec renvois (ancien
    // rédacteur générique, simulé en masquant le préfixe Ressources des sources).
    const anciennes = r.sources.map(({ stage: _s, query: _q, queryHits: _h, ...x }) => ({ ...x, meta: { ...x.meta, articleId: String(x.meta?.articleId).replace('RES-', 'ANCIEN-') } }));
    const texte = helpAnswerFromSources(anciennes, 'PRODUCT_HELP_EXPLAIN');
    expect(texte).toMatch(/Combien coûte l’entretien d’une voiture/);
    expect(texte).toMatch(/La procédure complète est dans l’article/);
  });

  it('APRÈS : la garde de nature écarte C01 (« combien coûte » ≠ « quand ») et E03 passe en tête', async () => {
    const examined: ResourceGuardDecision[] = [];
    const r = await cascade(QUESTION, 'RESOURCES', true, res, examined);
    expect(articleDe(r.sources[0])).toBe('RES-E03');
    expect(r.sources.some((s) => articleDe(s) === 'RES-C01')).toBe(false);
    expect(examined.find((d) => d.id === 'help_RES-C01__presentation')).toMatchObject({ kept: false, reason: 'KIND_MISMATCH', score: 1 });
  });
});

describe('L110E-U02 — E03 traite réellement la périodicité : réponse directe, prouvée, structurée', () => {
  it('preuve VERIFIED : programme du constructeur ET premier seuil atteint (kilométrage ou temps)', () => {
    const c = verifyResourceEvidence('res_car_service', resRaw);
    expect(c.status).toBe('VERIFIED');
    expect(c.articleId).toBe('RES-E03');
    expect(c.answerSections).toEqual(['presentation', 'rechercher-le-bon-programme-constructeur']);
    expect(c.answerSentences.join(' ')).toMatch(/programme du constructeur/);
    expect(c.answerSentences.join(' ')).toMatch(/premier seuil atteint/);
  });

  it('réponse : d’abord la réponse (phrases publiées), puis « À noter », jamais « la procédure est dans l’article » ni C01', () => {
    const src = applyResourceAnswering({
      message: QUESTION, input: { suggestion: { id: 'res_car_service', version: null, objective: 'GUIDE', canonicalIntent: 'PRODUCT_HELP_EXPLAIN', corpus: 'RESOURCES', forceIntent: true, evidence: evidenceOf('res_car_service') } },
      aide: { sufficient: false, sources: [], bestScore: 0, concept: null, understandCalled: false, trace: { fallbackReason: null } } as unknown as HelpCascadeResult,
      article: articleOf(res), examined: [], corpus: CORPUS_OK,
    });
    expect(src.kind).toBe('sources');
    if (src.kind !== 'sources') return;
    expect(src.sources.every((s) => articleDe(s) === 'RES-E03')).toBe(true);
    expect(src.sources[0].meta?.path).toBe('/ressources/quand-faire-revision-voiture');
    expect(src.sources[1].meta?.path).toBe('/ressources/quand-faire-revision-voiture#rechercher-le-bon-programme-constructeur');
    const texte = helpAnswerFromSources(src.sources, 'PRODUCT_HELP_EXPLAIN')!;
    const [reponse, reserves] = texte.split('\n\n');
    expect(reponse).toMatch(/^La prochaine révision de votre voiture ne se déduit pas d’une règle unique/);
    expect(reponse).toMatch(/premier seuil atteint/);
    expect(reserves).toMatch(/^À noter : /);
    expect(texte).not.toMatch(/procédure complète|Voir aussi|Combien coûte|additionnez/i);
    // Aucun chiffre qui ne figure pas mot pour mot dans l'article.
    const e03 = JSON.stringify(resRaw.articles.find((a) => a.id === 'E03'));
    for (const n of texte.match(/\d[\d\s]*\d|\d/g) ?? []) expect(e03).toContain(n.trim());
  });
});

describe('L110E-U03 — catalogue des questions Ressources : ID stable, article, sections, version, couverture', () => {
  const ressources = GUIDE_STOCK.filter((e) => e.corpus === 'RESOURCES');
  it('chaque question Ressources du stock a UNE preuve, au même article', () => {
    expect(new Set(RESOURCE_QUESTION_CATALOG.map((e) => e.questionId)).size).toBe(RESOURCE_QUESTION_CATALOG.length);
    for (const e of ressources) expect(RESOURCE_QUESTION_CATALOG.find((x) => x.questionId === e.id)?.articleId, e.id).toBe(e.articleId);
  });
  it.each(ressources.map((e) => [e.id]))('%s : preuve VERIFIED sur le corpus publié, et donc proposable', (id) => {
    const c = verifyResourceEvidence(id, resRaw);
    expect(c.status, `${id} manque : ${c.missingSubjects.join(', ')} ${c.missingSections.join(', ')}`).toBe('VERIFIED');
    expect(c.revisionChanged).toBe(false);
    expect(guideAnswerability(ressources.find((e) => e.id === id)!, { help, resources: res })).toBe('VERIFIED');
  });
  it('une question sans preuve déclarée n’est jamais proposée', () => {
    const e = { ...ressources[0], id: 'res_sans_preuve' };
    expect(guideAnswerability(e, { help, resources: res })).toBe('NOT_ANSWERABLE');
  });
});

describe('L110E-U04 — invalidation : retrait, mise à jour, section disparue', () => {
  const e = GUIDE_STOCK.find((x) => x.id === 'res_car_service')!;
  it('article retiré : ARTICLE_MISSING, question non proposée', () => {
    const c = avecArticle('E03', () => null);
    expect(verifyResourceEvidence('res_car_service', c).status).toBe('ARTICLE_MISSING');
    expect(guideAnswerability(e, { help, resources: asHelpSearchCorpus(c) })).toBe('NOT_ANSWERABLE');
  });
  it('nouvelle révision au même contenu : revérifiée, toujours couverte, signalée « révision modifiée »', () => {
    const c = avecArticle('E03', (a) => ({ ...a, revision: 3 }));
    expect(verifyResourceEvidence('res_car_service', c)).toMatchObject({ status: 'VERIFIED', revision: 3, revisionChanged: true });
  });
  it('révision qui retire le passage sur le seuil : PARTIAL → retirée des suggestions, et la réponse dit le manque', () => {
    const c = avecArticle('E03', (a) => ({ ...a, revision: 3, sections: a.sections.map((s) => (s.anchor === 'rechercher-le-bon-programme-constructeur' ? { ...s, text: 'Relevez le modèle précis.' } : s)) }));
    const v = verifyResourceEvidence('res_car_service', c);
    expect(v.status).toBe('PARTIAL');
    expect(v.missingSubjects).toEqual(['le seuil qui déclenche la révision (kilométrage ou temps)']);
    expect(guideAnswerability(e, { help, resources: asHelpSearchCorpus(c) })).toBe('NOT_ANSWERABLE');
    const r = applyResourceAnswering({
      message: QUESTION, input: { suggestion: { id: e.id, version: null, objective: 'GUIDE', canonicalIntent: 'PRODUCT_HELP_EXPLAIN', corpus: 'RESOURCES', forceIntent: true, evidence: evidenceOf(e.id, c) } },
      aide: { sufficient: false, sources: [], trace: { fallbackReason: null } } as unknown as HelpCascadeResult,
      article: articleOf(asHelpSearchCorpus(c)), examined: [], corpus: { ...CORPUS_OK, version: 'v-modif' },
    });
    expect(r.kind === 'sources' && r.trace.outcome).toBe('PARTIAL');
    expect(r.kind === 'sources' && r.trace.motive).toBe('PARTIAL_COVERAGE');
    if (r.kind === 'sources') expect(resourceAnswerFromSources(r.sources)).toMatch(/Les Ressources publiées ne précisent pas le seuil qui déclenche la révision/);
  });
  it('section renommée : la preuve ne s’appuie que sur les sections présentes', () => {
    const c = avecArticle('E03', (a) => ({ ...a, sections: a.sections.filter((s) => s.anchor !== 'presentation' && s.anchor !== 'rechercher-le-bon-programme-constructeur') }));
    expect(verifyResourceEvidence('res_car_service', c).status).toBe('SECTION_MISSING');
  });
  it('corpus indisponible : CORPUS_UNAVAILABLE, rien n’est proposé ni imposé', () => {
    expect(verifyResourceEvidence('res_car_service', null).status).toBe('CORPUS_UNAVAILABLE');
    expect(guideAnswerability(e, { help, resources: null })).toBe('NOT_ANSWERABLE');
  });
});

describe('L110E-U05 — questions libres : routage par intention', () => {
  it('question générale documentaire / question personnelle / question d’usage de Verebona', () => {
    expect(isDocumentaryQuestion(QUESTION)).toBe(true);
    expect(isDocumentaryQuestion('Combien de temps garder une facture d’achat ?')).toBe(true);
    expect(isDocumentaryQuestion('Quand faire la révision de ma voiture ?')).toBe(false);
    expect(isDocumentaryQuestion('Quand faire la révision de la Polo ?')).toBe(false);
    expect(isDocumentaryQuestion('Comment ajouter un document dans Verebona ?')).toBe(false);
    expect(isDocumentaryQuestion('Quand faire la révision d’une voiture achetée en 2019 ?')).toBe(false);
    expect(isDocumentaryQuestion(QUESTION, { assetId: '12' } as never)).toBe(false);
    // Recherche dans le compte, même sans possessif : jamais détournée.
    expect(isDocumentaryQuestion('Trouve une facture de garage')).toBe(false);
    expect(isDocumentaryQuestion('Montre une facture d’entretien de la voiture')).toBe(false);
    expect(isDocumentaryQuestion('Facture d’une voiture')).toBe(false);
    expect(isDocumentaryQuestion('Comment vérifier si un appareil est encore sous garantie ?')).toBe(true);
  });

  it('recherche d’agenda FAIBLE sur une question documentaire → Ressources (E03)', async () => {
    setResourcesCorpusForTests(resRaw);
    const d = await routeResourceTopic({ message: QUESTION, planType: 'PREMIUM' }, { kind: 'route', route: { intent: 'ACCOUNT_SEARCH_AGENDA', deterministicConfidence: 'WEAK' } });
    expect(d).toMatchObject({ route: true, trace: { decision: 'RESOURCES', previousIntent: 'ACCOUNT_SEARCH_AGENDA', bestArticle: 'RES-E03' } });
  });

  it('recherche de documents STRONG mais formulée de façon générale → Ressources (A03)', async () => {
    setResourcesCorpusForTests(resRaw);
    const d = await routeResourceTopic({ message: 'Combien de temps garder une facture d’achat ?', planType: 'PREMIUM' }, { kind: 'route', route: { intent: 'ACCOUNT_SEARCH_DOCUMENT', deterministicConfidence: 'STRONG' } });
    expect(d?.route).toBe(true);
    expect(d?.trace.bestArticle).toBe('RES-A03');
  });

  it('faits du compte et aide produit : jamais détournés', async () => {
    setResourcesCorpusForTests(resRaw);
    expect(await routeResourceTopic({ message: 'Quand faire la révision de ma voiture ?', planType: 'PREMIUM' }, { kind: 'route', route: { intent: 'ACCOUNT_SEARCH_AGENDA', deterministicConfidence: 'WEAK' } })).toBeNull();
    expect(await routeResourceTopic({ message: 'Comment ajouter un document ?', planType: 'PREMIUM' }, { kind: 'route', route: { intent: 'PRODUCT_HELP_HOW_TO', deterministicConfidence: 'STRONG' } })).toBeNull();
    expect(await routeResourceTopic({ message: 'Quelle est la date du contrôle technique d’une voiture ?', planType: 'PREMIUM' }, { kind: 'route', route: { intent: 'ACCOUNT_FACT_ASSET', deterministicConfidence: 'STRONG' } })).toBeNull();
  });

  it('corpus Ressources indisponible : routage inchangé (motif tracé)', async () => {
    setResourcesCorpusForTests(null);
    const d = await routeResourceTopic({ message: QUESTION, planType: 'PREMIUM' }, { kind: 'route', route: { intent: 'ACCOUNT_SEARCH_AGENDA', deterministicConfidence: 'WEAK' } });
    expect(d).toMatchObject({ route: false, trace: { reason: 'RESOURCES_CORPUS_UNAVAILABLE' } });
  });

  it('question sans Ressource de même nature : routage inchangé', async () => {
    setResourcesCorpusForTests(resRaw);
    const d = await routeResourceTopic({ message: 'Quand repeindre une clôture en bois ?', planType: 'PREMIUM' }, { kind: 'needs_classification' });
    expect(d?.route ?? false).toBe(false);
  });
});

describe('L110E-U06 — homonymie, sujets voisins, score élevé mais hors sujet', () => {
  it('nature des questions et des titres', () => {
    expect(questionKind(QUESTION)).toBe('WHEN');
    expect(questionKind('À quelle fréquence entretenir une chaudière ?')).toBe('WHEN');
    expect(questionKind('Combien de temps garder une facture d’achat ?')).toBe('DURATION');
    expect(questionKind('Combien coûte l’entretien d’une voiture sur un an ?')).toBe('COST');
    expect(questionKind('Quels documents conserver après des travaux dans un logement ?')).toBe('DOCUMENTS');
    expect(questionKind('Comment vérifier si un appareil est encore sous garantie ?')).toBeNull();
  });
  it.each([
    ['Quand passer le contrôle technique d’une voiture ?', 'RES-E01'],
    [QUESTION, 'RES-E03'],
    ['Combien coûte l’entretien d’une voiture sur un an ?', 'RES-C01'],
    ['Combien de temps garder une facture d’achat ?', 'RES-A03'],
  ])('« %s » → %s en tête (sujets voisins non confondus)', async (q, attendu) => {
    const r = await cascade(q, 'RESOURCES');
    expect(r.sufficient).toBe(true);
    expect(articleDe(r.sources[0])).toBe(attendu);
  });
  it('libellé peu « lexical » (« entretenir » ≠ « entretien ») : la recherche seule ne suffit pas, la preuve du catalogue répond (E05)', async () => {
    const q = 'À quelle fréquence entretenir une chaudière ?';
    const aide = await cascade(q, 'RESOURCES');
    expect(aide.sufficient && articleDe(aide.sources[0]) === 'RES-E05').toBe(false);
    const r = applyResourceAnswering({ message: q, input: { corpusPreference: 'RESOURCES' }, aide, article: articleOf(res), examined: [], corpus: CORPUS_OK });
    expect(r.kind).toBe('sources');
    expect(r.trace).toMatchObject({ selection: 'EVIDENCE', catalogQuestionId: 'res_boiler_service', selected: { articleId: 'RES-E05' } });
    if (r.kind === 'sources') expect(resourceAnswerFromSources(r.sources)).toMatch(/entretien annuel est obligatoire/);
  });
  it('score lexical maximal mais hors sujet : écarté, et signalé en alerte qualité si une autre source répond', async () => {
    const examined: ResourceGuardDecision[] = [];
    const aide = await cascade(QUESTION, 'RESOURCES', true, res, examined);
    const r = applyResourceAnswering({ message: QUESTION, input: { corpusPreference: 'RESOURCES' }, aide, article: articleOf(res), examined, corpus: CORPUS_OK });
    // Question libre au libellé du catalogue : la preuve E03 sert ; le hors-sujet le mieux noté (C01) est tracé.
    expect(r.kind).toBe('sources');
    expect(r.trace?.qualityAlerts).toContain('HIGH_SCORE_OFF_TOPIC');
    expect(r.trace?.selection).toBe('EVIDENCE');
  });
});

describe('L110E-U07 — après la cascade : preuve, focalisation, replis honnêtes', () => {
  const sugg = (evidence: SuggestionEvidence | null) => ({ id: 'res_car_service', version: null, objective: 'GUIDE' as const, canonicalIntent: 'PRODUCT_HELP_EXPLAIN' as const, corpus: 'RESOURCES' as const, forceIntent: true, evidence });
  it('recherche divergente (C01 en tête sans la garde) : la preuve E03 prime, motif « recherche ayant raté une source »', async () => {
    const aide = await cascade(QUESTION, 'RESOURCES', false);
    const r = applyResourceAnswering({ message: QUESTION, input: { suggestion: sugg(evidenceOf('res_car_service')) }, aide, article: articleOf(res), examined: [], corpus: CORPUS_OK });
    expect(r.kind).toBe('sources');
    expect(r.trace).toMatchObject({ selection: 'EVIDENCE', motive: 'RETRIEVAL_MISSED', outcome: 'ANSWERED', origin: 'SUGGESTION', suggestionId: 'res_car_service' });
    expect(r.trace?.qualityAlerts).toContain('RETRIEVAL_DIVERGED_FROM_EVIDENCE');
  });
  it('article dépublié : aucune réponse forcée — autre Ressource compatible, sinon repli honnête', async () => {
    const sans = asHelpSearchCorpus(avecArticle('E03', () => null));
    const aide = await cascade(QUESTION, 'RESOURCES', true, sans);
    const r = applyResourceAnswering({ message: QUESTION, input: { suggestion: sugg(evidenceOf('res_car_service', avecArticle('E03', () => null))) }, aide, article: articleOf(sans), examined: [], corpus: CORPUS_OK });
    if (r.kind === 'sources') {
      expect(r.trace.selection).toBe('RETRIEVAL');
      expect(r.sources.every((s) => articleDe(s) !== 'RES-C01' && articleDe(s) !== 'RES-E03')).toBe(true);
    } else {
      expect(r.kind).toBe('fallback');
      if (r.kind === 'fallback') expect(r.text).toBe(RESOURCES_NO_ANSWER_MESSAGE);
    }
  });
  it('corpus Ressources indisponible : repli explicite, jamais une source du Centre d’aide à la place', async () => {
    const aide = await cascade(QUESTION, 'RESOURCES', true, null);
    const r = applyResourceAnswering({ message: QUESTION, input: { suggestion: sugg(evidenceOf('res_car_service', null)) }, aide, article: articleOf(res), examined: [], corpus: { available: false, version: null, environment: null } });
    expect(r.kind).toBe('fallback');
    if (r.kind === 'fallback') {
      expect(r.text).toBe(RESOURCES_UNAVAILABLE_MESSAGE);
      expect(r.trace.motive).toBe('CORPUS_UNAVAILABLE');
    }
  });
  it('aucun passage autorisé : repli honnête, motif « couverture absente », sans chiffre', async () => {
    const q = 'Quand repeindre une clôture en bois ?';
    const aide = await cascade(q, 'RESOURCES');
    const r = applyResourceAnswering({ message: q, input: { corpusPreference: 'RESOURCES' }, aide, article: articleOf(res), examined: [], corpus: CORPUS_OK });
    expect(r.kind).toBe('fallback');
    if (r.kind === 'fallback') {
      expect(r.trace.motive).toBe('COVERAGE_ABSENT');
      expect(r.text).not.toMatch(/\d/);
    }
  });
  it('question d’aide (Centre d’aide) : décision inchangée, aucune trace Ressources', async () => {
    const aide = await cascade('Comment ajouter un document ?', 'HELP');
    const r = applyResourceAnswering({ message: 'Comment ajouter un document ?', input: {}, aide, article: articleOf(res), examined: [], corpus: CORPUS_OK });
    expect(r).toEqual({ kind: 'unchanged', trace: null });
  });
});

describe('L110E-U08 — journal « Questions sans réponse » : motifs, regroupement, statuts, expurgation', () => {
  const ligne = (o: Partial<JournalRow>): JournalRow => ({
    request_id: `r${Math.random()}`, created_at: '2026-11-04T10:00:00Z', intent: 'PRODUCT_HELP_EXPLAIN', status: 'ok', error_code: null, state: 'COMPLETED',
    strategy: null, source_count: 1, ref_outcome: null, fallback_reason: null, help_fallback_reason: null, help_article: null, help_corpus_version: null,
    resources: null, content: null, ...o,
  });
  const res110 = (motive: string | null, extra: object = {}) => ({ origin: 'FREE', suggestionId: null, examined: [], selection: 'NONE', selected: null, outcome: 'FALLBACK', motive, qualityAlerts: [], appEnvironment: 'preproduction', appRevision: 'abc', corpus: { available: true, version: 'v1', environment: 'preproduction' }, ...extra }) as never;
  it('motifs distincts : corpus indisponible ≠ couverture absente ≠ données du compte ≠ contradiction ≠ alerte qualité', () => {
    expect(classifyJournalRow(ligne({ resources: res110('CORPUS_UNAVAILABLE') }))?.motive).toBe('CORPUS_UNAVAILABLE');
    expect(classifyJournalRow(ligne({ resources: res110('COVERAGE_ABSENT') }))?.motive).toBe('COVERAGE_ABSENT');
    expect(classifyJournalRow(ligne({ resources: res110(null, { outcome: 'ANSWERED', qualityAlerts: ['HIGH_SCORE_OFF_TOPIC'] }) }))?.motive).toBe('QUALITY_ALERT');
    expect(classifyJournalRow(ligne({ resources: res110(null, { outcome: 'ANSWERED' }) }))).toBeNull();
    expect(classifyJournalRow(ligne({ intent: 'PRODUCT_HELP_HOW_TO', source_count: 0, help_fallback_reason: 'HELP_CORPUS_TIMEOUT' }))?.motive).toBe('CORPUS_UNAVAILABLE');
    expect(classifyJournalRow(ligne({ intent: 'PRODUCT_HELP_HOW_TO', source_count: 0, help_fallback_reason: 'NO_RELEVANT_HELP_ARTICLE' }))?.motive).toBe('COVERAGE_ABSENT');
    expect(classifyJournalRow(ligne({ intent: 'PRODUCT_HELP_HOW_TO', source_count: 1, help_fallback_reason: 'HELP_CONTRADICTION' }))?.motive).toBe('CONTRADICTION_AMBIGUITY');
    expect(classifyJournalRow(ligne({ intent: 'ACCOUNT_FACT_ASSET', source_count: 0, error_code: 'NO_RELEVANT_SOURCE' }))?.motive).toBe('ACCOUNT_DATA_INSUFFICIENT');
    expect(classifyJournalRow(ligne({ intent: 'ACCOUNT_FACT_ASSET', source_count: 2 }))).toBeNull();
  });
  it('regroupement des formulations proches, compteur, filtre, statut et réapparition après « Résolu »', () => {
    const k = groupKeyOf('Quand faire la révision d’une voiture ?', 'x');
    expect(groupKeyOf('quand faire la revision d une voiture', 'x')).toBe(k);
    expect(groupKeyOf('Quand faire la révision d’une voiture ?', 'x')).not.toBe(groupKeyOf('Combien coûte l’entretien d’une voiture ?', 'x'));
    const rows = [
      ligne({ content: 'Quand faire la révision d’une voiture ?', resources: res110('COVERAGE_ABSENT'), created_at: '2026-11-04T10:00:00Z' }),
      ligne({ content: 'quand faire la revision d une voiture', resources: res110('COVERAGE_ABSENT'), created_at: '2026-11-04T12:00:00Z' }),
      ligne({ content: 'Mes factures de mars', intent: 'ACCOUNT_SEARCH_DOCUMENT', source_count: 0, error_code: 'NO_RELEVANT_SOURCE' }),
    ];
    const reviews = new Map([[k, { status: 'RESOLVED' as const, note: null, updated_at: '2026-11-04T11:00:00Z' }]]);
    const j = aggregateJournal(rows, reviews);
    const g = j.groups.find((x) => x.groupKey === k)!;
    expect(g.count).toBe(2);
    expect(g).toMatchObject({ status: 'RESOLVED', statusLabel: 'Résolu', reopened: true, corpora: ['RESOURCES'] });
    expect(j.totals.find((t) => t.motive === 'ACCOUNT_DATA_INSUFFICIENT')?.count).toBe(1);
    expect(aggregateJournal(rows, reviews, { corpus: 'ACCOUNT' }).groups).toHaveLength(1);
    expect(aggregateJournal(rows, reviews, { status: 'TO_ANALYZE' }).groups.every((x) => x.status === 'TO_ANALYZE')).toBe(true);
    expect(aggregateJournal(rows, reviews, { motive: 'CORPUS_UNAVAILABLE' }).groups).toHaveLength(0);
  });
  it('expurgation : ni e-mail, ni téléphone, ni immatriculation dans le journal ; aucun texte d’article', () => {
    const j = aggregateJournal([ligne({ content: 'Quand faire la révision de AB-123-CD ? Écrivez à jean.dupont@example.com ou 0612345678', resources: res110('COVERAGE_ABSENT') })], new Map());
    const s = JSON.stringify(j);
    expect(s).not.toMatch(/jean\.dupont|0612345678|AB-123-CD/);
    expect(s).not.toMatch(/La prochaine révision de votre voiture/);
  });
});

describe('L110E-U09 — BO : accès contrôlé, charte, aucun journal concurrent', () => {
  const route = readFileSync(join(ROOT, 'src/app/api/admin/ai/t2-unanswered/journal/route.ts'), 'utf8');
  const ui = readFileSync(join(ROOT, 'src/app/admin/ai-executions/_components/T2UnansweredJournal.tsx'), 'utf8');
  const journal = readFileSync(join(ROOT, 'src/services/verebona-assistant/core/unanswered-journal.ts'), 'utf8');
  it('GET et PATCH gardés par requireAdminContext', () => {
    expect(route.match(/requireAdminContext\(req\)/g)).toHaveLength(2);
  });
  it('occurrences lues dans verebona_request_runs (aucune table d’occurrences) ; seule la décision de revue est écrite', () => {
    expect(journal).toMatch(/FROM verebona_request_runs r/);
    expect(journal).not.toMatch(/INSERT INTO verebona_request_runs|INSERT INTO t2_unanswered_occurrences/);
    expect(journal).toMatch(/INSERT INTO t2_unanswered_reviews/);
  });
  it('charte Sérénité : aucune couleur brute', () => {
    expect(ui).not.toMatch(/#[0-9a-f]{3,6}\b|rgba?\(|\b(?:bg|text|border)-(?:red|green|blue|gray|slate|amber|white|black)\b/i);
    expect(ui).not.toMatch(/Opération/);
  });
});

describe('L110E-U10 — accueil : aucune IA, présentation et quota inchangés (CA11, coordination 110C)', () => {
  it('la vérification de couverture est déterministe (aucun appel au fournisseur IA)', () => {
    for (const f of ['src/services/suggestions/shared/resource-questions.ts', 'src/services/suggestions/shared/answerability.ts', 'src/services/verebona-assistant/core/resources-answer.ts', 'src/services/verebona-assistant/core/resources-routing.ts']) {
      expect(readFileSync(join(ROOT, f), 'utf8'), f).not.toMatch(/ai\/gateway|generateWithAI|classifyWithAI|callModel/);
    }
  });
});
