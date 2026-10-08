/**
 * Cascade du Centre d'aide — lot 33 (ticket « T2 PRODUCT_HELP_HOW_TO :
 * corriger la cascade Centre d'aide et empêcher le fallback immédiat après
 * échec full-text »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT
 *
 * « Comment ajouter un document ? » était classée PRODUCT_HELP_HOW_TO, puis :
 * plein texte → aucune source → `SYNTHESIS_REQUIRED` → AUCUN appel IA →
 * repli. Le motif annonçait une étape que rien n'exécutait, et le moindre
 * écart de vocabulaire (« déposer », « joindre un fichier ») finissait en
 * « je n'ai pas trouvé ».
 *
 * LA CASCADE (niveaux tracés, chacun avec ses requêtes, candidats, scores
 * et seuil) :
 *
 *   N2 help.fulltext      plein texte du Centre d'aide sur la question ;
 *        ↓ insuffisant
 *   N3 help.expanded      recherche ÉLARGIE, déterministe : synonymes métier
 *                         et concepts du référentiel unique
 *                         (`lib/help-center/concepts`) ; menée AUSSI quand
 *                         un concept est certain (verbe ET objet), pour
 *                         confirmer ou corriger le classement du plein texte ;
 *        ↓ insuffisant
 *   N4 help.understand    UNDERSTAND (IA) : COMPRENDRE la demande et en
 *                         tirer des requêtes de recherche — jamais une
 *                         réponse. Déjà appelé pour cette demande : réutilisé
 *                         (aucun second appel). Impossible : motif EXPLICITE
 *                         (AI_NOT_ALLOWED, AI_UNAVAILABLE, AI_BUDGET_BLOCKED,
 *                         AI_TIMEOUT) ;
 *        ↓
 *   N5 help.reformulated  nouvelle recherche sur ces requêtes ;
 *        ↓
 *   N6                    réponse fondée sur la source (extraction, ou
 *                         rédaction ANSWER à partir des articles) —
 *                         décidée par l'orchestrateur ;
 *   repli                 seulement si AUCUNE source fiable au bout de la
 *                         cascade (`fallbackReason`).
 *
 * Le seuil de suffisance est celui de la gouvernance (`cascade.text`, 0,6
 * par défaut) : il n'est JAMAIS abaissé ici. L'IA ne devient jamais la
 * source de vérité : sans article retrouvé, la réponse est le repli.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { RetrievedSource } from '../types/sources';
import { expandHelpQueries, normalizeHelpText, type HelpConceptMatch } from '@/lib/help-center/concepts';

export type HelpStage = 'fulltext' | 'expanded' | 'reformulated';

/** Source du Centre d'aide retrouvée à une étape, par une requête. */
export interface StagedHelpSource extends RetrievedSource {
  stage: HelpStage;
  query: string;
  /** Nombre de requêtes de l'étape (et des précédentes) qui l'ont retrouvée. */
  queryHits: number;
  /** Requêtes qui l'ont retrouvée (fusion des étapes). */
  queries?: string[];
}

/** Résultat d'une recherche multi-requêtes dans le corpus. */
export interface HelpSearchResult {
  /** `false` : corpus du Centre d'aide indisponible (0 résultat TECHNIQUE). */
  corpusAvailable: boolean;
  corpusVersion: string | null;
  sources: StagedHelpSource[];
  /** Sections candidates (couverture suffisante), avant la limite. */
  candidateCount: number;
  /** Sections écartées : couverture insuffisante, contexte (plateforme), non publiées. */
  rejected: { lowCoverage: number; contextExcluded: number };
}

/** Recherche dans le corpus de l'environnement, pour un lot de requêtes. */
export type HelpSearcher = (queries: string[], stage: HelpStage) => Promise<HelpSearchResult>;

export type HelpAiBlockReason = 'AI_NOT_ALLOWED' | 'AI_UNAVAILABLE' | 'AI_BUDGET_BLOCKED' | 'AI_TIMEOUT';

/** Compréhension par UNDERSTAND (appelée ou réutilisée). */
export type HelpUnderstandOutcome =
  | { status: 'called' | 'reused'; intent: string | null; queries: string[] }
  | { status: 'blocked'; reason: HelpAiBlockReason }
  | { status: 'failed'; reason: HelpAiBlockReason }
  | { status: 'cancelled' };

