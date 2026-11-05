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

type AnswerFormat = 'claims' | 'comparison' | 'timeline';

interface AnswerFormatRule {
  /** Format de sortie attendu du master T2 (branche ANSWER, T2-35). */
  format: AnswerFormat;
  /**
   * Phrases REPÈRES (étapes numérotées non comptées) ; `null` = liste.
   * Lot 111M : repère de concision tracé, plus une coupe de la réponse.
   */
  maxSentences: number | null;
  /** Longueur REPÈRE de la réponse rendue, en caractères (lot 111M : tracée, jamais coupée). */
  maxChars: number;
  /** Éléments repères d'une liste (chronologie, comparaison) ; `null` sinon. */
  maxItems: number | null;
}

/**
 * Lot 111M (ticket « budgets IA », §4 T2, CA-11) : la concision reste la
 * RÈGLE par défaut (question factuelle : 4 phrases, 1 200 caractères), mais
 * ces valeurs sont des REPÈRES : le validateur ne coupe plus une réponse
 * complète (une coupe retirait des affirmations étayées). Les synthèses et
 * comparaisons ont un repère adapté. La longueur réelle est bornée par le
 * plafond de sortie de la configuration IA (BO) et la limite du modèle.
 */
const DEFAULT_MAX_SENTENCES = 4;
const DEFAULT_MAX_ANSWER_CHARS = 1200;
/** Repère des synthèses, chronologies et comparaisons (longueur adaptée). */
const SYNTHESIS_MAX_ANSWER_CHARS = 3000;

const DEFAULT_RULE: AnswerFormatRule = {
  format: 'claims', maxSentences: DEFAULT_MAX_SENTENCES, maxChars: DEFAULT_MAX_ANSWER_CHARS, maxItems: null,
};

const RULES: Partial<Record<VerebonaIntent, AnswerFormatRule>> = {
  ACCOUNT_SUMMARY: { format: 'claims', maxSentences: null, maxChars: SYNTHESIS_MAX_ANSWER_CHARS, maxItems: null },
  ACCOUNT_TIMELINE: { format: 'timeline', maxSentences: null, maxChars: SYNTHESIS_MAX_ANSWER_CHARS, maxItems: 12 },
  ACCOUNT_COMPARISON: { format: 'comparison', maxSentences: null, maxChars: SYNTHESIS_MAX_ANSWER_CHARS, maxItems: 12 },
};

/** Règle de format/longueur de l'intention (défaut : 4 phrases, 1 200 caractères ; repères). */
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
