/**
 * Rattrapages de données du CDC 15 §14 (MIG-01 à MIG-09) — lot 17, volet B.
 *
 *   npx tsx scripts/cdc15-backfill.ts --step MIG-01|…|MIG-08|all [--account <id>] [--apply]
 *        [--batch 200] [--pause 50] [--limit <n>] [--resume <runId>] [--no-db-report] [--json <fichier>]
 *   npx tsx scripts/cdc15-backfill.ts --report <runId> [--samples 20] [--decision AMBIGUOUS]
 *   npx tsx scripts/cdc15-backfill.ts --restore <runId>
 *   npx tsx scripts/cdc15-backfill.ts --help
 *
 * Lancement MANUEL. Sans `--apply` : SIMULATION — aucune donnée ni carte
 * écrite ; SEULES les tables de rapport (`cdc15_migration_report`,
 * `cdc15_migration_runs`, migration 0225) sont écrites, pour consulter la
 * simulation (arbitrage lot 17) — `--no-db-report` : aucune écriture du tout.
 * Une seule exécution `--apply` / `--restore` à la fois (verrou consultatif).
 * Ordre de `--step all` : MIG-01, 03, 02, 04, 07, 08, 05, 06 (voir `types.ts`).
 * MIG-05, 06, 08 appellent les rattrapages existants
 * (`agenda-backfill.ts`, `backfill-document-asset-links.ts`) et ne
 * connaissent pas `--account` (ignorées avec ce filtre).
 * Ne lance JAMAIS `ensureMigrations` : une table manquante est signalée
 * (code de sortie 2) et rien n'est exécuté.
 * Reprenable : `--resume <runId>` (étapes terminées sautées, curseurs repris).
 * Idempotent : relancé, il ne réécrit rien (NO_CHANGE), et ne duplique aucune carte.
 */
import '@/lib/load-env';
import { writeFile } from 'node:fs/promises';
import { pgClient } from '@/db';
import {
  ConcurrentRunError, formatRunSummary, MissingRequirementsError, restoreCdc15Run, runCdc15Backfill, summarizeRun,
  type Decision, type MigStep,
} from '@/services/migration/cdc15';
import { parseBackfillArgs } from '@/services/migration/cdc15/cli';

async function main() {
  const a = parseBackfillArgs(process.argv.slice(2));
  if (a.kind === 'error') {
    console.error(a.message);
    process.exitCode = 2;
    return;
  }
  if (a.kind === 'help') { console.log(a.message); return; }
  if (a.kind === 'restore') {
    const r = await restoreCdc15Run(pgClient, a.runId);
    console.log(`[cdc15-backfill] restauration ${a.runId} — ${r.restored} valeur(s) restaurée(s), `
      + `${r.conflicts.length} modifiée(s) depuis (non restaurées)${r.conflicts.length ? ` : ${r.conflicts.slice(0, 50).map((c) => `${c.targetType}#${c.targetId} ${c.name}`).join(', ')}` : ''}.`);
    return;
  }
  if (a.kind === 'report') {
    const s = await summarizeRun(pgClient, a.runId, { samples: a.samples, decision: a.decision as Decision | undefined });
    if (!s) { console.error(`Exécution ${a.runId} introuvable.`); process.exitCode = 1; return; }
    console.log(formatRunSummary(s));
    return;
  }
  const r = await runCdc15Backfill({
    sql: pgClient, steps: a.steps as MigStep[] | 'all', accountId: a.accountId, apply: a.apply, batchSize: a.batch,
    pauseMs: a.pause, limit: a.limit, resumeRunId: a.resume, dbReport: a.dbReport,
    log: (m) => console.log(`[cdc15-backfill] ${m}`),
  });
  if (a.json) await writeFile(a.json, JSON.stringify(r, null, 2));
  for (const w of r.warnings) console.warn(`[cdc15-backfill] AVERTISSEMENT : ${w}`);
  console.log(`[cdc15-backfill] ${r.mode === 'apply' ? 'appliqué' : 'simulation'} — exécution ${r.runId}`
    + `${a.dbReport ? ` (consulter : npx tsx scripts/cdc15-backfill.ts --report ${r.runId})` : ''}`);
}

main()
  .catch((e) => {
    if (e instanceof MissingRequirementsError) { console.error(e.message); process.exitCode = 2; return; }
    if (e instanceof ConcurrentRunError) { console.error(e.message); process.exitCode = 3; return; }
    console.error('[cdc15-backfill] échec :', (e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => pgClient.end().catch(() => {}));