export type HelpFallbackReason =
  | 'HELP_CORPUS_UNAVAILABLE'
  | 'NO_RELIABLE_SOURCE'
  | HelpAiBlockReason
  | 'UNDERSTAND_NO_QUERY';

export interface HelpLevelTrace {
  level: 2 | 3 | 4 | 5;
  stage: HelpStage | 'understand';
  strategy: string;
  queries: string[];
  candidateCount: number;
  rejected?: { lowCoverage: number; contextExcluded: number };
  bestScore: number;
  threshold: number;
  status: 'SUFFICIENT' | 'INSUFFICIENT' | 'SKIPPED' | 'EXECUTED' | 'FAILED';
  /** Motif d'insuffisance ou de saut. */
  reason?: string;
}

/** Trace détaillée du Centre d'aide (persistée avec la cascade). */
export interface HelpCascadeTrace {
  corpus: { available: boolean; version: string | null };
  retrievalQueryInitial: string;
  retrievalQueriesExpanded: string[];
  concept: { id: string; certain: boolean } | null;
  levels: HelpLevelTrace[];
  understanding: {
    task: 'UNDERSTAND';
    operation: 't2_understand';
    status: HelpUnderstandOutcome['status'];
    queries: string[];
    reason?: HelpAiBlockReason;
  } | null;
  sources: Array<{ type: string; id: string; title: string; score: number; stage: HelpStage }>;
  sufficiency: 'SUFFICIENT' | 'INSUFFICIENT';
  fallbackReason: HelpFallbackReason | null;
  /**
   * Nature d'un échec : aucun candidat (0 résultat), candidats sous le
   * seuil, ou candidats écartés (couverture, contexte).
   */
  failureKind?: 'TECHNICAL_NO_CORPUS' | 'NO_CANDIDATE' | 'LOW_SCORE' | 'REJECTED';
}

export interface HelpCascadeResult {
  sufficient: boolean;
  /** Sources retenues (≥ seuil), meilleure en tête. Vide en repli. */
  sources: StagedHelpSource[];
  bestScore: number;
  concept: HelpConceptMatch | null;
  trace: HelpCascadeTrace;
  /** UNDERSTAND appelé par la cascade (compteur d'appels de la demande). */
  understandCalled: boolean;
  cancelled?: boolean;
}

const cle = (s: RetrievedSource) => s.id;

/** Fusion des sources de plusieurs étapes : meilleur score par section (pure). */
export function mergeHelpSources(...lots: StagedHelpSource[][]): StagedHelpSource[] {
  const parId = new Map<string, StagedHelpSource>();
  for (const lot of lots) {
    for (const s of lot) {
      const prev = parId.get(cle(s));
      const requetes = (x: StagedHelpSource) => x.queries ?? [x.query];
      if (!prev) { parId.set(cle(s), { ...s, queries: requetes(s) }); continue; }
      const hits = prev.queryHits + s.queryHits;
      const queries = [...new Set([...requetes(prev), ...requetes(s)])];
      if ((s.relevanceScore ?? 0) > (prev.relevanceScore ?? 0)) parId.set(cle(s), { ...s, queryHits: hits, queries });
      else { prev.queryHits = hits; prev.queries = queries; }
    }
  }
  // Score d'abord ; à score égal, la section retrouvée par le plus de
  // requêtes (consensus), puis l'étape la plus précoce.
  const ordreEtape: Record<HelpStage, number> = { fulltext: 0, expanded: 1, reformulated: 2 };
  return [...parId.values()].sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0)
    || b.queryHits - a.queryHits || ordreEtape[a.stage] - ordreEtape[b.stage]);
}

const best = (l: RetrievedSource[]) => l.reduce((m, s) => Math.max(m, s.relevanceScore ?? 0), 0);

/**
 * Requêtes de recherche tirées de la compréhension UNDERSTAND (pure) : sujets
 * demandés, indices d'aide ou de document, justification courte — puis leur
 * élargissement déterministe. Le modèle STRUCTURE la demande ; ces requêtes
 * ne sont que des recherches dans le Centre d'aide.
 */
