/**
 * Réponses T2 issues des RESSOURCES — lot 110E (ticket « T2 : réponses
 * issues des Ressources, couverture effective des suggestions »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CAUSE RACINE (reproduite sur le corpus réel `pub108p`, test L110E-U01)
 *
 *   1. au clic sur « Quand faire la révision d’une voiture ? », T2 ne
 *      recevait que l'intention et le corpus : la référence E03 était perdue ;
 *   2. la recherche plein texte réduit la question à « révision » +
 *      « voiture » (« quand » est un mot vide) : la présentation de C01
 *      (coût annuel, dont le résumé cite les « révisions ») et celle de E03
 *      obtiennent toutes deux 1,000 ; à égalité, l'ordre du corpus met C01
 *      devant ;
 *   3. score ≥ 0,75 : réponse « exacte » sans modèle = extrait de C01
 *      (« additionnez… »), « La procédure complète est dans l’article »,
 *      « Voir aussi » E03, et « Lire la Ressource » vers C01.
 *
 * CE MODULE (pur, testé)
 *
 *   · `questionKind` / `guardResourceSources` : la NATURE de la question
 *     (quand / combien de temps / combien coûte / quels documents) doit être
 *     compatible avec celle de l'article (son titre) et le passage doit
 *     porter des repères de cette nature — un article « coût » ne répond pas
 *     à « quand ». Règle linguistique générale, appliquée aux seules
 *     Ressources (le Centre d'aide est inchangé) ;
 *   · `applyResourceAnswering` : après la cascade, la PREUVE de la
 *     suggestion (revalidée par le serveur) devient la source prioritaire si
 *     ses passages sont présents ; sinon la meilleure Ressource compatible,
 *     limitée à son article (les compléments ne détournent pas la réponse) ;
 *     sinon un repli HONNÊTE et motivé ;
 *   · `resourceAnswerFromSources` : réponse d'abord (phrases publiées),
 *     réserves (« À noter »), manque explicite si partiel ; citations et
 *     « Lire la Ressource » sont les sources et boutons de la réponse.
 *   · `ResourcesTrace` : ce que le journal BO « Questions sans réponse » lit
 *     (codes, identifiants, scores — jamais de texte d'article ni de compte).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { RetrievedSource } from '../types/sources';
import type { AssistantRequestInput, SuggestionEvidence } from '../types/contracts';
import type { HelpCorpusArticle } from './help-corpus.service';
import type { HelpCascadeResult, StagedHelpSource } from './help-cascade';
import { GUIDE_STOCK } from '@/services/suggestions/shared/stock';
import { checkResourceEvidence, normalizeQuestionLabel, splitSentences } from '@/services/suggestions/shared/resource-questions';

export const RESOURCE_SOURCE_PREFIX = 'RES-';
const estRessource = (s: Pick<RetrievedSource, 'meta' | 'id'>) =>
  String(s.meta?.articleId ?? '').startsWith(RESOURCE_SOURCE_PREFIX) || /^help_RES-/.test(String(s.id));
const articleDe = (s: Pick<RetrievedSource, 'meta' | 'id'>) =>
  String(s.meta?.articleId ?? String(s.id).replace(/^help_/, '').split('__')[0]);
const ancreDe = (s: Pick<RetrievedSource, 'id'>) => String(s.id).split('__')[1] ?? 'presentation';

// ── Nature de la question ───────────────────────────────────────────────────

export type QuestionKind = 'WHEN' | 'DURATION' | 'COST' | 'DOCUMENTS';

const norm = (s: string) => ` ${s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’'`]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()} `;

/** Ordre : la forme la plus précise d'abord (« combien de temps » avant « combien »). */
const KINDS: ReadonlyArray<[QuestionKind, RegExp]> = [
  ['DURATION', / combien de temps | pendant combien | quelle duree | duree de conservation /],
  ['COST', / combien (?:coute|coutent|ca coute|faut il prevoir pour) | quel (?:cout|prix|budget) | quels couts | cout (?:annuel|d entretien|total) /],
  ['WHEN', / quand | a quelle (?:frequence|date|periodicite) | quelle (?:frequence|periodicite|date|echeance) | tous les combien | a quel moment | combien de fois /],
  ['DOCUMENTS', / quels? (?:documents?|pieces?|justificatifs?|papiers?) | quelles (?:pieces|preuves) | que (?:garder|conserver) /],
];

