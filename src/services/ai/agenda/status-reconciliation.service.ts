/**
 * Réconciliation de statut (CDC 15 T4-12 à T4-14, D-04).
 *
 * Décision à quatre états (`decideCompletion`) ; un résultat `unknown` qui
 * le justifie passe par la branche VERIFY_COMPLETION du master T4 (échec du
 * modèle : décision déterministe conservée). Seul chemin depuis le lot
 * 16b-2 : l'ancien `decideStatus` (`AI_T4_EFFECTS=legacy`, T4 `steps`) est
 * retiré. Voir l'en-tête de `status-reconciler` pour la justification et la
 * correspondance avec `agenda_items.manual_status`.
 */
import type { ExistingAgendaItem } from './types';
import { decideCompletion, type CompletionDecision, type CompletionEvidence } from './status-reconciler';
import { verifyCompletionMaster } from './master/verify-completion';

export type StatusReconciliation = { engine: 'completion_v2' } & CompletionDecision;

export async function reconcileStatus(
  item: ExistingAgendaItem,
  evidence: CompletionEvidence | null,
  ctx: { accountId: number; userId?: number; sourceFileId?: number | null },
): Promise<StatusReconciliation> {
  let d = decideCompletion(item, evidence);
  if (d.needsModel && evidence && !item.manual) {
    d = await verifyCompletionMaster(item, evidence, d, ctx);
  }
  return { engine: 'completion_v2', ...d };
}
