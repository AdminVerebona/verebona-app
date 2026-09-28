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
 * du français, plus l'enveloppe du prompt maître et le préambule BO) : un
 * dépassement réel est pire qu'une source de moins.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { RetrievedSource } from '../types/sources';

/** Enveloppe fixe : prompt maître generate_answer_v4 (~8 Ko) + préambule BO. */
export const PROMPT_OVERHEAD_TOKENS = 3000;
const CHARS_PER_TOKEN = 3.5;
const MIN_SOURCES = 2;
const MIN_EXCERPT = 300;

export function estimateTokens(text: string): number {
  return Math.ceil(String(text ?? '').length / CHARS_PER_TOKEN);
}

/** Coût d'une source sérialisée (<retrieved_source>, titre, contenu). */
function sourceTokens(s: RetrievedSource): number {
  return estimateTokens(s.title) + estimateTokens(s.content) + estimateTokens(s.id) * 2 + 20;
}

export interface FitInput {
  sources: RetrievedSource[];
  conversation: string;
  /** Question + consigne de tâche : jamais réduites. */
  fixed: string;
  maxInputTokens: number;
  maxExcerptChars: number;
}

export interface FitResult {
  ok: boolean;
  sources: RetrievedSource[];
  conversation: string;
  estimatedTokens: number;
  /** Réductions appliquées, pour la trace (§17.11). */
  events: string[];
}

export function fitToInputBudget(p: FitInput): FitResult {
  const events: string[] = [];
  const excerpt = Math.max(MIN_EXCERPT, p.maxExcerptChars);
  let sources = [...p.sources]
    .sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0))
    .map((s) => (s.content.length > excerpt ? { ...s, content: s.content.slice(0, excerpt) } : s));
  let conversation = p.conversation;
  const total = () => PROMPT_OVERHEAD_TOKENS + estimateTokens(p.fixed) + estimateTokens(conversation)
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
  if (estimatedTokens > p.maxInputTokens) {
    events.push(`CONTEXT:INPUT_TOKENS_EXCEEDED:${estimatedTokens}`);
    return { ok: false, sources, conversation, estimatedTokens, events };
  }
  return { ok: true, sources, conversation, estimatedTokens, events };
}
