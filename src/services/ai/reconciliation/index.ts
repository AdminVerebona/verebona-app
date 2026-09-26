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
import { registerJobHandler } from '../queue/queue-worker';
import { enqueueT3ForAnalyzedAsset, t3JobHandler } from './t3-queue';

/**
 * Abonnement à l'analyse — étape 13 du §4.1.4 — et exécutant T3 de la file.
 * À appeler une fois au démarrage, depuis `instrumentation.ts`, avant
 * `startQueueWorker` (c'est le cas : étape 5, boucleur à l'étape 6).
 *
 * CDC BO IA OPS-001, NFR-003, WF-06 : l'abonné ne réconcilie plus EN LIGNE ;
 * il met un travail T3 en file durable (déclencheur `source_analyzed`,
 * soumis à la version effective). Un redémarrage ne perd plus la
 * réconciliation, et désactivation, arrêt d'urgence et rollback s'y
 * appliquent comme à T1.
 */
export function registerReconciliationHandlers(): void {
  registerJobHandler('T3', t3JobHandler);

  // Le drapeau est déclaré ici : l'émetteur n'exécute cet abonné que si
  // `AI_RECONCILIATION_ENGINE` l'autorise, indépendamment des autres usages.
  onSourceAnalyzed('AI_RECONCILIATION_ENGINE', async (e) => {
    if (!e.assetId) return;
    await enqueueT3ForAnalyzedAsset({
      accountId: e.accountId,
      userId: e.userId,
      assetId: e.assetId,
      leadSourceId: e.leadSourceId,
    });
  });
}
