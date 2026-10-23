/**
 * Exécution d'un rattrapage par son SERVICE (lot 25, chantier B) — aucun
 * processus enfant : le paquet de production n'a ni `tsx` ni les
 * devDependencies. Les scripts CLI appellent exactement les mêmes services
 * (`scripts/*.ts`), avec les mêmes options par défaut :
 *
 *   merge-rooms           runRoomsMerge / restoreRoomsMerge / summarizeRoomsMerge
 *   document-asset-links  backfillDocumentAssetLinks (lot 500, pause 50 ms)
 *   agenda                backfillAgendaSourceLinks (lot 500) / dedupeAutomaticAgendaItems
 *   cdc15                 runCdc15Backfill(--step all, lot 200, pause 50 ms) / restoreCdc15Run / summarizeRun
 *   asset-account         runAssetAccountBackfill (lot 500 ; simulation = transactions annulées)
 *   operations-structured runStructuredOperationsMigration (lot 43 ; simulation = transactions annulées)
 *   claims-legacy-cleanup runClaimLegacyCleanup / restoreClaimLegacyCleanup (lot 83D ; simulation =
 *                         lecture seule ; application refusée sans point de restauration < 24 h ;
 *                         journal 0672)
 *   cross-account         runCrossAccountRemediation / restoreCrossAccountRemediation (lot 53, D23 ;
 *                         simulation = transaction annulée par catégorie)
 *   equipment-separation  runDataSeparationBackfill (lot 71A ; simulation = lecture seule)
 *   document-validation   runValidationReprise (lot 71B ; simulation = lecture seule)
 *   duo-shared-account    runDuoSharedAccountBackfill / restoreDuoSharedAccountRun (lot 72D ;
 *                         simulation = lecture seule ; journal 0521)
 *   agenda-intervention-duplicates  runAgendaDuplicatesReprise / restoreAgendaDuplicatesReprise
 *                         (lot 76H ; simulation = plans de projection sans écriture ; journal 0591)
 *   to-process-false-arbitrations  runArbitrationReprise (lot 81A ; simulation = lecture seule ;
 *                         traces dans to_process_action_events, campagne 0626)
 *   database-restore-point runDatabaseBackup('admin') / restoreDatabaseBackup (lot 82E ; point de
 *                         restauration = sauvegarde format 2 ; restauration tout ou rien)
 *
 * Services chargés à la demande : la route reste légère.
 */
import type postgres from 'postgres';
import type { BackfillRequest } from './definitions';
import type { RawBackfillOutput } from './report-format';

export interface ExecutionHooks {
  /** Ligne de journal (affichée comme dernière activité). */
  log: (message: string) => void;
  /** Progression structurée, si le service en fournit. */
  progress: (p: Record<string, unknown>) => void;
}

/** Échantillons gardés par la synthèse texte des scripts (`--report --samples`). */
const SCRIPT_SAMPLES = 50;

