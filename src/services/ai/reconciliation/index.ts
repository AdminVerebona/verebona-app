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
export { listOpenReconciliationConflicts, fieldLabel } from './to-process-conflicts';
export { reconcileLinks, retainAbove, LINK_SCORE_THRESHOLDS } from './link-reconciler';

export type {
  ReconciliationAction, ReconciliationDecision, ReconciliationRun,
  DecisionInput, EvidenceCandidate, CurrentValue,
} from './types';

import { onSourceAnalyzed } from '../source-analysis/events';
import { registerJobHandler } from '../queue/queue-worker';
import { enqueueT3ForAnalyzedAsset, registerT3SweepStarter, t3JobHandler } from './t3-queue';
import {
  registerDocumentAssetT3, requestDocumentAssetResolution, startDocumentSweep, t1CandidatesOf,
} from './document-asset/queue';

export { resolveDocumentAsset } from './document-asset/resolve-document-asset.service';
export { requestDocumentAssetResolution, T3_TARGET_DOCUMENT } from './document-asset/queue';

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
  // Lot 31B — T3 DOCUMENT_ASSET au contrat de file 31C : sortes de travail
  // `document_asset` / `document_asset_sweep` (registre `t3-job-contract`,
  // exécutées par `runT3Job`) et rattrapage des documents sans bien
  // principal ouvert par la racine du balayage planifié (pages bornées).
  registerDocumentAssetT3();
  registerT3SweepStarter('document_asset', ({ cycleId, triggerCode, guard }) => startDocumentSweep({ cycleId, triggerCode, guard }));

  // Lot 16b-3 : plus de drapeau (`AI_RECONCILIATION_ENGINE` supprimé).
  onSourceAnalyzed('réconciliation', async (e) => {
    if (!e.assetId) {
      // Lot 31B (ticket T3, §3) : T1 terminé SANS bien principal certain →
      // T3 DOCUMENT_ASSET immédiatement, avec les candidats et preuves de T1.
      await requestDocumentAssetResolution({
        accountId: e.accountId, userId: e.userId, fileId: e.leadSourceId,
        t1Candidates: t1CandidatesOf(e.result), triggerCode: 'source_analyzed',
      });
      return;
    }
    await enqueueT3ForAnalyzedAsset({
      accountId: e.accountId,
      userId: e.userId,
      assetId: e.assetId,
      leadSourceId: e.leadSourceId,
    });
  });
}
