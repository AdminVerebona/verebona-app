/**
 * Sérialisation d'un résultat de l'assistant pour l'API — CDC §27.1 / §27.2.
 *
 * Partagée par l'envoi d'un message et la réponse à une clarification : le
 * client reçoit la même forme dans les deux cas (réponse, sources, actions,
 * clarification éventuelle avec ses choix).
 */
import type { AssistantApiResponse, AssistantRunResult } from '../types/contracts';

export function toApiPayload(result: AssistantRunResult, conversationId?: number | null): AssistantApiResponse {
  return {
    requestId: result.requestId,
    messageId: result.messageId,
    conversationId: result.conversationId ?? conversationId ?? null,
    status: result.error ? 'error' : 'ready',
    intent: result.route?.intent ?? 'UNKNOWN',
    mode: result.mode,
    answer: result.answer,
    sourcesAvailable: result.sources.length > 0,
    sourceCount: result.sources.length,
    actions: result.actions,
    clarification: result.clarification
      ? {
          clarificationId: result.clarification.clarificationId,
          question: result.clarification.question,
          expiresAt: result.clarification.expiresAt,
          // Seuls l'identifiant de choix et les libellés sortent : l'état
          // interne (demande initiale, contexte) reste côté serveur.
          choices: result.clarification.candidates.map((c) => ({
            choiceId: c.id, label: c.label, secondaryLabel: c.secondaryLabel,
          })),
        }
      : null,
    commandPlan: result.commandPlan ?? null,
  };
}
