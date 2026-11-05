/**
 * Validateur de la réponse rédigée — CDC §18.4, §18.5, §21.2, §21.7, CA-19, CA-27.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * BRANCHÉ, ET RÉÉCRIT POUR LA SORTIE RÉELLE
 *
 * L'ancien `validateModelOutput` travaillait sur un schéma
 * (`assistant-response-v1.0` complet : intent, actionIntents, clarification)
 * que le modèle ne produit plus — le prompt v3 ne demande que des claims.
 * Jamais appelé, il laissait croire à dix contrôles qui n'avaient pas lieu.
 *
 * Les contrôles « sources » (sourceIds ∈ sources fournies, texte reconstruit
 * des seules affirmations validées, actions du modèle ignorées) vivent dans
 * `generation.adapter.toGeneratedAnswer`. Ce module ajoute, APRÈS elle, ce
 * qui manquait :
 *   1. langue : la réponse est en français (§21.7, CA-27) — sinon repli ;
 *   1 bis. vocabulaire interdit (§21.5) — sinon repli ;
 *   2. longueur : règle UNIQUE par intention (`prompts/answer-format.ts`,
 *      T2-36) — repères de concision (4 phrases / 1 200 caractères par
 *      défaut, 3 000 pour une synthèse, une chronologie ou une comparaison).
 *      Lot 111M (ticket « budgets IA », CA-11) : un dépassement est TRACÉ
 *      (`SENTENCES_ABOVE_GUIDANCE`, `LENGTH_ABOVE_GUIDANCE`) mais la réponse
 *      n'est plus coupée — la coupe retirait des affirmations étayées et
 *      dégradait l'étayage d'une réponse complète.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { Claim, SupportLevel } from '../types/sources';
import { findForbiddenVocabulary } from './output-safety';
import { answerFormatFor } from '../prompts/answer-format';

const FR = new Set('le la les un une des du de et est sont pour dans sur avec votre vos vous ce cette ces il elle qui que au aux pas par en ne plus a été sera date montant document bien'.split(' '));
const EN = new Set('the and is are for with your you this that these of to in on it was be not by from have has will'.split(' '));

/**
 * Détection simple du français : ratio de mots-outils FR contre EN. Un texte
 * trop court (< 6 mots) n'est pas jugé — un montant ou un titre cité suffit.
 */
export function looksFrench(text: string): boolean {
  const mots = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z]+/g) ?? [];
  if (mots.length < 6) return true;
  let fr = 0; let en = 0;
  for (const m of mots) { if (FR.has(m)) fr += 1; if (EN.has(m)) en += 1; }
  return fr >= en;
}

/** Découpe en phrases ; une ligne d'étape numérotée n'en est pas une (§21.2). */
export function countSentences(text: string): number {
  return text.split('\n')
    .filter((l) => !/^\s*\d+[.)]\s/.test(l))
    .join(' ')
    .split(/(?<=[.!?…])\s+/)
    .filter((p) => p.trim().length > 0).length;
}

interface ValidatedAnswer {
  answer: string;
  claims: Claim[];
  supportLevel: SupportLevel;
  violations: string[];
}

/**
 * Rend la réponse validée, ou `null` si elle doit être écartée (repli
 * déterministe de l'orchestrateur, §30.3).
 */
export function validateGeneratedAnswer(
  g: { answer: string; claims: Claim[]; supportLevel: SupportLevel },
  intent: string,
): ValidatedAnswer | null {
  const violations: string[] = [];
  if (!looksFrench(g.answer)) {
    violations.push('LANGUAGE_NOT_FR');
    return null;
  }
  // §21.5 : vocabulaire interdit (« en tant qu'IA », « je garantis »…) —
  // réponse écartée (QUALITY_RULE : escalade permise, sinon repli).
  if (findForbiddenVocabulary(g.answer).length > 0) {
    violations.push('FORBIDDEN_VOCABULARY');
    return null;
  }
  const regle = answerFormatFor(intent);
  if (regle.maxSentences !== null && countSentences(g.answer) > regle.maxSentences) violations.push('SENTENCES_ABOVE_GUIDANCE');
  if (g.answer.length > regle.maxChars) violations.push('LENGTH_ABOVE_GUIDANCE');
  const { answer, claims, supportLevel } = g;
  return { answer, claims, supportLevel, violations };
}