/** Nature d'une question ou d'un titre (pure) ; `null` : indéterminée (aucune contrainte). */
export function questionKind(text: string): QuestionKind | null {
  const t = norm(text);
  for (const [k, re] of KINDS) if (re.test(t)) return k;
  return null;
}

/** Repères qu'un passage doit porter pour répondre à une question de cette nature. */
const CUES: Readonly<Record<QuestionKind, RegExp>> = {
  WHEN: / (?:quand|date|delai|tous les|chaque|annuel(?:le)?|annee|ans?|mois|km|kilometr\w*|periodicit\w*|frequence|intervalle|seuil|echeance|avant|apres|au plus tard|calendrier|rappel|anniversaire) /,
  DURATION: / (?:ans?|annees?|mois|duree|jusqu|pendant|permanente?|conserv\w*) /,
  COST: / (?:cout\w*|prix|montant|budget|depense\w*|euros?|ttc|factur\w*|paiement\w*) /,
  DOCUMENTS: / (?:documents?|factures?|attestations?|contrats?|devis|notices?|proces verbal|certificats?|justificatifs?|diagnostics?|acte|titre) /,
};

export interface ResourceGuardDecision {
  id: string;
  articleId: string;
  anchor: string;
  score: number;
  kept: boolean;
  reason?: 'KIND_MISMATCH' | 'NO_ANSWER_CUE';
}

/**
 * Garde de pertinence des Ressources (pure) : une section d'un article dont
 * le TITRE exprime une autre nature que la question (coût ≠ quand), ou dont
 * le passage ne porte aucun repère de la nature demandée, est écartée — même
 * avec un score lexical élevé. Les sources du Centre d'aide passent telles
 * quelles. Question de nature indéterminée : rien n'est écarté.
 */
export function guardResourceSources<T extends RetrievedSource>(message: string, sources: T[]): { kept: T[]; decisions: ResourceGuardDecision[] } {
  const kind = questionKind(message);
  const decisions: ResourceGuardDecision[] = [];
  const kept = sources.filter((s) => {
    if (!estRessource(s)) return true;
    const titre = String(s.title).split(' — ')[0];
    const tk = questionKind(titre);
    let reason: ResourceGuardDecision['reason'];
    if (kind && tk && tk !== kind) reason = 'KIND_MISMATCH';
    else if (kind && !CUES[kind].test(norm(`${s.title} ${String(s.content)}`))) reason = 'NO_ANSWER_CUE';
    decisions.push({ id: s.id, articleId: articleDe(s), anchor: ancreDe(s), score: Math.round((s.relevanceScore ?? 0) * 1000) / 1000, kept: !reason, ...(reason ? { reason } : {}) });
    return !reason;
  });
  return { kept, decisions };
}

// ── Question documentaire (routage d'une question LIBRE) ────────────────────

/** Formulation qui vise le compte ou l'application (jamais une question documentaire). */
const PERSONNEL = / (?:mon|ma|mes|notre|nos|je|j|moi|me|m|mien|mienne|miens|on m) /;
const APPLICATION = / (?:verebona|application|appli|app|compte|espace|page|bouton|onglet|ecran|menu|tableau de bord|agenda verebona|mot de passe|abonnement|offre) /;
/** Demande de RECHERCHE ou d'action (« trouve une facture ») : toujours le compte. */
const RECHERCHE = /^ (?:trouve|trouver|retrouve|retrouver|cherche|chercher|recherche|montre|montrer|affiche|afficher|liste|lister|ouvre|ouvrir|donne|donner|ajoute|ajouter|cree|creer|supprime|envoie|exporte|ou (?:est|sont|se trouve)) /;
/** Forme interrogative GÉNÉRALE (« comment… », « faut-il… ») quand la nature n'est pas reconnue. */
const INTERROGATIVE = /^ (?:comment|pourquoi|faut il|doit on|peut on|est il|est ce qu|qu est ce|que faire|quoi faire|qui doit|qui paie|a qui) /;

