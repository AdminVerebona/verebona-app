/**
 * Usage IA n°2 — Réconciliation et enrichissement continu.
 * Point d'entrée unique : `reconcileAsset`.
 */
export { reconcileAsset } from './reconciliation-engine';

export { normalize } from './decision/normalizers';

import { onSourceAnalyzed, type SourceAnalyzedEvent } from '../source-analysis/events';
import { registerJobHandler } from '../queue/queue-worker';
import { enqueueT3ForAnalyzedAsset, registerT3SweepStarter, t3JobHandler } from './t3-queue';
import {
  registerDocumentAssetT3, requestDocumentAssetResolution, startDocumentSweep, t1CandidatesOf,
} from './document-asset/queue';
import { registerDocumentTitleT3 } from './document-title-sweep';
import {
  onDocumentAnalyzedForOperations, registerBusinessOperationsT3, startOperationsSweep,
} from '@/services/business-operations/consolidation/queue';
import { registerOperationAgendaProjection } from '@/services/business-operations/agenda-projection/queue';
import { registerSourceUnitProviders } from './document-asset/source-unit-provider';
import { registerEquipmentDocumentsT3 } from '@/services/equipment/equipment-document-queue';
import { registerAttachmentReviewT3 } from './document-asset/attachment-review/service';

export { resolveDocumentAsset } from './document-asset/resolve-document-asset.service';
export { requestDocumentAssetResolution } from './document-asset/queue';

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
  // Lot 113L — revue IA du rattachement d'un document déjà rattaché (indices → T3).
  registerAttachmentReviewT3();
  // Lot 49B — couche exhaustive T1 (unités source, faits non résolus) comme
  // sources documentaires de T3 DOCUMENT_ASSET (base seulement, jamais le fichier).
  registerSourceUnitProviders();
  registerT3SweepStarter('document_asset', ({ cycleId, triggerCode, guard }) => startDocumentSweep({ cycleId, triggerCode, guard }));
  // Lot 33C — rattrapage des titres non conformes. Lot 87D (C-Q9) : le
  // balayage horaire paginé des titres est RETIRÉ — la reprise du stock passe
  // par le contrôle de cohérence COH-DOC-TITLES (campagne quotidienne et
  // contrôles ciblés), par le même service de nommage. La sorte de travail
  // reste enregistrée pour clore sans effet une page déjà en file.
  registerDocumentTitleT3();
  // Lot 41 (CDC Opérations V1 C4, O3a) — consolidation T3 DÉTERMINISTE des
  // candidats T1 en Opérations : sorte `business_operations` (un travail par
  // compte, sérialisé par le verrou du compte) et balayage horaire des seuls
  // comptes qui ont quelque chose à consolider. Aucun appel IA.
  registerBusinessOperationsT3();
  registerT3SweepStarter('business_operations', ({ cycleId, triggerCode, guard }) => startOperationsSweep({ cycleId, triggerCode, guard }));
  // Lot 46 (CDC Opérations V1 C16, O7) — T4 / Agenda : projection des
  // Opérations, abonnée au bus Opérations (après commit), un travail par
  // compte. Lot 83E (C-Q9) : le balayage horaire de convergence (événement
  // perdu) est RETIRÉ — la convergence est vérifiée et réparée par le contrôle
  // de cohérence COH-AGENDA-OPERATION-PROJECTION / -ORPHANS (même moteur).
  registerOperationAgendaProjection();
  // Lot 75G — rapprochement DURABLE des documents d'un équipement créé ou
  // modifié (nom, bien, marque, modèle, n° de série) : sorte `equipment_documents`.
  registerEquipmentDocumentsT3();
  onSourceAnalyzed('opérations', async (e) => {
    await onDocumentAnalyzedForOperations(e.accountId, e.leadSourceId);
  });

  // Lot 16b-3 : plus de drapeau (`AI_RECONCILIATION_ENGINE` supprimé).
  onSourceAnalyzed('réconciliation', async (e) => {
    // Lot 32C (PO 8 / PO 10) : document rattaché à A dont l'analyse cite B —
    // lot 113L : indices soumis à la revue IA (T3), qui décide d'un arbitrage ;
    // jamais de déplacement automatique, jamais de carte déterministe.
    await syncAssetConflictFromAnalysis(e);
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

/**
 * Revue du rattachement après une analyse T1 (lot 113L, ticket #711 —
 * remplace la carte LINK-ASSET-CONFLICT ouverte directement depuis
 * l'avertissement `ASSET_TARGET_CONTRADICTION`). Document rattaché
 * (`e.assetId`) dont l'analyse cite des éléments d'un autre bien
 * (`ASSET_ATTACHMENT_INDICES`), ou porteur d'une carte encore ouverte : les
 * indices sont soumis à T3 (file durable, `attachment-review`), qui décide.
 * Aucune carte n'est créée ni fermée ici. Ne lève jamais.
 */
export async function syncAssetConflictFromAnalysis(e: Pick<SourceAnalyzedEvent, 'accountId' | 'assetId' | 'leadSourceId' | 'result' | 'userId'>): Promise<void> {
  try {
    if (!e.assetId) return;
    const w = e.result.warnings.find((x) => x.code === 'ASSET_ATTACHMENT_INDICES' && x.attachmentIndices);
    const { pgClient } = await import('@/db');
    const ouverte = w ? [] : (await pgClient.unsafe(
      `SELECT 1 FROM to_process_actions WHERE account_id = $1 AND target_type = 'DOCUMENT' AND target_id = $2
          AND rule_code = 'LINK-ASSET-CONFLICT' AND resolved_at IS NULL LIMIT 1`,
      [e.accountId, e.leadSourceId] as never[],
    )) as unknown as unknown[];
    if (!w && ouverte.length === 0) return;
    const { requestAttachmentReview } = await import('./document-asset/attachment-review/service');
    await requestAttachmentReview({
      accountId: e.accountId, fileId: e.leadSourceId, userId: e.userId ?? null, triggerCode: 'source_analyzed', reprocessReason: 'NEW_ANALYSIS',
      t1Candidates: w?.attachmentIndices?.modelCandidates ?? [],
    });
  } catch (err) {
    console.error(`[réconciliation] revue du rattachement du document ${e.leadSourceId} non demandée :`, (err as Error).message);
  }
}
