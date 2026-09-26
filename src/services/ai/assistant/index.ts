/**
 * Usage IA n°3 — Assistant intelligent : briques partagées.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * NETTOYAGE (audit assistant, « answer-composer.service.ts aligné ou supprimé »)
 *
 * `answerQuestion` → `tool-planner.service` → `answer-composer.service`
 * formaient une seconde conception de l'assistant (par outils), sans aucun
 * appelant. Pire : `composeAnswer` appelait l'opération `generate_answer`
 * avec des variables qui ne sont plus celles du prompt v3 (ni INTENT ni
 * CONVERSATION, sources en `[id:n]` hors balises <retrieved_source>) et des
 * `sourceIds` numériques. La réactiver par erreur aurait contourné le
 * budget d'appels (§15.5), la trace (§28.8) et l'enveloppe anti-injection
 * (§17.4). Supprimés : le seul chemin vivant est
 * `services/verebona-assistant` (route POST /api/verebona/messages).
 *
 * Restent ici les briques réellement utilisées : outils de lecture
 * (enregistrés au démarrage par `instrumentation.ts`), vérification des
 * citations, purge des journaux (cron).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { registerReadTools } from './tools/tool-registry';

export { registerReadTools };
export { checkBlockedTopic } from '@/services/verebona-assistant/core/blocked-topics';
export { verifyClaims, composeVerifiedText } from './claim-verifier.service';
export { purgeAssistantData, RETENTION } from './retention/purge-assistant-logs.job';
export { ASSISTANT_LIMITS } from './tools/tool.port';
export type { SourceRef, ToolContext, AssistantTool } from './tools/tool.port';

/** À appeler une fois au démarrage, depuis `instrumentation.ts`. */
export function initAssistant(): void {
  registerReadTools();
}
