/**
 * Sérialisation d'un résultat de l'assistant pour l'API — CDC §27.1 / §27.2.
 *
 * Partagée par l'envoi d'un message et la réponse à une clarification : le
 * client reçoit la même forme dans les deux cas (réponse, sources, actions,
 * clarification éventuelle avec ses choix).
 */
import type { AssistantApiResponse, AssistantRunResult } from '../types/contracts';
import { isAssistantFlagOn } from '../config/assistant-flags.server';
import { createCommandFor } from '@/lib/verebona/assistant-actions';

export function toApiPayload(result: AssistantRunResult, conversationId?: number | null): AssistantApiResponse {
  const sourcesOn = isAssistantFlagOn('sources');
  return {
    requestId: result.requestId,
    messageId: result.messageId,
    conversationId: result.conversationId ?? conversationId ?? null,
    status: result.error ? 'error' : 'ready',
    intent: result.route?.intent ?? 'UNKNOWN',
    mode: result.mode,
    answer: result.answer,
    // Flag §39 `verebona_assistant_sources` coupé : aucune source exposée.
    sourcesAvailable: sourcesOn && result.sources.length > 0,
    sourceCount: sourcesOn ? result.sources.length : 0,
    // Cible et paramètres internes (§28.6) : persistés, jamais exposés.
    actions: (sourcesOn ? result.actions : result.actions.filter((a) => a.type !== 'SHOW_SOURCES'))
      .map(({ targetRef: _cible, payload: _parametres, ...publique }) => {
        // Lot 34G : une création porte sa commande, jamais un `href`.
        const command = createCommandFor(publique.type, _cible);
        return command ? { ...publique, href: null, command: publique.command ?? command } : publique;
      }),
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
    ...(result.resultGroups?.length ? { resultGroups: result.resultGroups } : {}),
    // CDC 15 T2-35 : chronologie structurée (date · libellé · lien), liens
    // résolus côté serveur ; identifiant interne de l'objet non exposé.
    ...(result.events?.length ? { events: result.events.map(({ date, text, href }) => ({ date, text, href })) } : {}),
    // §27.11 : `error {code, message, recoverable}` accompagne `status:
    // 'error'`, pour que le client affiche un message et « Réessayer » au
    // lieu d'une impasse (§4.2).
    ...(result.error ? { error: { ...result.error } } : {}),
    // §27.11 : codes informatifs, non bloquants (la réponse reste `ready`).
    ...(result.notices?.length ? { notices: result.notices.map((n) => ({ ...n })) } : {}),
  };
}
