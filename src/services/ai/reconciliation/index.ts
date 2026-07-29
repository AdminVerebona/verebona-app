/**
 * Usage IA n°2 — Réconciliation et enrichissement continu.
 * Point d'entrée unique : `reconcileAsset`.
 */
export { reconcileAsset } from './reconciliation-engine';
export type { ReconcileInput } from './reconciliation-engine';

export { decide } from './decision/decision-matrix';
export { resolveAuthority, getAuthorityMatrix, AUTHORITY_MATRIX_VERSION } from './decision/authority-matrix';
export { isCriticalField, checkCriticalGate, CRITICAL_FIELDS } from './decision/critical-fields';
export { normalize, areEquivalent } from './decision/normalizers';
export { REASON_CODES, reasonLabel } from './decision/reason-codes';
export { readOrigin, writeOrigin, isHumanOrigin } from './field-origin';
export { writeConflict, resolveObsoleteConflict } from './conflict-writer';
export { getShadowReport, summarizeShadowDecisions } from './shadow-report.service';
export { listOpenReconciliationConflicts, fieldLabel } from './to-process-conflicts';
export { reconcileLinks, retainAbove, ReconcileLinksOutput, LINK_SCORE_THRESHOLDS } from './link-reconciler';
export type { ShadowReport, ShadowSummary, ShadowDecisionRow } from './shadow-report.service';

export type {
  ReconciliationAction, ReconciliationDecision, ReconciliationRun,
  DecisionInput, EvidenceCandidate, CurrentValue,
} from './types';

import { onSourceAnalyzed } from '../source-analysis/events';
import { reconcileAsset } from './reconciliation-engine';

/**
 * Abonnement à l'analyse — étape 13 du §4.1.4.
 * À appeler une fois au démarrage, depuis `instrumentation.ts`.
 */
export function registerReconciliationHandlers(): void {
  onSourceAnalyzed(async (e) => {
    if (!e.assetId) return;
    await reconcileAsset({
      accountId: e.accountId,
      userId: e.userId,
      assetId: e.assetId,
      triggeredBy: 'document_analyzed',
      sourceFileId: e.leadSourceId,
    });
  });
}
