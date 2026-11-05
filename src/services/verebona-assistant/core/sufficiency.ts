/**
 * Moteur de suffisance T2 — décide, explicitement et de façon traçable, si
 * les données déjà présentes suffisent à répondre sans modèle.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * NON-ESCALADE
 *
 *   Niveau 1 — données structurées / calcul      (seuil `cascade.database`)
 *        ↓ uniquement si insuffisant
 *   Niveau 2 — recherche interne / données T1     (seuil `cascade.text`)
 *        ↓ uniquement si insuffisant
 *   Niveau 3 — LLM
 *
 * Chaque niveau rend un score de confiance ∈ [0, 1] ; il suffit si le score
 * atteint le seuil configuré dans la gouvernance IA. Le passage au niveau
 * suivant porte TOUJOURS un motif (`reason`), consigné dans la trace.
 *
 * Règles de qualité (pas de « 1 source trouvée = suffisant ») :
 *   - champ SQL exact, compteur, calcul         → 1.0, suffisant d'emblée ;
 *   - fait T1 « certain », bien ciblé, seul     → 0.9 ;
 *   - fait « probable »                          → 0.65 ;
 *   - plusieurs sources concordantes             → + 0.05 par source (≤ 1) ;
 *   - correspondance partielle aux termes        → score × taux de termes retrouvés ;
 *   - valeurs incompatibles (même information,
 *     même objet, contexte compatible)          → CONFLICTING (jamais de choix) ;
 *   - lot 111K : seuls les candidats ADMISSIBLES (adéquation à la question,
 *     `evidence-adequacy`) entrent ici — confiance d'extraction ≠ pertinence ;
 *   - demande de synthèse / explication          → INSUFFICIENT (motif SYNTHESIS_REQUIRED).
 * ══════════════════════════════════════════════════════════════════════════
 */

type SufficiencyStatus =
  | 'SUFFICIENT_STRUCTURED'
  | 'SUFFICIENT_RETRIEVAL'
  | 'INSUFFICIENT'
  | 'CONFLICTING'
  | 'NOT_APPLICABLE';

export type EscalationReason =
  | 'NO_STRUCTURED_PLAN'
  | 'NO_RESULT'
  | 'LOW_RELEVANCE'
  | 'LOW_CONFIDENCE'
  | 'AMBIGUOUS_TARGET'
  | 'SYNTHESIS_REQUIRED'
  | 'CONFLICTING_VALUES'
  | 'THRESHOLD_FORCES_ESCALATION'
  // Document pertinent sans réponse lisible (§12.4, §23) : pas d'escalade.
  | 'DOCUMENT_IN_ANALYSIS'
  | 'DOCUMENT_ANALYSIS_FAILED'
  // Lot 49 : stratégie structurée candidate, périmètre sémantique non résolu
  // (« internet ») — jamais un total plus large ; T2 (UNDERSTAND) reprend.
  | 'SEMANTIC_SCOPE_UNRESOLVED'
  // Lot 111K : des candidats existent mais aucun ne répond à la question
  // (propriété voisine, contexte ou période incompatibles) ; ou leur
  // correspondance reste incertaine (validation sémantique bornée seulement).
  | 'NO_ADMISSIBLE_EVIDENCE'
  | 'UNCERTAIN_EVIDENCE';

export interface SufficiencyDecision {
  status: SufficiencyStatus;
  /** Niveau évalué. */
  level: 1 | 2;
  score: number;
  threshold: number;
  reason?: EscalationReason;
  detail?: string;
}

export interface CascadeThresholdsLike {
  database: number;
  text: number;
}

/** Seuils appliqués quand la gouvernance n'en fournit pas (ou est injoignable). */
export const DEFAULT_THRESHOLDS: CascadeThresholdsLike = { database: 0.5, text: 0.6 };

const CONFIDENCE_SCORE: Record<string, number> = {
  certain: 0.9,
  probable: 0.65,
  conflictual: 0.3,
};

/**
 * Demandes qui exigent une mise en relation ou une rédaction : niveau 3
 * légitime. Testé sur le message SANS accents : en JavaScript, `\b` ne
 * reconnaît pas « é » comme une lettre (`\bévolution` ne correspond jamais).
 */
const SYNTHESIS = /\b(explique|expliquer|expliquez|pourquoi|analyse|analyser|evolution|tendance|compare|comparer|resume|resumer|synthese|conseille|recommande|que penses|qu en penses|bilan)\b/;