export async function executeBackfill(sql: postgres.Sql, req: BackfillRequest, hooks: ExecutionHooks, admin?: { id: number }): Promise<RawBackfillOutput> {
  switch (req.script) {
    case 'database-restore-point': {
      // Lot 82E (C-Q8, D13) : même mécanisme que la sauvegarde nocturne ; restauration tout ou rien.
      if (req.action === 'restore') {
        const { restoreDatabaseBackup } = await import('@/services/backup/database-restore.service');
        const r = await restoreDatabaseBackup(sql, req.runId!, { reason: req.reason ?? '', adminUserId: admin?.id ?? null, log: hooks.log, progress: hooks.progress });
        return { result: r };
      }
      const { runDatabaseBackup } = await import('@/services/backup/database-backup.service');
      const m = await runDatabaseBackup('admin', {
        label: req.reason, adminUserId: admin?.id ?? null,
        onTable: (table, rows, i, n) => { hooks.progress({ tables: `${i}/${n}` }); if (rows > 0) hooks.log(`${table} : ${rows} ligne(s)`); },
      });
      // Rapport : signature des colonnes omise (elle reste dans le manifeste de la sauvegarde).
      return { result: { ...m, tables: m.tables.map(({ name, rows }) => ({ name, rows })) } };
    }
    case 'merge-rooms': {
      const m = await import('@/services/migration/rooms-merge');
      if (req.action === 'restore') {
        const r = await m.restoreRoomsMerge(sql, req.runId!, hooks.log);
        return { result: { ...r, runId: req.runId } };
      }
      const r = await m.runRoomsMerge({
        sql, apply: req.action === 'apply', accountId: req.accountId, batchSize: 100, dbReport: true, log: hooks.log,
      });
      const s = await m.summarizeRoomsMerge(sql, r.runId, SCRIPT_SAMPLES).catch(() => null);
      return { result: r, scriptSummary: s ?? undefined, scriptText: s ? m.formatRoomsMergeSummary(s) : undefined };
    }
    case 'document-asset-links': {
      const { backfillDocumentAssetLinks } = await import('@/services/documents/document-asset-links/backfill');
      const r = await backfillDocumentAssetLinks(sql, {
        batchSize: 500, pauseMs: 50,
        onProgress: ({ phase, cursor, done }) => {
          hooks.progress({ phase, cursor, done });
          hooks.log(`${phase === 'columns' ? 'colonnes' : 'propositions'} : ${done} traité(s), curseur ${cursor}`);
        },
      });
      return { result: r };
    }
    case 'agenda': {
      const a = await import('@/services/agenda/backfill/agenda-backfill');
      const apply = req.action === 'apply';
      if (req.step === 'dedupe') {
        const r = await a.dedupeAutomaticAgendaItems(sql, {
          apply,
          onProgress: ({ accountId, groups }) => {
            hooks.progress({ accountId, groups });
            hooks.log(`compte ${accountId} : ${groups} groupe(s) de doublons`);
          },
        });
        return { result: r };
      }
      const r = await a.backfillAgendaSourceLinks(sql, {
        apply, batchSize: 500,
        onProgress: ({ cursor, done }) => {
          hooks.progress({ cursor, done });
          hooks.log(`liens : ${done} élément(s), curseur ${cursor}`);
        },
      });
      return { result: r };
    }
    case 'cdc15': {
      const c = await import('@/services/migration/cdc15');
      if (req.action === 'restore') {
        const r = await c.restoreCdc15Run(sql, req.runId!);
        return { result: { ...r, runId: req.runId } };
      }
      const r = await c.runCdc15Backfill({
        sql, steps: 'all', accountId: req.accountId, apply: req.action === 'apply', batchSize: 200, pauseMs: 50, dbReport: true,
        log: (m) => {
          hooks.log(m);
          const etape = /^(MIG-\d\d) : /.exec(m);
          if (etape) hooks.progress({ step: etape[1] });
        },
      });
      const s = await c.summarizeRun(sql, r.runId, { samples: SCRIPT_SAMPLES }).catch(() => null);
      return { result: r, scriptSummary: s ?? undefined, scriptText: s ? c.formatRunSummary(s) : undefined };
    }
    case 'asset-account': {
      // Lot 40 : même service que la tâche planifiée (client applicatif, une
      // transaction par bien ; simulation = transaction annulée).
      const { runAssetAccountBackfill } = await import('@/services/assets/asset-account-backfill');
      const r = await runAssetAccountBackfill({
        apply: req.action === 'apply', batchSize: 500,
        onProgress: ({ processed, detected, assetId }) => {
          hooks.progress({ processed, detected });
          hooks.log(`bien ${assetId} : ${processed}/${detected}`);
        },
      });
      return { result: r };
    }
    case 'operations-structured': {
      // Lot 43 : même service que la tâche planifiée (une transaction par bien,
      // verrou Opération du compte ; simulation = transaction annulée).
      const { runStructuredOperationsMigration } = await import('@/services/business-operations/consolidation/asset-data-consolidator');
      const r = await runStructuredOperationsMigration({
        apply: req.action === 'apply', accountId: req.accountId, batchSize: 200, maxAssets: 5_000,
        onProgress: ({ processed, assetId }) => {
          hooks.progress({ processed });
          if (processed % 50 === 0) hooks.log(`bien ${assetId} : ${processed} examiné(s)`);
        },
      });
      return { result: r };
    }
    case 'claims-legacy-cleanup': {
      // Lot 83D (V-Q2, C-Q8) : refus SANS écriture s'il n'existe aucun point de restauration de moins de 24 h.
      const m = await import('@/services/business-operations/claims/legacy-cleanup');
      if (req.action === 'restore') {
        const r = await m.restoreClaimLegacyCleanup(sql, req.runId!, { reason: req.reason, adminUserId: admin?.id ?? null });
        hooks.log(`restauration ${req.runId} : ${r.restored} ligne(s), ${r.conflicts.length} conflit(s)`);
        return { result: { ...r, action: 'restore' } };
      }
      const r = await m.runClaimLegacyCleanup({
        sql, mode: req.action === 'apply' ? 'APPLY' : 'SIMULATE', accountId: req.accountId, reason: req.reason,
        adminUserId: admin?.id ?? null, log: hooks.log,
      });
      if (r.status === 'refused') throw Object.assign(new Error(r.refusal ?? 'Point de restauration requis.'), { code: 'RESTORE_POINT_REQUIRED' });
      return { result: r };
    }
    case 'cross-account': {
      // Lot 53 (D23) : correction contrôlée, une famille par exécution.
      const m = await import('@/services/security/cross-account/remediation');
      if (req.action === 'restore') {
        const r = await m.restoreCrossAccountRemediation(sql, req.runId!);
        hooks.log(`restauration ${req.runId} : ${r.restored} ligne(s), ${r.conflicts.length} conflit(s)`);
        return { result: r };
      }
      const r = await m.runCrossAccountRemediation(sql, {
        family: req.step as import('@/services/security/cross-account/remediation').RemediationFamily,
        apply: req.action === 'apply', accountId: req.accountId, reason: req.reason, log: hooks.log,
      });
      return { result: r };
    }
    case 'equipment-separation': {
      // Lot 71A (BUG P1 bien / équipement) : provenance vérifiée, corrections tracées (0489).
      const { runDataSeparationBackfill } = await import('@/services/equipment/data-separation-backfill');
      const r = await runDataSeparationBackfill({
        apply: req.action === 'apply', accountId: req.accountId, reason: req.reason, log: hooks.log,
      });
      return { result: r };
    }
    case 'document-validation': {
      // Lot 71B : plus de validation sur les fiches — même service que la tâche planifiée (trace 0495).
      const { runValidationReprise } = await import('@/services/documents/validation-reprise');
      const r = await runValidationReprise({
        apply: req.action === 'apply', origin: 'BO', accountId: req.accountId, reason: req.reason, log: hooks.log,
      });
      return { result: r };
    }
    case 'duo-shared-account': {
      // Lot 72D : membres Duo rattachés au compte partagé, comptes artificiels archivés (journal 0521).
      const m = await import('@/services/account/duo-shared-account-backfill');
      if (req.action === 'restore') {
        const r = await m.restoreDuoSharedAccountRun(sql, req.runId!);
        hooks.log(`restauration ${req.runId} : ${r.restored} écriture(s), ${r.conflicts.length} conflit(s)`);
        return { result: r };
      }
      const r = await m.runDuoSharedAccountBackfill(sql, { apply: req.action === 'apply', accountId: req.accountId, log: hooks.log });
      return { result: r };
    }
    case 'agenda-intervention-duplicates': {
      // Lot 76H : même service que la tâche de démarrage (projection rejouée, journal 0591).
      const m = await import('@/services/business-operations/agenda-projection/duplicates-reprise');
      if (req.action === 'restore') {
        const r = await m.restoreAgendaDuplicatesReprise(sql, req.runId!, { reason: req.reason });
        hooks.log(`restauration ${req.runId} : ${r.restored} écriture(s), ${r.conflicts.length} conflit(s)`);
        return { result: { ...r, runId: req.runId } };
      }
      let r = await m.runAgendaDuplicatesReprise({ mode: req.action === 'apply' ? 'APPLY' : 'SIMULATE', origin: 'BO', accountId: req.accountId, reason: req.reason, log: hooks.log, sql });
      // Exécution bornée par appels : poursuivie jusqu'au bout du périmètre.
      while (r.more) {
        hooks.progress({ cursor: r.cursor, ...r.counters });
        r = await m.runAgendaDuplicatesReprise({ mode: r.mode, origin: 'BO', accountId: req.accountId, resumeRunId: r.runId, log: hooks.log, sql });
      }
      return { result: r };
    }
    case 'to-process-false-arbitrations': {
      // Lot 81A : même service que la campagne automatique (réexamen T3 en lecture seule).
      const { runArbitrationReprise } = await import('@/services/to-process/arbitration-equivalence-reprise');
      const r = await runArbitrationReprise({ apply: req.action === 'apply', accountId: req.accountId, origin: 'BO', log: hooks.log });
      return { result: r };
    }
  }
}
