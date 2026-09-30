/**
 * Réconciliation de statut — aiguillage (CDC 15 T4-12 à T4-14, D-04).
 *
 *   · `AI_T4_EFFECTS=enabled` OU architecture T4 `master` : décision à quatre
 *     états (`decideCompletion`) ; en `master`, un résultat `unknown` qui le
 *     justifie passe par la branche VERIFY_COMPLETION du master ;
 *   · sinon : `decideStatus` historique, strictement inchangé.
 * Voir l'en-tête de `status-reconciler` pour la justification et la
 * correspondance avec `agenda_items.manual_status`.
 */
import { t4EffectsMode, type RolloutMode } from '@/services/canonical/rollout';
import { getPromptArchitecture } from '../config/config-resolver';
import type { PromptArchitecture } from '../config/config-types';
import type { ExistingAgendaItem } from './types';
import {
  decideStatus, decideCompletion, type CompletionDecision, type CompletionEvidence,
} from './status-reconciler';
import { verifyCompletionMaster } from './master/verify-completion';

export type StatusReconciliation =
  | ({ engine: 'completion_v2' } & CompletionDecision)
  | { engine: 'legacy'; decision: ReturnType<typeof decideStatus>['decision']; reason: string };

export async function reconcileStatus(
  item: ExistingAgendaItem,
  evidence: CompletionEvidence | null,
  ctx: { accountId: number; userId?: number; sourceFileId?: number | null; mode?: RolloutMode; architecture?: PromptArchitecture },
): Promise<StatusReconciliation> {
  const mode = ctx.mode ?? t4EffectsMode();
  const architecture = ctx.architecture ?? await getPromptArchitecture('T4');
  if (mode !== 'enabled' && architecture !== 'master') {
    return { engine: 'legacy', ...decideStatus(item, evidence) };
  }
  let d = decideCompletion(item, evidence);
  if (d.needsModel && architecture === 'master' && evidence && !item.manual) {
    d = await verifyCompletionMaster(item, evidence, d, ctx);
  }
  return { engine: 'completion_v2', ...d };
}
