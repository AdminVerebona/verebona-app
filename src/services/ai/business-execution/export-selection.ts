/**
 * Carte #802 — SÉLECTION de l'export diagnostic : lecture STRICTE des filtres
 * actifs de l'écran « Exécutions & logs ». PUR, sans import serveur.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLE : l'export respecte EXACTEMENT les filtres de l'écran, ou il est
 * BLOQUÉ avant lancement. Les lectures de l'écran sont tolérantes (une valeur
 * illisible est ignorée : un lien ancien montre moins de filtres) ; pour un
 * export, ignorer un filtre livrerait une sélection PLUS LARGE que celle
 * demandée. Ici, tout filtre inconnu, illisible ou hors du périmètre de
 * l'onglet est rendu dans `unsupported` : rien n'est lancé.
 *
 * DEUX PÉRIMÈTRES, ceux de l'écran :
 *   · `executions` — vue métier et onglet « Exécutions techniques » : filtres
 *     du journal (`parseJournalFilter` : période en jours de Paris sur la
 *     date de référence, traitement, issue, nature, origine, compte) ;
 *   · `calls` — onglet « Appels modèles » : filtres de la liste des appels
 *     (`executionApiFilters`, la traduction même de la route : modèle,
 *     opération, rang, job, utilisateur, statut, version, durée, objet,
 *     déclencheur, mode T6, erreurs seulement, compte, traitement, période
 *     en jours UTC sur la date de l'appel).
 * Les autres onglets (Requêtes T2, Rapports, Complétude T1, Qualification,
 * Schémas, Archives) n'ont pas de traduction : export bloqué, dit avant
 * lancement.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { BUSINESS_ORIGINS, parseJournalFilter, journalFilterToParams, type JournalFilter } from './journal';
import { MAX_PERIOD_DAYS, periodExceedsMax } from './period';
import { BUSINESS_OUTCOMES, BUSINESS_TREATMENTS } from './types';
import { executionApiFilters, executionFiltersToParams, readExecutionFilters, type ExecutionApiFilters, type ExecutionScreenFilters } from '../telemetry/execution-filters';

export type ExportScope = 'executions' | 'calls';

export interface UnsupportedFilter { key: string; value: string; reason: string }

export type ExportSelection =
  | { scope: 'executions'; journal: JournalFilter; params: Record<string, string> }
  | { scope: 'calls'; calls: ExecutionApiFilters; params: Record<string, string> };

export type ExportSelectionResult = { ok: true; selection: ExportSelection } | { ok: false; unsupported: UnsupportedFilter[] };

/** Clés de commande de la requête (jamais des filtres). */
const CONTROL_KEYS: ReadonlySet<string> = new Set(['scope', 'contenusSensibles', 'action']);
const JOURNAL_KEYS = ['days', 'from', 'to', 'treatment', 'outcome', 'nature', 'origin', 'accountId'] as const;
const CALL_KEYS = [
  'treatment', 'accountId', 'userId', 'model', 'rank', 'configVersionId', 'operationCode', 'jobId', 'from', 'to',
  'minDurationMs', 'status', 'objectType', 'objectId', 'trigger', 't6Mode', 'errorsOnly',
] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const SCOPE_LABELS: Record<string, string> = {
  t2: 'Requêtes T2', reports: 'Rapports', completeness: 'Complétude T1', qualification: 'Qualification', schemas: 'Schémas', archives: 'Archives',
};

/** Jour civil réel (le 31 février est refusé). */
const realDay = (v: string): boolean => DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/** Valeurs de la requête en texte ; null : type non accepté (objet, tableau). `''`, null et undefined : filtre absent. */
function textValues(body: Record<string, unknown>): { values: Map<string, string>; invalid: UnsupportedFilter[] } {
  const values = new Map<string, string>();
  const invalid: UnsupportedFilter[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (CONTROL_KEYS.has(k) || v === undefined || v === null || v === '') continue;
    if (k === 'errorsOnly' && typeof v === 'boolean') { if (v) values.set(k, '1'); continue; }
    if (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) { values.set(k, String(v)); continue; }
    invalid.push({ key: k, value: typeof v, reason: 'valeur illisible (texte ou nombre attendu)' });
  }
  return { values, invalid };
}

