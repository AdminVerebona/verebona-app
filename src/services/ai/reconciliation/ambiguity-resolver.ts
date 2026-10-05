/**
 * Arbitrage IA ciblé — CDC §4.2.8 étape 7, CDC 15 §25 (T3-06).
 *
 * « LLM uniquement lorsque la décision reste ambiguë. »
 *
 * Ce module n'est appelé que sur les décisions `request_ai_review`, c'est-à-dire
 * après épuisement des six étapes déterministes. Il reçoit les preuves déjà
 * extraites — jamais le document — conformément au §5.6.
 *
 * Lot 16b-3 (retrait de l'ancien moteur) : l'opération historique
 * `resolve_ambiguity` et son prompt sont SUPPRIMÉS. L'arbitrage passe toujours
 * par le prompt maître T3 (`t3_value_conflict`, TASK=VALUE_CONFLICT), sans
 * architecture `steps` ni drapeau. En cas d'échec du master (fournisseur
 * indisponible, sortie invalide), la décision devient un conflit : l'utilisateur
 * tranche, jamais une application automatique.
 */
import type { ReconciliationDecision, EvidenceCandidate } from './types';
import { resolveValueConflictMaster } from './master/value-conflict';

export interface ResolveAmbiguityInput {
  accountId: number;
  assetId: number;
  decision: ReconciliationDecision;
  candidates: EvidenceCandidate[];
  currentValue: unknown;
  currentOrigin: string;
}

/**
 * Renvoie une décision révisée par le master T3. En cas d'échec, d'abstention
 * ou de réponse incohérente, la décision devient un conflit.
 */
export async function resolveAmbiguity(
  input: ResolveAmbiguityInput,
): Promise<ReconciliationDecision> {
  return resolveValueConflictMaster(input);
}
