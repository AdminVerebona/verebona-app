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
 *   2. longueur : 4 phrases au plus avant cartes et actions (§21.2, CA-19),
 *      les étapes numérotées ne comptant pas ; chronologie et comparaison
 *      (listes) en sont exemptées mais restent sous 1 200 caractères ;
 *   3. une affirmation coupée par la limite sort aussi des citations, et le
 *      niveau d'étayage passe à « partial » (rien n'est caché).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { Claim, SupportLevel } from '../types/sources';

export const MAX_SENTENCES = 4;
export const MAX_ANSWER_CHARS = 1200;
const LIST_INTENTS = new Set(['ACCOUNT_TIMELINE', 'ACCOUNT_COMPARISON']);

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

export interface ValidatedAnswer {
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
  let answer = g.answer;
  let claims = g.claims;
  let supportLevel = g.supportLevel;

  if (!LIST_INTENTS.has(intent) && countSentences(answer) > MAX_SENTENCES) {
    violations.push('TOO_MANY_SENTENCES');
    // Coupe à la 4e phrase, en gardant les étapes numérotées qui précèdent.
    const out: string[] = [];
    let n = 0;
    for (const bloc of answer.split(/(?<=[.!?…])\s+/)) {
      const etape = /^\s*\d+[.)]\s/.test(bloc);
      if (!etape && n >= MAX_SENTENCES) break;
      out.push(bloc);
      if (!etape) n += 1;
    }
    answer = out.join(' ');
  }
  if (answer.length > MAX_ANSWER_CHARS) {
    violations.push('TOO_LONG');
    const coupe = answer.slice(0, MAX_ANSWER_CHARS);
    const fin = Math.max(coupe.lastIndexOf('. '), coupe.lastIndexOf('\n'));
    answer = fin > 200 ? coupe.slice(0, fin + 1) : `${coupe.trimEnd()}…`;
  }
  if (answer !== g.answer) {
    const gardees = claims.filter((c) => answer.includes(c.text.trim()));
    if (gardees.length < claims.length && supportLevel === 'supported') supportLevel = 'partial';
    claims = gardees;
    if (claims.length === 0) return null;
  }
  return { answer, claims, supportLevel, violations };
}