/**
 * Question formulée de façon GÉNÉRALE sur un sujet documentaire (pure) :
 * objet indéfini (« une voiture », « un logement »), aucune marque
 * personnelle (« mon », « ma », « je »), aucun vocabulaire de l'application,
 * aucun chiffre (date, montant, immatriculation → faits du compte), aucun
 * objet du compte ouvert sur la page, pas une demande de recherche
 * (« trouve une facture… »), et une forme interrogative documentaire
 * (nature reconnue : quand / combien de temps / combien coûte / quels
 * documents ; ou « comment… », « faut-il… »).
 */
export function isDocumentaryQuestion(message: string, page?: AssistantRequestInput['pageContext']): boolean {
  const t = norm(message);
  if (t.trim().length < 8 || t.trim().length > 160) return false;
  if (/\d/.test(t)) return false;
  if (PERSONNEL.test(t) || APPLICATION.test(t) || RECHERCHE.test(t)) return false;
  if (!/ (?:un|une|des) /.test(t)) return false;
  if (!questionKind(message) && !INTERROGATIVE.test(t)) return false;
  const p = (page ?? {}) as Record<string, unknown>;
  if (p.assetId || p.documentId || p.agendaItemId || p.supplierId) return false;
  return true;
}

// ── Trace (journal BO) ──────────────────────────────────────────────────────

/** Motifs du journal « Questions sans réponse » (distincts, ticket §5). */
export type UnansweredMotive =
  | 'COVERAGE_ABSENT' | 'PARTIAL_COVERAGE' | 'RETRIEVAL_MISSED' | 'ACCOUNT_DATA_INSUFFICIENT'
  | 'CONTRADICTION_AMBIGUITY' | 'CORPUS_UNAVAILABLE' | 'QUALITY_ALERT';

export interface ResourcesTrace {
  origin: 'SUGGESTION' | 'FREE';
  suggestionId: string | null;
  /** Question libre reconnue par le libellé exact d'une question du catalogue. */
  catalogQuestionId?: string | null;
  routing?: { decision: 'RESOURCES' | 'KEPT'; previousIntent: string | null; bestArticle: string | null; bestScore: number | null; reason: string };
  evidence?: Omit<SuggestionEvidence, 'answerSentences'> | null;
  corpus?: { available: boolean; version: string | null; environment: string | null };
  /** Sections Ressources examinées (≤ 12) et verdict de la garde de pertinence. */
  examined: ResourceGuardDecision[];
  selection: 'EVIDENCE' | 'RETRIEVAL' | 'NONE';
  selected: { articleId: string; anchors: string[] } | null;
  outcome: 'ANSWERED' | 'PARTIAL' | 'FALLBACK' | 'NOT_RESOURCES';
  motive: UnansweredMotive | null;
  qualityAlerts: Array<'HIGH_SCORE_OFF_TOPIC' | 'RETRIEVAL_DIVERGED_FROM_EVIDENCE' | 'EVIDENCE_STALE'>;
  fallbackReason?: string | null;
  appEnvironment: string | null;
  appRevision: string | null;
}

const revisionApplicative = () => (process.env.SOURCE_VERSION || process.env.APP_COMMIT || '').slice(0, 12) || null;

// ── Sources probantes ───────────────────────────────────────────────────────

