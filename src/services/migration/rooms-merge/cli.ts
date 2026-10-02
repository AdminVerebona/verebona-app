/**
 * Arguments de `scripts/merge-rooms-into-substructures.ts` (pur, testé).
 * Formes acceptées : `--account 12`, `--account=12`.
 */
export type RoomsMergeArgs =
  | { kind: 'run'; apply: boolean; accountId: number | null; limit: number | null; batch: number; dbReport: boolean; json: string | null }
  | { kind: 'report'; runId: string; samples: number }
  | { kind: 'restore'; runId: string }
  | { kind: 'help'; message: string }
  | { kind: 'error'; message: string };

const USAGE = 'Usage : merge-rooms-into-substructures.ts [--dry-run | --apply] [--account <id>] [--limit n] [--batch n] '
  + '[--no-db-report] [--json <fichier>]  |  --report <runId> [--samples n]  |  --restore <runId>  |  --help';

export const ROOMS_MERGE_HELP = [
  USAGE,
  '',
  'Reprise des pièces `rooms` dans `substructures` (décision PO D-G, lot 20 ; migration 0229).',
  '  (défaut) / --dry-run  SIMULATION : mêmes instructions, transaction annulée par pièce ; seul le rapport',
  '                        (room_merge_runs, room_merge_changes) est écrit — --no-db-report : rien du tout.',
  '  --apply               écrit : une sous-structure par pièce (reprise d’une sous-structure du même bien et du',
  '                        même nom si elle est unique), références repointées, journal pour la restauration.',
  '  --account             un seul compte.   --limit  nombre maximal de pièces (relançable).',
  '  --report <runId>      synthèse d’une exécution.',
  '  --restore <runId>     défait une exécution --apply (valeurs modifiées depuis : signalées, jamais écrasées).',
  'Relançable sans doublon. Une seule exécution --apply / --restore à la fois. N’appelle jamais ensureMigrations.',
].join('\n');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseRoomsMergeArgs(argv: string[]): RoomsMergeArgs {
  const flags = new Set<string>();
  const vals = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) return { kind: 'error', message: `Argument inattendu : ${a}\n${USAGE}` };
    const eq = a.indexOf('=');
    if (eq > 0) { vals.set(a.slice(2, eq), a.slice(eq + 1)); continue; }
    const name = a.slice(2);
    if (['apply', 'dry-run', 'no-db-report', 'help'].includes(name)) { flags.add(name); continue; }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) return { kind: 'error', message: `Valeur manquante pour --${name}\n${USAGE}` };
    vals.set(name, v);
    i += 1;
  }
  const connus = new Set(['account', 'limit', 'batch', 'json', 'report', 'samples', 'restore']);
  for (const k of vals.keys()) if (!connus.has(k)) return { kind: 'error', message: `Option inconnue : --${k}\n${USAGE}` };
  if (flags.has('help')) return { kind: 'help', message: ROOMS_MERGE_HELP };
  const entier = (k: string, def: number | null): number | null | 'ko' => {
    if (!vals.has(k)) return def;
    const n = Number(vals.get(k));
    return Number.isInteger(n) && n > 0 ? n : 'ko';
  };
  for (const k of ['restore', 'report'] as const) {
    if (vals.has(k) && !UUID.test(vals.get(k)!)) return { kind: 'error', message: `--${k} : identifiant d’exécution (UUID) attendu` };
  }
  if (vals.has('restore')) {
    if (flags.has('apply') || flags.has('dry-run')) return { kind: 'error', message: '--restore ne se combine pas avec --apply / --dry-run' };
    return { kind: 'restore', runId: vals.get('restore')! };
  }
  if (vals.has('report')) {
    const samples = entier('samples', 20);
    if (samples === 'ko' || samples === null) return { kind: 'error', message: '--samples : entier positif attendu' };
    return { kind: 'report', runId: vals.get('report')!, samples };
  }
  if (flags.has('apply') && flags.has('dry-run')) return { kind: 'error', message: '--apply et --dry-run sont exclusifs' };
  const accountId = entier('account', null);
  const limit = entier('limit', null);
  const batch = entier('batch', 100);
  for (const [k, v] of [['account', accountId], ['limit', limit], ['batch', batch]] as const) {
    if (v === 'ko') return { kind: 'error', message: `--${k} : entier positif attendu` };
  }
  return {
    kind: 'run', apply: flags.has('apply'), accountId: accountId as number | null, limit: limit as number | null,
    batch: batch as number, dbReport: !flags.has('no-db-report'), json: vals.get('json') ?? null,
  };
}
