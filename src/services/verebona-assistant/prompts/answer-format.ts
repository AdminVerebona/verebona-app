/**
 * Format et longueur de la réponse, PAR INTENTION — CDC 15 T2-36.
 *
 * Source UNIQUE des règles de longueur de l'assistant :
 *   · le validateur serveur (`response-validator.service`) les applique ;
 *   · les consignes par intention du chemin historique (`account-*.ts`,
 *     `product-help.ts`) en tirent leur phrase de longueur (`lengthRuleText`) ;
 *   · le master T2 (§24, U7 « adapte la longueur à l'intention ») ne reçoit
 *     QUE le code d'intention dans {{INTENT}} — aucune règle en langue
 *     naturelle concaténée —, la longueur est imposée ici, côté serveur.
 *
 * Avant : « Quatre phrases au maximum » (R8 du prompt v4) coexistait avec
 * « Tu n'es pas tenu par la limite de 4 phrases » (chronologie) et une liste
 * d'exemptions codée en dur dans le validateur.
 */
import type { VerebonaIntent } from '../types/intents';

export type AnswerFormat = 'claims' | 'comparison' | 'timeline';

export interface AnswerFormatRule {
  /** Format de sortie attendu du master T2 (branche ANSWER, T2-35). */
  format: AnswerFormat;
  /** Phrases au plus (étapes numérotées non comptées) ; `null` = liste, non bornée en phrases. */
  maxSentences: number | null;
  /** Longueur maximale de la réponse rendue, en caractères. */
  maxChars: number;
  /** Éléments au plus d'une liste (chronologie, comparaison) ; `null` sinon. */
  maxItems: number | null;
}

export const DEFAULT_MAX_SENTENCES = 4;
export const DEFAULT_MAX_ANSWER_CHARS = 1200;

const DEFAULT_RULE: AnswerFormatRule = {
  format: 'claims', maxSentences: DEFAULT_MAX_SENTENCES, maxChars: DEFAULT_MAX_ANSWER_CHARS, maxItems: null,
};

const RULES: Partial<Record<VerebonaIntent, AnswerFormatRule>> = {
  ACCOUNT_TIMELINE: { format: 'timeline', maxSentences: null, maxChars: DEFAULT_MAX_ANSWER_CHARS, maxItems: 12 },
  ACCOUNT_COMPARISON: { format: 'comparison', maxSentences: null, maxChars: DEFAULT_MAX_ANSWER_CHARS, maxItems: 12 },
};

/** Règle de format/longueur de l'intention (défaut : 4 phrases, 1 200 caractères). */
export function answerFormatFor(intent: string): AnswerFormatRule {
  return RULES[intent as VerebonaIntent] ?? DEFAULT_RULE;
}

/** Phrase de longueur des consignes historiques, tirée de la règle (jamais écrite en dur). */
export function lengthRuleText(intent: string): string {
  const r = answerFormatFor(intent);
  if (r.maxSentences !== null) return `Tu réponds en ${r.maxSentences} phrases maximum.`;
  return `La réponse entière reste sous ${r.maxChars} caractères`
    + (r.maxItems ? ` et compte au plus ${r.maxItems} éléments.` : '.');
}
