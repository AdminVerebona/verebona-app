/**
 * Rattrapage §14.8 de `document_asset_links` (CDC 15 X-01 ; plan D-11, HC-03).
 *
 *   npx tsx scripts/backfill-document-asset-links.ts [--batch=500] [--pause=50] \
 *     [--from-file=0] [--from-proposal=0] [--report=backfill-document-asset-links.json]
 *
 * Lancement MANUEL, après application de la migration 0221 (déclencheur
 * compris) : voir `services/documents/document-asset-links/backfill.ts` pour
 * le choix (volume inconnu, démarrages concurrents, aucune urgence — le
 * déclencheur couvre les écritures nouvelles). Idempotent et reprenable
 * (`--from-file`, `--from-proposal` : curseurs affichés en cours de route).
 * Les cas ambigus sont écrits dans le rapport JSON, jamais tranchés.
 */
import '@/lib/load-env';
import { writeFile } from 'node:fs/promises';
import { pgClient } from '@/db';
import { backfillDocumentAssetLinks } from '@/services/documents/document-asset-links/backfill';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function main() {
  const reportPath = arg('report', 'backfill-document-asset-links.json');
  const report = await backfillDocumentAssetLinks(pgClient, {
    batchSize: Number(arg('batch', '500')),
    pauseMs: Number(arg('pause', '50')),
    fromFileId: Number(arg('from-file', '0')),
    fromProposalId: Number(arg('from-proposal', '0')),
    onProgress: ({ phase, cursor, done }) => console.log(`[backfill-dal] ${phase} : ${done} traité(s), curseur ${cursor}`),
  });
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(
    `[backfill-dal] terminé — documents ${report.filesScanned}, propositions ${report.proposalsScanned}, `
    + `liens colonnes ${report.legacyLinksBefore} → ${report.legacyLinksAfter}, liens MIGRATION créés ${report.migrationLinksCreated}, `
    + `cas ambigus ${report.ambiguous.length} (rapport : ${reportPath}).`,
  );
  await pgClient.end();
}

main().catch(async (e) => {
  console.error('[backfill-dal] échec :', (e as Error).message);
  await pgClient.end().catch(() => {});
  process.exit(1);
});
