/**
 * Rattrapages de l'agenda — CDC 15 §14 points 5 et 6 (lot 14, volet B).
 *
 *   npx tsx scripts/agenda-backfill.ts source-links [--apply] [--batch=500] [--from-item=0] [--report=agenda-source-links.json]
 *   npx tsx scripts/agenda-backfill.ts dedupe       [--apply] [--from-account=0] [--report=agenda-dedupe.json]
 *
 * Lancement MANUEL, après la migration 0223. Sans `--apply` : rapport seul,
 * rien n'est écrit. Idempotent et reprenable (curseurs affichés). Aucun
 * élément manuel ni modifié par l'utilisateur n'est touché ; les cas
 * inexploitables vont au rapport. Voir
 * `services/agenda/backfill/agenda-backfill.ts`.
 */
import '@/lib/load-env';
import { writeFile } from 'node:fs/promises';
import { pgClient } from '@/db';
import { backfillAgendaSourceLinks, dedupeAutomaticAgendaItems } from '@/services/agenda/backfill/agenda-backfill';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const apply = process.argv.includes('--apply');

async function main() {
  const commande = process.argv[2];
  if (commande === 'source-links') {
    const reportPath = arg('report', 'agenda-source-links.json');
    const r = await backfillAgendaSourceLinks(pgClient, {
      apply, batchSize: Number(arg('batch', '500')), fromItemId: Number(arg('from-item', '0')),
      onProgress: ({ cursor, done }) => console.log(`[agenda-backfill] liens : ${done} élément(s), curseur ${cursor}`),
    });
    await writeFile(reportPath, JSON.stringify(r, null, 2));
    console.log(`[agenda-backfill] liens ${apply ? 'appliqués' : '(simulation)'} — éléments ${r.scanned}, liens document ${r.fileLinksCreated}, `
      + `traces ${r.sourceTracesCreated}, références inexploitables ${r.orphans.length} (rapport : ${reportPath}).`);
  } else if (commande === 'dedupe') {
    const reportPath = arg('report', 'agenda-dedupe.json');
    const r = await dedupeAutomaticAgendaItems(pgClient, {
      apply, fromAccountId: Number(arg('from-account', '0')),
      onProgress: ({ accountId, groups }) => console.log(`[agenda-backfill] compte ${accountId} : ${groups} groupe(s) de doublons`),
    });
    await writeFile(reportPath, JSON.stringify(r, null, 2));
    console.log(`[agenda-backfill] dédoublonnage ${apply ? 'appliqué' : '(simulation)'} — comptes ${r.accountsScanned}, `
      + `éléments ${r.itemsScanned}, groupes ${r.groups.length}, retirés ${r.removed.length} (rapport : ${reportPath}).`);
  } else {
    console.error('Usage : agenda-backfill.ts <source-links|dedupe> [--apply] …');
    process.exitCode = 2;
  }
  await pgClient.end();
}

main().catch(async (e) => {
  console.error('[agenda-backfill] échec :', (e as Error).message);
  await pgClient.end().catch(() => {});
  process.exit(1);
});