/** Sources citables d'une preuve (sections déclarées de l'article publié) — `null` si l'article ou ses sections manquent. */
export function evidenceSources(ev: SuggestionEvidence, article: HelpCorpusArticle | null, corpusVersion: string | null): StagedHelpSource[] | null {
  if (!article || !ev.articleId || article.id !== ev.articleId) return null;
  const par = new Map(article.sections.map((s) => [s.anchor, s]));
  const voulues = [...ev.answerSections.map((a) => ['answer', a] as const), ...ev.reserveSections.map((a) => ['reserve', a] as const)];
  if (!ev.answerSections.some((a) => par.has(a))) return null;
  const out: StagedHelpSource[] = [];
  voulues.forEach(([role, anchor], i) => {
    const s = par.get(anchor);
    if (!s) return;
    out.push({
      id: `help_${article.id}__${anchor}`,
      type: 'help_entry',
      title: anchor === 'presentation' ? article.title : `${article.title} — ${s.heading}`,
      content: s.text,
      meta: {
        articleId: article.id,
        path: anchor === 'presentation' ? article.path : `${article.path}#${anchor}`,
        category: article.categoryName,
        offersLabel: article.offersLabel,
        notIncludedInPlan: false,
        corpusVersion,
        resourceRole: role,
        // Métadonnées scalaires seulement : listes sérialisées (lues par `resourceAnswerFromSources`).
        ...(i === 0 ? { answerSentences: JSON.stringify(ev.answerSentences), missingSubjects: JSON.stringify(ev.missingSubjects) } : {}),
      },
      // La preuve passe devant toute autre source ; les réserves la suivent.
      relevanceScore: role === 'answer' ? 1 : 0.99,
      stage: 'fulltext', query: 'evidence', queryHits: 1,
    });
  });
  return out;
}

// ── Après la cascade : preuve, focalisation ou repli ───────────────────────

export type ResourceAnswering =
  | { kind: 'unchanged'; trace: ResourcesTrace | null }
  | { kind: 'sources'; sources: StagedHelpSource[]; trace: ResourcesTrace }
  | { kind: 'fallback'; text: string; reason: string; trace: ResourcesTrace };

export const RESOURCES_NO_ANSWER_MESSAGE = 'Je n’ai pas trouvé, dans les Ressources publiées par Verebona, de passage qui réponde de façon fiable à cette question. '
  + 'Je préfère ne pas vous donner d’information non vérifiée.';
export const RESOURCES_UNAVAILABLE_MESSAGE = 'Les Ressources Verebona sont momentanément indisponibles : je ne peux pas répondre à cette question de façon fiable pour le moment. '
  + 'Réessayez un peu plus tard.';

const CORPUS_CODES = /^(?:HELP|RESOURCES)_CORPUS_/;

/** Question du catalogue dont le libellé est EXACTEMENT celui posé (question libre). */
export function catalogQuestionForLabel(message: string): string | null {
  const n = normalizeQuestionLabel(message);
  return GUIDE_STOCK.find((e) => e.corpus === 'RESOURCES' && normalizeQuestionLabel(e.label) === n)?.id ?? null;
}

/**
 * Décision Ressources après la cascade (pure). Ne concerne que les questions
 * Ressources : suggestion RESSOURCES revalidée, question libre routée vers
 * les Ressources, ou réponse dont la meilleure source est une Ressource.
 */