function parseExecutionsScope(values: Map<string, string>, now: Date): UnsupportedFilter[] {
  const bad: UnsupportedFilter[] = [];
  const add = (key: string, reason: string) => bad.push({ key, value: values.get(key) ?? '', reason });
  for (const k of values.keys()) {
    if ((JOURNAL_KEYS as readonly string[]).includes(k)) continue;
    add(k, (CALL_KEYS as readonly string[]).includes(k)
      ? 'filtre de l’onglet « Appels modèles » : il ne s’applique pas au journal des exécutions — lancez l’export depuis cet onglet'
      : 'filtre inconnu de l’export des exécutions');
  }
  const days = values.get('days');
  const from = values.get('from');
  const to = values.get('to');
  if (days !== undefined && (from !== undefined || to !== undefined)) add('days', 'période ambiguë : nombre de jours ET dates saisies');
  if (days !== undefined && !(/^\d{1,3}$/.test(days) && Number(days) >= 1 && Number(days) <= MAX_PERIOD_DAYS)) add('days', `nombre de jours hors de 1 à ${MAX_PERIOD_DAYS}`);
  if (from !== undefined && !realDay(from)) add('from', 'date illisible (AAAA-MM-JJ attendu)');
  if (to !== undefined && !realDay(to)) add('to', 'date illisible (AAAA-MM-JJ attendu)');
  if ((from === undefined || realDay(from)) && (to === undefined || realDay(to)) && periodExceedsMax({ from, to }, now)) {
    add(from !== undefined ? 'from' : 'to', `période de plus de ${MAX_PERIOD_DAYS} jours : le journal des exécutions couvre au plus ${MAX_PERIOD_DAYS} jours par lecture — réduisez la période (plusieurs exports successifs pour un historique plus long)`);
  }
  const t = values.get('treatment');
  if (t !== undefined && !(BUSINESS_TREATMENTS as readonly string[]).includes(t)) add('treatment', 'traitement inconnu');
  const o = values.get('outcome');
  if (o !== undefined && !(BUSINESS_OUTCOMES as readonly string[]).includes(o)) add('outcome', 'issue inconnue');
  const n = values.get('nature');
  if (n !== undefined && !['BUSINESS', 'TECHNICAL', 'all'].includes(n)) add('nature', 'nature inconnue (BUSINESS, TECHNICAL ou all)');
  const g = values.get('origin');
  if (g !== undefined && !(BUSINESS_ORIGINS as readonly string[]).includes(g)) add('origin', 'origine inconnue');
  const a = values.get('accountId');
  if (a !== undefined && !/^\d{1,10}$/.test(a)) add('accountId', 'compte illisible (identifiant numérique attendu)');
  return bad;
}

function parseCallsScope(values: Map<string, string>): UnsupportedFilter[] {
  const bad: UnsupportedFilter[] = [];
  const add = (key: string, reason: string) => bad.push({ key, value: values.get(key) ?? '', reason });
  for (const k of values.keys()) {
    if ((CALL_KEYS as readonly string[]).includes(k)) continue;
    add(k, (JOURNAL_KEYS as readonly string[]).includes(k)
      ? 'filtre du journal des exécutions : il ne s’applique pas à l’onglet « Appels modèles »'
      : 'filtre inconnu de l’export des appels');
  }
  // Même lecture que l'écran : une valeur que l'écran écarterait est refusée ici.
  const read = readExecutionFilters({ get: (k) => values.get(k) ?? null });
  for (const k of CALL_KEYS) {
    const v = values.get(k);
    if (v === undefined) continue;
    const kept = k === 'errorsOnly' ? (read.errorsOnly ? '1' : '') : read[k as Exclude<keyof ExecutionScreenFilters, 'errorsOnly'>];
    if (kept !== v) add(k, 'valeur que l’écran n’applique pas (filtre illisible)');
  }
  for (const k of ['from', 'to'] as const) {
    const v = values.get(k);
    if (v !== undefined && DAY.test(v) && !realDay(v)) add(k, 'date illisible (AAAA-MM-JJ attendu)');
  }
  return bad;
}

/**
 * Requête d'export (corps JSON) → sélection, ou liste des filtres non pris en
 * charge (export bloqué avant lancement). `scope` absent : `executions`.
 */
export function parseExportSelection(body: Record<string, unknown>, now: Date = new Date()): ExportSelectionResult {
  const scope = body.scope === undefined || body.scope === null || body.scope === '' ? 'executions' : body.scope;
  if (scope !== 'executions' && scope !== 'calls') {
    const label = typeof scope === 'string' ? SCOPE_LABELS[scope] : undefined;
    return {
      ok: false,
      unsupported: [{
        key: 'scope', value: typeof scope === 'string' ? scope : typeof scope,
        reason: label
          ? `l’onglet « ${label} » n’a pas de traduction dans l’export diagnostic : utilisez la vue métier, l’onglet « Exécutions techniques » ou l’onglet « Appels modèles »`
          : 'périmètre d’export inconnu',
      }],
    };
  }
  const { values, invalid } = textValues(body);
  const bad = [...invalid, ...(scope === 'executions' ? parseExecutionsScope(values, now) : parseCallsScope(values))];
  if (bad.length) return { ok: false, unsupported: bad };
  const p = { get: (k: string) => values.get(k) ?? null };
  if (scope === 'executions') {
    const journal = parseJournalFilter(p, now);
    return { ok: true, selection: { scope, journal, params: Object.fromEntries(journalFilterToParams(journal)) } };
  }
  return { ok: true, selection: { scope, calls: executionApiFilters(p), params: Object.fromEntries(executionFiltersToParams(readExecutionFilters(p))) } };
}

/** Phrase d'un blocage pour filtres non pris en charge (affichée telle quelle). */
export function unsupportedMessage(u: readonly UnsupportedFilter[]): string {
  return `Export impossible avec ces filtres : ${u.map((x) => `${x.key}${x.value ? ` = « ${x.value} »` : ''} — ${x.reason}`).join(' ; ')}. Aucun export n’a été lancé.`;
}
