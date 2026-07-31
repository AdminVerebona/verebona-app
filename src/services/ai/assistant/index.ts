/**
 * Usage IA n°3 — Assistant intelligent.
 *
 * Point d'entrée : `answerQuestion`. Enchaîne les six étapes du §4.3 :
 * éligibilité, sujets réservés, sélection d'outils, exécution, génération,
 * vérification des citations.
 */
// Module déplacé vers l'implémentation branchée — voir le commentaire en
// tête de `verebona-assistant/core/blocked-topics.ts`.
import { checkBlockedTopic } from '@/services/verebona-assistant/core/blocked-topics';
import { planTools } from './tool-planner.service';
import { executeTool, registerReadTools } from './tools/tool-registry';
import { composeAnswer } from './answer-composer.service';
import { ASSISTANT_LIMITS } from './tools/tool.port';
import type { SourceRef, ToolContext } from './tools/tool.port';
import type { AssistantResponse } from './answer-composer.service';

export interface AnswerQuestionInput {
  question: string;
  accountId: number;
  userId: number;
  /** Offre du compte — l'assistant est réservé à Premium, Duo, Pro et essai. */
  planCode: string;
}

/** Offres donnant accès aux réponses intelligentes — CDC-1 §2.1, CDC Assistant §6. */
const ELIGIBLE_PLANS = new Set(['premium', 'premium_duo', 'pro', 'trial']);

export async function answerQuestion(input: AnswerQuestionInput): Promise<AssistantResponse> {
  // ── 1. Éligibilité par offre ────────────────────────────────────────────
  if (!ELIGIBLE_PLANS.has(input.planCode.toLowerCase())) {
    return {
      status: 'blocked',
      text:
        "Les réponses en langage naturel sont incluses dans les offres Premium. " +
        "Votre offre actuelle donne accès à l'analyse automatique de vos documents, " +
        'au classement et aux échéances.',
      sources: [], droppedClaims: [],
    };
  }

  // ── 2. Sujets réservés ──────────────────────────────────────────────────
  const topic = checkBlockedTopic(input.question);
  if (topic.blocked) {
    return { status: 'blocked', text: topic.message!, sources: [], droppedClaims: [] };
  }

  // ── 3. Sélection d'outils (appel modèle n°1) ────────────────────────────
  const plan = await planTools(input.question, input.accountId, input.userId);
  if (plan.ambiguous) {
    return {
      status: 'ambiguous',
      text: plan.clarification
        ?? 'Pouvez-vous préciser votre question, par exemple en indiquant le bien concerné ?',
      sources: [], droppedClaims: [],
    };
  }

  // ── 4. Exécution des outils — aucun appel modèle ────────────────────────
  const ctx: ToolContext = {
    accountId: input.accountId,
    userId: input.userId,
    maxResults: ASSISTANT_LIMITS.maxSourcesRetrieved,
  };

  const collected: unknown[] = [];
  const sources: SourceRef[] = [];

  for (const call of plan.calls) {
    try {
      const result = await executeTool(call.name, call.params, ctx);
      collected.push({ tool: call.name, data: result.data });
      sources.push(...result.sources);
    } catch (e) {
      // Un outil en échec ne fait pas échouer la réponse : elle sera simplement
      // moins complète, et le sourçage empêchera d'affirmer sans preuve.
      console.warn(`[assistant] outil ${call.name} en échec :`, (e as Error).message);
    }
  }

  // ── 5 et 6. Génération puis vérification (appel modèle n°2) ─────────────
  return composeAnswer(
    input.question,
    collected,
    sources.slice(0, ASSISTANT_LIMITS.maxSourcesRetrieved),
    input.accountId,
    input.userId,
  );
}

export { registerReadTools } from './tools/tool-registry';
export { checkBlockedTopic } from '@/services/verebona-assistant/core/blocked-topics';
export { verifyClaims, composeVerifiedText } from './claim-verifier.service';
export { purgeAssistantData, RETENTION } from './retention/purge-assistant-logs.job';
export { ASSISTANT_LIMITS } from './tools/tool.port';
export type { AssistantResponse, AssistantStatus } from './answer-composer.service';
export type { SourceRef, ToolContext, AssistantTool } from './tools/tool.port';

/** À appeler une fois au démarrage, depuis `instrumentation.ts`. */
export function initAssistant(): void {
  registerReadTools();
}