export function requiresSynthesis(message: string): boolean {
  const ascii = message.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/['’]/g, ' ');
  return SYNTHESIS.test(ascii);
}

/** Niveau 1 : un résultat structuré exact est suffisant sauf seuil à 1 (« toujours escalader »). */
export function decideStructured(
  kind: 'exact' | 'list' | 'count' | 'calc' | 'no_result' | 'conflict',
  thresholds: CascadeThresholdsLike,
): SufficiencyDecision {
  const threshold = thresholds.database;
  if (kind === 'conflict') {
    return { status: 'CONFLICTING', level: 1, score: 1, threshold, reason: 'CONFLICTING_VALUES' };
  }
  const score = 1;
  if (threshold >= 1 && kind !== 'no_result') {
    return { status: 'INSUFFICIENT', level: 1, score, threshold, reason: 'THRESHOLD_FORCES_ESCALATION' };
  }
  return { status: 'SUFFICIENT_STRUCTURED', level: 1, score, threshold, detail: kind };
}

interface FactCandidate {
  /** Valeur comparable (nombre + unité normalisés, ou texte normalisé). */
  comparable: string;
  /** Confiance d'EXTRACTION (T1) — jamais la pertinence. */
  confidence: string;
  matchedTerms: number;
  sourceKey: string;
  /**
   * Lot 111K : identité de l'INFORMATION (propriété × objet × qualification,
   * `evidence-adequacy`). Deux valeurs d'informations différentes ne sont
   * jamais un conflit. Absent : une seule information.
   */
  infoKey?: string;
  /** Lot 111K : date utile du candidat (versions successives). */
  date?: string | null;
  /** Lot 111K : part des termes de la demande retrouvés (pertinence lexicale, 0..1). */
  coverage?: number;
}

/** Lot 111K : pluralité des valeurs admissibles (`evidence-adequacy`). */
export type FactPlurality = 'SINGLE' | 'CONCORDANT' | 'SUCCESSIVE_VERSIONS' | 'DIFFERENT_INFORMATION' | 'REAL_CONFLICT';

/** Au-delà, des informations distinctes ne répondent pas à UNE question précise. */
export const MAX_DISTINCT_INFORMATIONS = 4;

/**
 * Niveau 2 — faits T1. Lot 111K : la décision porte EXCLUSIVEMENT sur les
 * candidats ADMISSIBLES (adéquation établie en amont, `evidence-adequacy`) :
 *   - regroupement par information, puis par valeur comparable ;
 *   - une valeur → score de confiance d'extraction × pertinence, renforcé
 *     par la concordance ;
 *   - même information, valeurs datées distinctes → versions successives :
 *     la plus récente ;
 *   - même information, valeurs incompatibles dans un contexte compatible →
 *     conflit RÉEL (jamais de choix) ;
 *   - informations distinctes → aucune contradiction, chacune décidée.
 * Plusieurs valeurs de « même pertinence » ne sont PLUS un conflit par
 * elles-mêmes, et aucun seuil n'est relevé pour compenser.
 */
export function decideFacts(
  candidates: FactCandidate[],
  queryTermCount: number,
  thresholds: CascadeThresholdsLike,
): SufficiencyDecision & { retained?: string; plurality?: FactPlurality; retainedByInfo?: Record<string, string | null> } {
  const threshold = thresholds.text;
  if (candidates.length === 0) {
    return { status: 'INSUFFICIENT', level: 2, score: 0, threshold, reason: 'NO_RESULT' };
  }
  const parInfo = new Map<string, FactCandidate[]>();
  for (const c of candidates) parInfo.set(c.infoKey ?? '', [...(parInfo.get(c.infoKey ?? '') ?? []), c]);
  if (parInfo.size > MAX_DISTINCT_INFORMATIONS) {
    return { status: 'INSUFFICIENT', level: 2, score: 0, threshold, reason: 'LOW_RELEVANCE', detail: `${parInfo.size} informations distinctes`, plurality: 'DIFFERENT_INFORMATION' };
  }
  const retainedByInfo: Record<string, string | null> = {};
  const scores: number[] = [];
  let conflit = 0;
  let versions = false;
  let concordance = false;
  let faibleRatio = false;
  for (const [info, membres] of parInfo) {
    const groups = new Map<string, FactCandidate[]>();
    for (const c of membres) groups.set(c.comparable, [...(groups.get(c.comparable) ?? []), c]);
    let retenu: [string, FactCandidate[]] | null = null;
    if (groups.size === 1) retenu = [...groups][0];
    else {
      const datees = [...groups].map(([v, g]) => ({ v, g, d: g.map((c) => c.date).filter((x): x is string => !!x).sort().pop() ?? null }));
      const tri = [...datees].sort((a, b) => (b.d ?? '').localeCompare(a.d ?? ''));
      if (datees.every((x) => x.d) && tri[0].d! > tri[1].d!) { retenu = [tri[0].v, tri[0].g]; versions = true; }
    }
    if (!retenu) { conflit += 1; retainedByInfo[info] = null; continue; }
    const [valeur, groupe] = retenu;
    retainedByInfo[info] = valeur;
    const best = Math.max(...groupe.map((c) => c.matchedTerms));
    const ratio = groupe.some((c) => c.coverage != null)
      ? Math.max(...groupe.map((c) => c.coverage ?? 0))
      : queryTermCount > 0 ? Math.min(1, best / queryTermCount) : 1;
    if (ratio < 1) faibleRatio = true;
    const base = Math.max(...groupe.map((c) => CONFIDENCE_SCORE[c.confidence] ?? 0.3));
    const sources = new Set(groupe.map((c) => c.sourceKey)).size;
    if (sources > 1) concordance = true;
    scores.push(Math.min(1, (base + 0.05 * (sources - 1)) * ratio));
  }
  const plurality: FactPlurality = parInfo.size > 1 ? 'DIFFERENT_INFORMATION'
    : conflit ? 'REAL_CONFLICT' : versions ? 'SUCCESSIVE_VERSIONS' : concordance ? 'CONCORDANT' : 'SINGLE';
  if (conflit) {
    return {
      status: 'CONFLICTING', level: 2, score: scores.length ? Math.min(...scores) : 1, threshold, reason: 'CONFLICTING_VALUES',
      detail: `${conflit} information(s) en conflit réel`, plurality, retainedByInfo,
    };
  }
  const score = Math.min(...scores);
  const retained = parInfo.size === 1 ? Object.values(retainedByInfo)[0] ?? undefined : undefined;
  if (threshold >= 1) {
    return { status: 'INSUFFICIENT', level: 2, score, threshold, reason: 'THRESHOLD_FORCES_ESCALATION', plurality, retainedByInfo };
  }
  if (score < threshold) {
    return { status: 'INSUFFICIENT', level: 2, score, threshold, reason: faibleRatio ? 'LOW_RELEVANCE' : 'LOW_CONFIDENCE', plurality, retainedByInfo };
  }
  return {
    status: 'SUFFICIENT_RETRIEVAL', level: 2, score, threshold, retained, plurality, retainedByInfo,
    detail: plurality === 'DIFFERENT_INFORMATION' ? `${parInfo.size} informations distinctes` : plurality === 'SUCCESSIVE_VERSIONS' ? 'version la plus récente' : `${new Set(candidates.map((c) => c.sourceKey)).size} source(s) concordante(s)`,
  };
}

/**
 * Niveau 2 — recherche de document. Suffisant si un document ressort
 * nettement : pertinence au seuil ET écart suffisant avec le suivant (ou seul).
 */
export function decideDocumentHit(
  hits: Array<{ score: number }>,
  thresholds: CascadeThresholdsLike,
): SufficiencyDecision {
  const threshold = thresholds.text;
  if (hits.length === 0) return { status: 'INSUFFICIENT', level: 2, score: 0, threshold, reason: 'NO_RESULT' };
  const sorted = [...hits].sort((a, b) => b.score - a.score);
  const [first, second] = sorted;
  if (threshold >= 1) {
    return { status: 'INSUFFICIENT', level: 2, score: first.score, threshold, reason: 'THRESHOLD_FORCES_ESCALATION' };
  }
  if (first.score < threshold) {
    return { status: 'INSUFFICIENT', level: 2, score: first.score, threshold, reason: 'LOW_RELEVANCE' };
  }
  if (second && first.score - second.score < 0.15) {
    return { status: 'INSUFFICIENT', level: 2, score: first.score, threshold, reason: 'AMBIGUOUS_TARGET', detail: `${sorted.length} documents proches` };
  }
  return { status: 'SUFFICIENT_RETRIEVAL', level: 2, score: first.score, threshold };
}

/** Borne un seuil venu de la configuration (valeur absente ou invalide → défaut). */
export function sanitizeThresholds(raw: Partial<CascadeThresholdsLike> | null | undefined): CascadeThresholdsLike {
  const pick = (v: unknown, d: number) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : d);
  return {
    database: pick(raw?.database, DEFAULT_THRESHOLDS.database),
    text: pick(raw?.text, DEFAULT_THRESHOLDS.text),
  };
}