export function applyResourceAnswering(p: {
  message: string;
  input: Pick<AssistantRequestInput, 'suggestion' | 'corpusPreference'>;
  aide: HelpCascadeResult;
  article: ((id: string) => HelpCorpusArticle | null) | null;
  examined: ResourceGuardDecision[];
  corpus: { available: boolean; version: string | null; environment: string | null };
  routing?: ResourcesTrace['routing'];
}): ResourceAnswering {
  const sugg = p.input.suggestion ?? null;
  const parSuggestion = sugg?.corpus === 'RESOURCES';
  const catalogQuestionId = parSuggestion ? null : catalogQuestionForLabel(p.message);
  const ressources = parSuggestion || p.input.corpusPreference === 'RESOURCES' || catalogQuestionId != null
    || (p.aide.sufficient && p.aide.sources[0] != null && estRessource(p.aide.sources[0]));
  if (!ressources) return { kind: 'unchanged', trace: null };

  // Question libre au libellé du catalogue : sa preuve, vérifiée ici sur l'article servi.
  let ev: SuggestionEvidence | null = parSuggestion ? sugg?.evidence ?? null : null;
  if (!ev && catalogQuestionId) {
    const e = GUIDE_STOCK.find((x) => x.id === catalogQuestionId)!;
    const a = p.article?.(`${RESOURCE_SOURCE_PREFIX}${e.articleId}`) ?? null;
    const c = checkResourceEvidence(catalogQuestionId, p.corpus.available
      ? { version: p.corpus.version ?? '-', environment: p.corpus.environment ?? '-', articles: a ? [a] : [] } : null);
    ev = { questionId: catalogQuestionId, status: c.status, articleId: c.articleId, revision: c.revision, revisionChanged: c.revisionChanged,
      corpusVersion: c.corpusVersion, environment: c.environment, answerSections: c.answerSections, reserveSections: c.reserveSections,
      missingSubjects: c.missingSubjects, answerSentences: c.answerSentences };
  }
  const { answerSentences: _a, ...evTrace } = ev ?? ({} as SuggestionEvidence);
  const examined = p.examined.slice(0, 12);
  const meilleureExaminee = [...p.examined].sort((x, y) => y.score - x.score)[0] ?? null;
  const horsSujetFort = meilleureExaminee != null && !meilleureExaminee.kept;
  const trace: ResourcesTrace = {
    origin: parSuggestion ? 'SUGGESTION' : 'FREE',
    suggestionId: sugg?.id ?? null,
    ...(catalogQuestionId ? { catalogQuestionId } : {}),
    ...(p.routing ? { routing: p.routing } : {}),
    evidence: ev ? evTrace : null,
    corpus: p.corpus,
    examined,
    selection: 'NONE', selected: null, outcome: 'FALLBACK', motive: null, qualityAlerts: [],
    appEnvironment: p.corpus.environment, appRevision: revisionApplicative(),
  };
  const topCascade = p.aide.sufficient && p.aide.sources[0] ? articleDe(p.aide.sources[0]) : null;

  // 1. Preuve revalidée : source prioritaire si ses passages sont présents.
  if (ev && (ev.status === 'VERIFIED' || ev.status === 'PARTIAL')) {
    const src = evidenceSources(ev, p.article?.(ev.articleId ?? '') ?? null, p.corpus.version);
    if (src && src.length) {
      trace.selection = 'EVIDENCE';
      trace.selected = { articleId: ev.articleId!, anchors: src.map(ancreDe) };
      trace.outcome = ev.status === 'PARTIAL' ? 'PARTIAL' : 'ANSWERED';
      if (topCascade && topCascade !== ev.articleId) trace.qualityAlerts.push('RETRIEVAL_DIVERGED_FROM_EVIDENCE');
      if (horsSujetFort) trace.qualityAlerts.push('HIGH_SCORE_OFF_TOPIC');
      trace.motive = ev.status === 'PARTIAL' ? 'PARTIAL_COVERAGE'
        : trace.qualityAlerts.includes('RETRIEVAL_DIVERGED_FROM_EVIDENCE') ? 'RETRIEVAL_MISSED' : null;
      return { kind: 'sources', sources: src, trace };
    }
    trace.qualityAlerts.push('EVIDENCE_STALE');
  }

  // 2. Ressources indisponibles : jamais une réponse d'un autre corpus pour une question Ressources.
  const raison = p.aide.trace.fallbackReason ?? null;
  if (!p.corpus.available || ev?.status === 'CORPUS_UNAVAILABLE') {
    trace.motive = 'CORPUS_UNAVAILABLE';
    trace.fallbackReason = !p.corpus.available ? 'RESOURCES_CORPUS_UNAVAILABLE' : raison;
    return { kind: 'fallback', text: RESOURCES_UNAVAILABLE_MESSAGE, reason: 'RESOURCES_CORPUS_UNAVAILABLE', trace };
  }

  // 3. Meilleure Ressource compatible retrouvée : son article seulement.
  const top = p.aide.sufficient ? p.aide.sources[0] : null;
  if (top && estRessource(top)) {
    const art = articleDe(top);
    const focus = p.aide.sources.filter((s) => articleDe(s) === art).slice(0, 2);
    trace.selection = 'RETRIEVAL';
    trace.selected = { articleId: art, anchors: focus.map(ancreDe) };
    trace.outcome = 'ANSWERED';
    if (horsSujetFort) trace.qualityAlerts.push('HIGH_SCORE_OFF_TOPIC');
    if (ev?.articleId && ev.articleId !== art) trace.qualityAlerts.push('RETRIEVAL_DIVERGED_FROM_EVIDENCE');
    trace.motive = trace.qualityAlerts.includes('RETRIEVAL_DIVERGED_FROM_EVIDENCE') ? 'RETRIEVAL_MISSED'
      : trace.qualityAlerts.length ? 'QUALITY_ALERT' : null;
    return { kind: 'sources', sources: focus, trace };
  }

  // 4. Une source du Centre d'aide en tête pour une question LIBRE : elle reste légitime.
  if (top && !parSuggestion) {
    trace.outcome = 'NOT_RESOURCES';
    return { kind: 'unchanged', trace };
  }

  // 5. Aucun passage autorisé ne répond : repli honnête, motif juste.
  trace.fallbackReason = raison ?? (top ? 'HELP_SOURCE_FOR_RESOURCE_QUESTION' : 'NO_RESOURCE_PASSAGE');
  trace.motive = raison && CORPUS_CODES.test(raison) ? 'CORPUS_UNAVAILABLE'
    : raison === 'HELP_CONTRADICTION' ? 'CONTRADICTION_AMBIGUITY'
      : ev && ev.status !== 'NO_EVIDENCE_DECLARED' ? 'RETRIEVAL_MISSED' : 'COVERAGE_ABSENT';
  if (horsSujetFort) trace.qualityAlerts.push('HIGH_SCORE_OFF_TOPIC');
  return { kind: 'fallback', text: RESOURCES_NO_ANSWER_MESSAGE, reason: trace.fallbackReason, trace };
}

