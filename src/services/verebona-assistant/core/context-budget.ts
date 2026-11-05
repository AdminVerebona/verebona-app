/**
 * Budget de contexte AVANT l'appel modèle — CDC §13.9, §17.7, §31.2, §43.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * `maxInputTokens` N'ÉTAIT LU NULLE PART
 *
 * Rien ne vérifiait les 12 000 jetons d'entrée avant d'appeler le modèle :
 * huit extraits de 1 500 caractères, le fil et la consigne partaient tels
 * quels. Stratégie de réduction (§17.7 « moins d'extraits, puis extraits plus
 * courts ») :
 *   1. extraits bornés à `maxExcerptChars` ;
 *   2. retirer les sources les moins pertinentes (on en garde au moins 2) ;
 *   3. raccourcir les extraits restants (jusqu'à 300 caractères) ;
 *   4. retirer le contexte du fil ;
 *   5. toujours trop long → AUCUN appel (repli déterministe).
 *
 * L'estimation est volontairement PRUDENTE (≈ 3,5 caractères par jeton pour
 * du français, `budget-resolution.estimateTokens`, commune à tous les
 * traitements) : un dépassement réel est pire qu'une source de moins.
 *
 * Lot 111M (ticket « budgets IA ») : la réserve FORFAITAIRE de 3 000 jetons
 * pour le prompt est remplacée par la taille ESTIMÉE DU PROMPT MAÎTRE ACTIF
 * (`promptOverheadTokens`, version BO ou fichier du dépôt) ; la réserve
 * forfaitaire ne sert plus que de repli quand le texte actif est illisible
 * (origine `fallback`, tracée). Le résultat dit si le contexte a été RÉDUIT
 * (`reduced`) : une réponse « information insuffisante » sur un contexte
 * réduit n'est jamais présentée comme une absence (`generation.adapter`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { RetrievedSource } from '../types/sources';
import { estimateTokens as estimer } from '@/services/ai/gateway/budget-resolution';

/** Repli seulement : enveloppe du prompt maître t2_master_v1 (~8 Ko) quand le texte actif est illisible. */
export const FALLBACK_PROMPT_OVERHEAD_TOKENS = 3000;
const MIN_SOURCES = 2;
const MIN_EXCERPT = 300;

function estimateTokens(text: string): number {
  return estimer(String(text ?? ''));
}

/** Coût d'une source sérialisée (<retrieved_source>, titre, contenu). */
function sourceTokens(s: RetrievedSource): number {
  return estimateTokens(s.title) + estimateTokens(s.content) + estimateTokens(s.id) * 2 + 20;
}

interface FitInput {
  sources: RetrievedSource[];
  conversation: string;
  /** Question + consigne de tâche : jamais réduites. */
  fixed: string;
  maxInputTokens: number;
  maxExcerptChars: number;
  /** Lot 111M : jetons estimés du prompt maître ACTIF (consignes + contrat) ; absent : repli forfaitaire. */
  promptOverheadTokens?: number | null;
}

interface FitResult {
  ok: boolean;
  sources: RetrievedSource[];
  conversation: string;
  estimatedTokens: number;
  /** Réductions appliquées, pour la trace (§17.11). */
  events: string[];
  /** Lot 111M : sources retirées ou extraits raccourcis (contexte incomplet). */
  reduced: boolean;
}

export function fitToInputBudget(p: FitInput): FitResult {
  const events: string[] = [];
  const mesure = typeof p.promptOverheadTokens === 'number' && p.promptOverheadTokens > 0;
  const enveloppe = mesure ? Math.ceil(p.promptOverheadTokens!) : FALLBACK_PROMPT_OVERHEAD_TOKENS;
  events.push(`CONTEXT:PROMPT_TOKENS:${enveloppe}:${mesure ? 'active_prompt' : 'fallback'}`);
  const excerpt = Math.max(MIN_EXCERPT, p.maxExcerptChars);
  const coupesLecture = p.sources.filter((s) => s.content.length > excerpt).length;
  if (coupesLecture) events.push(`CONTEXT:EXCERPTS_READ_BOUND:${coupesLecture}`);
  let sources = [...p.sources]
    .sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0))
    .map((s) => (s.content.length > excerpt ? { ...s, content: s.content.slice(0, excerpt) } : s));
  let conversation = p.conversation;
  const total = () => enveloppe + estimateTokens(p.fixed) + estimateTokens(conversation)
    + sources.reduce((n, s) => n + sourceTokens(s), 0);

  // 2. Moins d'extraits.
  let retirees = 0;
  while (total() > p.maxInputTokens && sources.length > MIN_SOURCES) {
    sources = sources.slice(0, -1);
    retirees += 1;
  }
  if (retirees) events.push(`CONTEXT:SOURCES_DROPPED:${retirees}`);

  // 3. Extraits plus courts.
  let longueur = excerpt;
  while (total() > p.maxInputTokens && longueur > MIN_EXCERPT) {
    longueur = Math.max(MIN_EXCERPT, Math.floor(longueur / 2));
    sources = sources.map((s) => (s.content.length > longueur ? { ...s, content: s.content.slice(0, longueur) } : s));
    if (!events.includes('CONTEXT:EXCERPTS_SHORTENED')) events.push('CONTEXT:EXCERPTS_SHORTENED');
  }

  // 4. Sans le contexte du fil.
  if (total() > p.maxInputTokens && conversation.length > 0) {
    conversation = '(contexte de la conversation omis pour respecter la limite de taille)';
    events.push('CONTEXT:CONVERSATION_DROPPED');
  }

  const estimatedTokens = total();
  const reduced = retirees > 0 || events.includes('CONTEXT:EXCERPTS_SHORTENED') || coupesLecture > 0;
  if (estimatedTokens > p.maxInputTokens) {
    events.push(`CONTEXT:INPUT_TOKENS_EXCEEDED:${estimatedTokens}`);
    return { ok: false, sources, conversation, estimatedTokens, events, reduced };
  }
  return { ok: true, sources, conversation, estimatedTokens, events, reduced };
}
