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

export async function executeBackfill(sql: postgres.Sql, req: BackfillRequest, hooks: ExecutionHooks): Promise<RawBackfillOutput> {
  switch (req.script) {
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
  }
}