// ── Réponse rédigée sans modèle ─────────────────────────────────────────────

const liste = (v: unknown): string[] => {
  try {
    const x = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(x) ? x.filter((y): y is string => typeof y === 'string' && y.length > 0) : [];
  } catch { return []; }
};
const phrases = (t: string, n: number) => splitSentences(String(t ?? '').split('\n[Offre]')[0]).slice(0, n);

/**
 * Réponse à partir de passages Ressources (pure) : la réponse d'abord (les
 * phrases publiées qui répondent), puis « À noter » (première phrase de
 * chaque section de réserve), puis — réponse partielle — ce que les
 * Ressources ne précisent PAS. Aucun renvoi « lisez l'article » : le lien
 * « Lire la Ressource » est un complément, en bouton.
 */
export function resourceAnswerFromSources(sources: RetrievedSource[]): string | null {
  const res = sources.filter((s) => s.type === 'help_entry' && estRessource(s));
  if (!res.length) return null;
  const tete = res[0];
  const art = articleDe(tete);
  const duMeme = res.filter((s) => articleDe(s) === art);
  const reponses = duMeme.filter((s) => (s.meta?.resourceRole ?? 'answer') === 'answer');
  const reserves = duMeme.filter((s) => s.meta?.resourceRole === 'reserve');
  const prouvees = liste(tete.meta?.answerSentences);
  const corps = prouvees.length ? prouvees : phrases(String(reponses[0]?.content ?? tete.content), 2);
  if (!corps.length) return null;
  const aNoter = (reserves.length ? reserves : reponses.slice(1, 2))
    .map((s) => phrases(String(s.content), 1)[0]).filter((x): x is string => Boolean(x) && !corps.includes(x!)).slice(0, 2);
  const manque = liste(tete.meta?.missingSubjects);
  return [
    corps.join(' '),
    aNoter.length ? `À noter : ${aNoter.join(' ')}` : '',
    manque.length ? `Les Ressources publiées ne précisent pas ${manque.join(', ni ')}.` : '',
  ].filter(Boolean).join('\n\n');
}
