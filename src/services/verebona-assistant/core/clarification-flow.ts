/**
 * Suite donnée à une réponse de clarification — partagée par la route de
 * réponse (choix cliqué) et l'envoi de message (réponse tapée).
 *
 *   · resume    → la demande initiale est reprise, choix injecté (§20.5) ;
 *   · reask     → la même question est reposée, sans relancer le pipeline ;
 *   · fallback  → plus de boucle : message de repli + actions de navigation ;
 *   · rejected  → refus sans reprise (expirée, introuvable) ;
 *   · abandoned → l'utilisateur a posé une autre question : l'appelant la
 *                 traite normalement.
 */
import { randomUUID } from 'crypto';
import type { AssistantRequestInput, AssistantRunResult } from '../types/contracts';
import type { OrchestratorPorts } from './assistant-orchestrator.service';
import { inputDeReprise, traceClarification, type IssueClarification } from './clarification.service';
import { routeForIntent } from './intent-router.service';

export type SuiteClarification =
  | { kind: 'result'; result: AssistantRunResult }
  | { kind: 'rejected'; code: 'CLARIFICATION_EXPIRED' | 'CLARIFICATION_REJECTED'; message: string }
  | { kind: 'abandoned' };

export async function executerIssueClarification(
  issue: IssueClarification,
  base: Pick<AssistantRequestInput, 'accountId' | 'userId' | 'planType' | 'locale'> & {
    /** Texte tapé par l'utilisateur, s'il y en a un (historique). */
    typedText?: string;
  },
  deps: {
    runAssistant: (input: AssistantRequestInput, ports: OrchestratorPorts) => Promise<AssistantRunResult>;
    ports: OrchestratorPorts;
  },
): Promise<SuiteClarification> {
  if (issue.kind === 'abandoned') return { kind: 'abandoned' };
  if (issue.kind === 'rejected') {
    return {
      kind: 'rejected',
      code: issue.motif === 'EXPIREE' ? 'CLARIFICATION_EXPIRED' : 'CLARIFICATION_REJECTED',
      message: issue.message,
    };
  }

  if (issue.kind === 'resume') {
    const input = inputDeReprise(base, issue.etat, issue.candidate);
    const result = await deps.runAssistant(input, deps.ports);
    await traceClarification(issue.etat, result.error ? 'RESUME_FAILED' : 'RESUME_SUCCEEDED', {
      assetId: input.resume?.assetId ?? null,
      intent: input.resume?.intent,
      finalState: result.finalState,
      nextClarification: result.clarification?.clarificationId ?? null,
    });
    return { kind: 'result', result };
  }

  // Question reposée ou repli : réponse sans nouveau traitement, enregistrée
  // dans le fil de la clarification.
  const route = routeForIntent(
    issue.kind === 'fallback' ? 'ACCOUNT_SEARCH_ASSET' : issue.etat.originalIntent,
    base.planType,
    issue.kind === 'fallback' ? 'repli après clarification' : 'clarification reposée',
  );
  const input: AssistantRequestInput = {
    ...base,
    message: base.typedText ?? 'Choix',
    clientRequestId: `clarif:${issue.etat.clarificationId}:${randomUUID()}`,
    conversationId: issue.etat.conversationId,
  };
  const actions = issue.kind === 'fallback' ? await deps.ports.resolveActions(route, input, []).catch(() => []) : [];
  const result: AssistantRunResult = {
    requestId: randomUUID(),
    messageId: randomUUID(),
    finalState: issue.kind === 'fallback' ? 'READY' : 'CLARIFYING',
    mode: 'deterministic',
    route,
    answer: issue.message,
    supportLevel: null,
    claims: [],
    sources: [],
    actions,
    clarification: issue.kind === 'reask' ? issue.etat : null,
  };
  try {
    const ids = await deps.ports.persist(result, input);
    if (ids) { result.messageId = String(ids.messageId); result.conversationId = ids.conversationId; }
  } catch { /* la réponse reste rendue */ }
  return { kind: 'result', result };
}
