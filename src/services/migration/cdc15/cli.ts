/**
 * Arguments de `scripts/cdc15-backfill.ts` (pur, testé). Formes acceptées :
 * `--step MIG-01`, `--step=MIG-01`, étapes séparées par des virgules.
 */
import { MIG_STEPS } from './types';

export type ParsedArgs =
  | { kind: 'run'; steps: string[] | 'all'; accountId: number | null; apply: boolean; batch: number; pause: number;
      limit: number | null; resume: string | null; dbReport: boolean; json: string | null }
  | { kind: 'report'; runId: string; samples: number; decision: string | undefined }
  | { kind: 'restore'; runId: string }
  | { kind: 'help'; message: string }
  | { kind: 'error'; message: string };

const USAGE = 'Usage : cdc15-backfill.ts --step MIG-0x|all [--account <id>] [--apply] [--batch n] [--pause ms] [--limit n] '
  + '[--resume <runId>] [--no-db-report] [--json <fichier>]  |  --report <runId> [--samples n] [--decision D]  |  --restore <runId>  |  --help';

/** Aide détaillée (`--help`). */
export const HELP = [
  USAGE,
  '',
  'Rattrapages de données du CDC 15 §14 (MIG-01 à MIG-08 ; MIG-09 = règle appliquée par toutes les étapes).',
  '  --step        étapes (liste séparée par des virgules) ou « all » : ordre MIG-01, 03, 02, 04, 07, 08, 05, 06.',
  '  --apply       écrit les données. SANS --apply : SIMULATION — aucune donnée ni carte « À traiter » n’est écrite ;',
  '                SEULES les tables de rapport (cdc15_migration_report, cdc15_migration_runs, migration 0225) sont écrites,',
  '                pour consulter la simulation (--report). --no-db-report : aucune écriture du tout (rapport JSON / console).',
  '  --account     un seul compte (MIG-05, 06, 08 parcourent toute la base : ignorées avec ce filtre).',
  '  --batch, --pause, --limit   lots bornés, pause entre lots, limite PAR PARTIE d’étape (exécution PARTIAL, reprenable).',
  '  --resume      reprend une exécution interrompue ou partielle à ses curseurs.',
  '  --report      synthèse d’une exécution (valeurs sensibles masquées).',
  '  --restore     remet les colonnes historiques écrasées par une exécution (copie restaurable de MIG-07).',
  'Une seule exécution --apply (ou --restore) à la fois (verrou consultatif). Aucun appel à ensureMigrations :',
  'une table manquante est signalée (code 2) et rien n’est exécuté.',
].join('\n');

export function parseBackfillArgs(argv: string[]): ParsedArgs {
  const flags = new Set<string>();
  const vals = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) return { kind: 'error', message: `Argument inattendu : ${a}\n${USAGE}` };
    const eq = a.indexOf('=');
    if (eq > 0) { vals.set(a.slice(2, eq), a.slice(eq + 1)); continue; }
    const name = a.slice(2);
    if (['apply', 'no-db-report', 'help'].includes(name)) { flags.add(name); continue; }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) return { kind: 'error', message: `Valeur manquante pour --${name}\n${USAGE}` };
    vals.set(name, v);
    i += 1;
  }
  const entier = (k: string, def: number | null): number | null | 'ko' => {
    if (!vals.has(k)) return def;
    const n = Number(vals.get(k));
    return Number.isInteger(n) && n >= 0 ? n : 'ko';
  };
  if (flags.has('help')) return { kind: 'help', message: HELP };
  if (vals.has('restore')) return { kind: 'restore', runId: vals.get('restore')! };
  if (vals.has('report')) {
    const samples = entier('samples', 20);
    if (samples === 'ko' || samples === null) return { kind: 'error', message: '--samples : entier attendu' };
    return { kind: 'report', runId: vals.get('report')!, samples, decision: vals.get('decision') };
  }
  const resume = vals.get('resume') ?? null;
  const stepArg = vals.get('step');
  if (!stepArg && !resume) return { kind: 'error', message: `--step requis\n${USAGE}` };
  let steps: string[] | 'all' = 'all';
  if (stepArg && stepArg !== 'all') {
    steps = stepArg.split(',').map((s) => s.trim().toUpperCase());
    const inconnues = steps.filter((s) => !(MIG_STEPS as readonly string[]).includes(s));
    if (inconnues.length) {
      return { kind: 'error', message: `Étape inconnue : ${inconnues.join(', ')} (MIG-09 est la règle appliquée par toutes les étapes)\n${USAGE}` };
    }
  }
  const accountId = entier('account', null);
  const batch = entier('batch', 200);
  const pause = entier('pause', 50);
  const limit = entier('limit', null);
  for (const [k, v] of [['account', accountId], ['batch', batch], ['pause', pause], ['limit', limit]] as const) {
    if (v === 'ko') return { kind: 'error', message: `--${k} : entier positif attendu` };
  }
  if (batch === 0) return { kind: 'error', message: '--batch : au moins 1' };
  return {
    kind: 'run', steps, accountId: accountId as number | null, apply: flags.has('apply'), batch: batch as number, pause: pause as number,
    limit: limit as number | null, resume, dbReport: !flags.has('no-db-report'), json: vals.get('json') ?? null,
  };
}
