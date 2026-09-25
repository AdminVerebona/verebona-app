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
 *   - valeurs incompatibles                      → CONFLICTING (jamais de choix) ;
 *   - demande de synthèse / explication          → INSUFFICIENT (motif SYNTHESIS_REQUIRED).
 * ══════════════════════════════════════════════════════════════════════════
 */

export type SufficiencyStatus =
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
  | 'THRESHOLD_FORCES_ESCALATION';

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

export const CONFIDENCE_SCORE: Record<string, number> = {
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

export interface FactCandidate {
  /** Valeur comparable (nombre + unité normalisés, ou texte normalisé). */
  comparable: string;
  confidence: string;
  matchedTerms: number;
  sourceKey: string;
}

/**
 * Niveau 2 — faits T1. Regroupe par valeur comparable :
 *   - une seule valeur → score de confiance, renforcé par la concordance ;
 *   - plusieurs valeurs de même pertinence → conflit.
 */
export function decideFacts(
  candidates: FactCandidate[],
  queryTermCount: number,
  thresholds: CascadeThresholdsLike,
): SufficiencyDecision & { retained?: string } {
  const threshold = thresholds.text;
  if (candidates.length === 0) {
    return { status: 'INSUFFICIENT', level: 2, score: 0, threshold, reason: 'NO_RESULT' };
  }
  const best = Math.max(...candidates.map((c) => c.matchedTerms));
  const top = candidates.filter((c) => c.matchedTerms === best);
  const groups = new Map<string, FactCandidate[]>();
  for (const c of top) groups.set(c.comparable, [...(groups.get(c.comparable) ?? []), c]);

  const matchRatio = queryTermCount > 0 ? Math.min(1, best / queryTermCount) : 1;

  if (groups.size > 1) {
    return {
      status: 'CONFLICTING', level: 2, score: matchRatio, threshold, reason: 'CONFLICTING_VALUES',
      detail: `${groups.size} valeurs distinctes`,
    };
  }

  const [[retained, group]] = [...groups];
  const base = Math.max(...group.map((c) => CONFIDENCE_SCORE[c.confidence] ?? 0.3));
  const sources = new Set(group.map((c) => c.sourceKey)).size;
  const score = Math.min(1, (base + 0.05 * (sources - 1)) * matchRatio);

  if (threshold >= 1) {
    return { status: 'INSUFFICIENT', level: 2, score, threshold, reason: 'THRESHOLD_FORCES_ESCALATION' };
  }
  if (score < threshold) {
    return {
      status: 'INSUFFICIENT', level: 2, score, threshold,
      reason: matchRatio < 1 ? 'LOW_RELEVANCE' : 'LOW_CONFIDENCE',
    };
  }
  return { status: 'SUFFICIENT_RETRIEVAL', level: 2, score, threshold, retained, detail: `${sources} source(s) concordante(s)` };
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