export function queriesFromUnderstanding(u: {
  requestedTopics?: string[];
  entityHints?: Array<{ type: string; value: string }>;
  reason?: string | null;
}, message: string): string[] {
  const brut = [
    ...(u.requestedTopics ?? []),
    ...(u.entityHints ?? []).filter((h) => h.type === 'help' || h.type === 'document').map((h) => h.value),
    ...(u.reason && u.reason.length <= 160 ? [u.reason.replace(/^classification modèle(?: — )?/, '')] : []),
  ].map((q) => q.trim()).filter((q) => q.length >= 3 && q.length <= 160);
  const original = normalizeHelpText(message);
  const out: string[] = [];
  const add = (q: string) => {
    const n = normalizeHelpText(q);
    if (n && n !== original && !out.some((x) => normalizeHelpText(x) === n)) out.push(q);
  };
  for (const q of brut) {
    add(q);
    expandHelpQueries(q).queries.forEach(add);
  }
  return out.slice(0, 8);
}

/**
 * Exécute la cascade du Centre d'aide. `understand` n'est appelé qu'après
 * l'échec des niveaux déterministes ; il rend des requêtes, jamais une
 * réponse.
 */
export async function runHelpCascade(p: {
  message: string;
  threshold: number;
  search: HelpSearcher;
  understand: () => Promise<HelpUnderstandOutcome>;
  /** Plafond de sources retenues. */
  maxSources: number;
}): Promise<HelpCascadeResult> {
  const { message, threshold } = p;
  const levels: HelpLevelTrace[] = [];
  const expandedQueries: string[] = [];
  const trace: HelpCascadeTrace = {
    corpus: { available: true, version: null },
    retrievalQueryInitial: message,
    retrievalQueriesExpanded: expandedQueries,
    concept: null,
    levels,
    understanding: null,
    sources: [],
    sufficiency: 'INSUFFICIENT',
    fallbackReason: null,
  };
  let understandCalled = false;
  let candidats = 0;
  let ecartes = 0;
  let toutes: StagedHelpSource[] = [];

  const niveau = (level: HelpLevelTrace['level'], stage: HelpStage, queries: string[], r: HelpSearchResult, cumul: StagedHelpSource[]) => {
    candidats += r.candidateCount;
    ecartes += r.rejected.lowCoverage + r.rejected.contextExcluded;
    const score = best(cumul);
    const ok = score >= threshold && threshold < 1;
    levels.push({
      level, stage, strategy: `help.${stage}`, queries, candidateCount: r.candidateCount, rejected: r.rejected,
      bestScore: Math.round(score * 1000) / 1000, threshold,
      status: ok ? 'SUFFICIENT' : 'INSUFFICIENT',
      ...(ok ? {} : { reason: threshold >= 1 ? 'THRESHOLD_FORCES_ESCALATION' : r.candidateCount === 0 && cumul.length === 0 ? 'NO_RESULT' : 'LOW_RELEVANCE' }),
    });
    return ok;
  };

  const terminer = (sufficient: boolean, fallbackReason: HelpFallbackReason | null, extra: Partial<HelpCascadeResult> = {}): HelpCascadeResult => {
    const fiables = toutes.filter((s) => (s.relevanceScore ?? 0) >= threshold);
    // Concept certain (verbe ET objet) : les sections que ses requêtes
    // canoniques retrouvent passent devant — « mettre une facture » vise
    // l'ajout de document, pas l'article de facturation qui cite « facture ».
    const canon = new Set((expansion.concept?.certain ? expansion.concept.concept.queries : []).map(normalizeHelpText));
    const duConcept = (s: StagedHelpSource) => (s.queries ?? [s.query]).some((q) => canon.has(normalizeHelpText(q)));
    // Les autres sections fiables ne sont gardées que si le concept n'a rien
    // retrouvé (pas de « voir aussi » hors sujet).
    const conceptuelles = canon.size ? fiables.filter(duConcept) : [];
    const ordonnees = conceptuelles.length ? conceptuelles : fiables;
    const retenues = sufficient ? limiterParArticle(ordonnees, p.maxSources) : [];
    trace.sufficiency = sufficient ? 'SUFFICIENT' : 'INSUFFICIENT';
    trace.fallbackReason = sufficient ? null : fallbackReason;
    trace.sources = retenues.map((s) => ({
      type: s.type, id: s.id, title: s.title, score: Math.round((s.relevanceScore ?? 0) * 1000) / 1000, stage: s.stage,
    }));
    if (!sufficient) {
      trace.failureKind = !trace.corpus.available ? 'TECHNICAL_NO_CORPUS'
        : toutes.length > 0 ? 'LOW_SCORE'
          : candidats === 0 && ecartes > 0 ? 'REJECTED' : 'NO_CANDIDATE';
    }
    return {
      sufficient, sources: retenues, bestScore: best(toutes), concept: expansion.concept, trace, understandCalled, ...extra,
    };
  };

  // ── N2 : plein texte ────────────────────────────────────────────────────
  const n2 = await p.search([message], 'fulltext');
  trace.corpus = { available: n2.corpusAvailable, version: n2.corpusVersion };
  toutes = mergeHelpSources(n2.sources);
  const expansion = expandHelpQueries(message);
  trace.concept = expansion.concept ? { id: expansion.concept.concept.id, certain: expansion.concept.certain } : null;
  if (!n2.corpusAvailable) {
    // 0 résultat TECHNIQUE : aucune source ne peut être retrouvée, et l'IA ne
    // la remplace pas — repli explicite, sans appel modèle.
    levels.push({ level: 2, stage: 'fulltext', strategy: 'help.fulltext', queries: [message], candidateCount: 0, bestScore: 0, threshold, status: 'FAILED', reason: 'HELP_CORPUS_UNAVAILABLE' });
    return terminer(false, 'HELP_CORPUS_UNAVAILABLE');
  }
  const n2Suffisant = niveau(2, 'fulltext', [message], n2, toutes);
  // Concept certain : la recherche élargie est TOUJOURS menée (déterministe,
  // sans coût) — elle confirme ou corrige le plein texte (classement).
  if (n2Suffisant && !expansion.concept?.certain) return terminer(true, null);

  // ── N3 : recherche élargie (synonymes, concepts, libellés) ─────────────
  if (expansion.queries.length) {
    expandedQueries.push(...expansion.queries);
    const n3 = await p.search(expansion.queries, 'expanded');
    toutes = mergeHelpSources(toutes, n3.sources);
    if (niveau(3, 'expanded', expansion.queries, n3, toutes) || n2Suffisant) return terminer(true, null);
  } else if (n2Suffisant) {
    return terminer(true, null);
  } else {
    levels.push({ level: 3, stage: 'expanded', strategy: 'help.expanded', queries: [], candidateCount: 0, bestScore: best(toutes), threshold, status: 'SKIPPED', reason: 'NO_EXPANSION' });
  }

  // ── N4 : UNDERSTAND (compréhension / reformulation) ─────────────────────
  const u = await p.understand();
  if (u.status === 'cancelled') return terminer(false, 'NO_RELIABLE_SOURCE', { cancelled: true });
  if (u.status === 'blocked' || u.status === 'failed') {
    trace.understanding = { task: 'UNDERSTAND', operation: 't2_understand', status: u.status, queries: [], reason: u.reason };
    if (u.status === 'failed') understandCalled = true;
    levels.push({ level: 4, stage: 'understand', strategy: 'help.understand', queries: [], candidateCount: 0, bestScore: best(toutes), threshold, status: u.status === 'failed' ? 'FAILED' : 'SKIPPED', reason: u.reason });
    return terminer(false, u.reason);
  }
  understandCalled = u.status === 'called';
  trace.understanding = { task: 'UNDERSTAND', operation: 't2_understand', status: u.status, queries: u.queries };
  const nouvelles = u.queries.filter((q) => !expandedQueries.some((x) => normalizeHelpText(x) === normalizeHelpText(q)));
  levels.push({ level: 4, stage: 'understand', strategy: 'help.understand', queries: nouvelles, candidateCount: 0, bestScore: best(toutes), threshold, status: 'EXECUTED', ...(nouvelles.length ? {} : { reason: 'NO_QUERY' }) });
  if (!nouvelles.length) return terminer(false, 'UNDERSTAND_NO_QUERY');

  // ── N5 : nouvelle recherche sur les requêtes de la compréhension ───────
  expandedQueries.push(...nouvelles);
  const n5 = await p.search(nouvelles, 'reformulated');
  toutes = mergeHelpSources(toutes, n5.sources);
  if (niveau(5, 'reformulated', nouvelles, n5, toutes)) return terminer(true, null);
  return terminer(false, 'NO_RELIABLE_SOURCE');
}

/** Deux sections au plus par article (citer l'article, pas le recopier). */
function limiterParArticle(sources: StagedHelpSource[], max: number): StagedHelpSource[] {
  const n = new Map<string, number>();
  return sources.filter((s) => {
    const a = String(s.meta?.articleId ?? s.id);
    const k = n.get(a) ?? 0;
    n.set(a, k + 1);
    return k < 2;
  }).slice(0, Math.max(1, max));
}
