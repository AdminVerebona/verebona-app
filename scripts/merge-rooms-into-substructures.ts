/**
 * Reprise des pièces `rooms` dans `substructures` — décision PO D-G (lot 20,
 * chantier B ; migration 0229 à appliquer d'abord, au démarrage de l'app).
 *
 *   npm run db:merge-rooms                       (simulation + rapport en base)
 *   npm run db:merge-rooms -- --apply [--account <id>] [--limit <n>] [--json <fichier>]
 *   npm run db:merge-rooms -- --report <runId> [--samples 20]
 *   npm run db:merge-rooms -- --restore <runId>
 *   npm run db:merge-rooms -- --help
 *
 * (équivalent : `npx tsx scripts/merge-rooms-into-substructures.ts …`, Windows
 * compris — aucun chemin ni commande shell propre à un système.)
 *
 * Lancement MANUEL. Sans `--apply` : SIMULATION (transaction annulée par
 * pièce) ; seules `room_merge_runs` / `room_merge_changes` sont écrites
 * (`--no-db-report` : rien). Relançable sans doublon ; restauration fidèle
 * par `--restore`. Ne lance JAMAIS `ensureMigrations` : un prérequis absent
 * est signalé (code de sortie 2) et rien n'est exécuté. Une seule exécution
 * `--apply` / `--restore` à la fois (code 3 sinon).
 */
import '@/lib/load-env';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pgClient } from '@/db';
import {
  ConcurrentRunError, MissingRequirementsError, formatRoomsMergeSummary, parseRoomsMergeArgs, restoreRoomsMerge,
  runRoomsMerge, summarizeRoomsMerge,
} from '@/services/migration/rooms-merge';

const P = '[merge-rooms]';

async function main() {
  const a = parseRoomsMergeArgs(process.argv.slice(2));
  if (a.kind === 'error') { console.error(a.message); process.exitCode = 2; return; }
  if (a.kind === 'help') { console.log(a.message); return; }
  if (a.kind === 'restore') {
    const r = await restoreRoomsMerge(pgClient, a.runId);
    console.log(`${P} restauration ${a.runId} — ${r.restored} valeur(s) restaurée(s), ${r.deletedSubstructures} sous-structure(s) `
      + `supprimée(s), ${r.conflicts.length} conflit(s)${r.conflicts.length
        ? ` : ${r.conflicts.slice(0, 50).map((c) => `${c.table}#${c.rowId} ${c.reason}`).join(', ')}` : ''}.`);
    if (r.conflicts.length) process.exitCode = 1;
    return;
  }
  if (a.kind === 'report') {
    const s = await summarizeRoomsMerge(pgClient, a.runId, a.samples);
    if (!s) { console.error(`${P} exécution ${a.runId} introuvable.`); process.exitCode = 1; return; }
    console.log(formatRoomsMergeSummary(s));
    return;
  }
  const r = await runRoomsMerge({
    sql: pgClient, apply: a.apply, accountId: a.accountId, limit: a.limit, batchSize: a.batch, dbReport: a.dbReport,
    log: (m) => console.log(`${P} ${m}`),
  });
  if (a.json) await writeFile(resolve(a.json), JSON.stringify(r, null, 2), 'utf8');
  for (const w of r.warnings) console.warn(`${P} AVERTISSEMENT : ${w}`);
  console.log(`${P} ${r.mode === 'apply' ? 'appliqué' : 'simulation'} — exécution ${r.runId}`
    + `${a.dbReport || a.apply ? ` (consulter : npm run db:merge-rooms -- --report ${r.runId})` : ''}`);
  if (r.counts.failed) process.exitCode = 1;
}

main()
  .catch((e) => {
    if (e instanceof MissingRequirementsError) { console.error(e.message); process.exitCode = 2; return; }
    if (e instanceof ConcurrentRunError) { console.error(e.message); process.exitCode = 3; return; }
    console.error(`${P} échec :`, (e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => pgClient.end().catch(() => {}));
