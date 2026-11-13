/**
 * Lot 113AO (Trello #748, B4) — RATTRAPAGE de l'exécution métier des appels
 * T6 rattachés à tort à une autre exécution (BO › Exploitation › Rattrapages,
 * jamais automatique ; simuler, appliquer, restaurer).
 *
 * Cause (voir `t6-execution-scope.ts`) : un appel `t6_formulate` ou
 * `t6_evaluate` lancé par la pré-génération demandée à la fin d'une analyse
 * T1 héritait du contexte du travail T1 — `ai_usage_event.business_execution_id`
 * = `T1:job:…` au lieu de `T6F:<trace>` / `T6E:…`. Le nouveau chemin écrit la
 * bonne exécution à la source ; ce rattrapage ne corrige que l'historique, et
 * SEULEMENT avec preuve :
 *   · opération réelle de l'appel (`operation_type` t6_formulate / t6_evaluate) ;
 *   · même trace d'exécution (`metadata.traceId`) qu'une génération T6
 *     (`home_mascot_generations.trace_id`) ou qu'une évaluation T6
 *     (`t6_evaluation_runs.trace_id`) ;
 *   · même compte ;
 *   · dates concordantes (génération journalisée au plus 15 min autour de
 *     l'appel ; demande d'évaluation antérieure à l'appel).
 * Sans preuve complète : rien n'est écrit, motif rapporté (« non prouvé »).
 * Jamais d'appel T1 légitime touché (opération T6 exigée), jamais d'appel du
 * nouveau chemin (déjà rattaché à T6), jamais de rapprochement par proximité
 * seule. L'ancienne valeur est CONSERVÉE comme lien de causalité
 * (`metadata.causedByExecutionId`) et dans la trace de l'exécution du
 * rattrapage (`metadata.t6AttributionRepair` : règle, exécution, valeur
 * précédente, date, motif) — restauration exacte par exécution. Idempotent :
 * relancé, rien n'est réécrit (condition sur la valeur précédente).
 */
import { randomUUID } from 'node:crypto';

type Row = Record<string, unknown>;
export type T6RepairQuery = (sql: string, params?: unknown[]) => Promise<Row[]>;

export const T6_ATTRIBUTION_RULE = 't6-attribution-v1' as const;
/** Écart maximal entre l'appel et la ligne de génération qui le prouve. */
const FORMULATE_WINDOW_MINUTES = 15;
const PAGE = 500;

export interface T6AttributionItem {
  usageEventId: number;
  accountId: number | null;
  operation: string;
  traceId: string | null;
  previous: string;
  /** Exécution T6 prouvée (colonne) ; plusieurs (évaluation groupée) : `ids`. */
  next: string | null;
  ids?: string[];
  outcome: 'PROVEN' | 'WRITTEN' | 'UNPROVEN' | 'CHANGED_SINCE';
  reason?: string;
}

export interface T6AttributionReport {
  rule: typeof T6_ATTRIBUTION_RULE;
  action: 'simulate' | 'apply';
  runId: string | null;
  examined: number;
  proven: { formulate: number; evaluate: number };
  written: number;
  unproven: number;
  /** Exécutions d'origine (préfixe) des appels examinés : T1, T2… */
  previousTreatments: Record<string, number>;
  /** Exécutions T6 qui retrouvent leurs appels / exécutions qui les perdent (comptes). */
  executionsGaining: number;
  executionsLosing: number;
  items: T6AttributionItem[];
  more: boolean;
  disabled?: string | null;
}

export interface T6AttributionRestoreReport { runId: string; restored: number; skipped: number; captures: number }

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const prefixe = (id: string) => id.split(':')[0] ?? id;
const ms = (v: unknown): number | null => {
  if (v == null) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};

async function ready(q: T6RepairQuery): Promise<string | null> {
  const [r] = await q(`SELECT
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_usage_event' AND column_name = 'business_execution_id') AS colonne,
      to_regclass('home_mascot_generations') IS NOT NULL AS gen, to_regclass('t6_evaluation_runs') IS NOT NULL AS runs`);
  if (!r?.colonne) return 'colonne business_execution_id absente (migration 0668 non appliquée)';
  if (!r?.gen) return 'journal des générations T6 absent';
  return null;
}

/** Simulation (lecture seule) ou application du rattrapage. Ne lève que sur une base indisponible. */
export async function runT6AttributionRepair(o: {
  q: T6RepairQuery; apply: boolean; accountId?: number | null; reason?: string | null; deadline?: number; log?: (m: string) => void;
}): Promise<T6AttributionReport> {
  const report: T6AttributionReport = {
    rule: T6_ATTRIBUTION_RULE, action: o.apply ? 'apply' : 'simulate', runId: o.apply ? randomUUID() : null,
    examined: 0, proven: { formulate: 0, evaluate: 0 }, written: 0, unproven: 0, previousTreatments: {},
    executionsGaining: 0, executionsLosing: 0, items: [], more: false,
  };
  const off = await ready(o.q);
  if (off) return { ...report, runId: null, disabled: off };
  const gagnent = new Set<string>();
  const perdent = new Set<string>();
  const runsPrets = (await o.q(`SELECT to_regclass('t6_evaluation_runs') IS NOT NULL AS ok`))[0]?.ok === true;
  let curseur = 0;
  for (;;) {
    if (o.deadline && Date.now() > o.deadline) { report.more = true; break; }
    const lignes = await o.q(
      `SELECT e.id, e.account_id, e.operation_type, e.business_execution_id AS prev, e.metadata->>'traceId' AS trace, e.created_at
         FROM ai_usage_event e
        WHERE e.id > $1 AND e.operation_type IN ('t6_formulate', 't6_evaluate')
          AND e.business_execution_id IS NOT NULL
          AND e.business_execution_id NOT LIKE 'T6F:%' AND e.business_execution_id NOT LIKE 'T6E:%'
          AND ($2::int IS NULL OR e.account_id = $2::int)
        ORDER BY e.id LIMIT ${PAGE}`,
      [curseur, o.accountId ?? null],
    );
    if (lignes.length === 0) break;
    curseur = Number(lignes[lignes.length - 1].id);
    for (const l of lignes) {
      report.examined += 1;
      const previous = String(l.prev);
      report.previousTreatments[prefixe(previous)] = (report.previousTreatments[prefixe(previous)] ?? 0) + 1;
      const item: T6AttributionItem = {
        usageEventId: Number(l.id), accountId: l.account_id == null ? null : Number(l.account_id), operation: String(l.operation_type),
        traceId: str(l.trace), previous, next: null, outcome: 'UNPROVEN',
      };
      const preuve = await prove(o.q, item, ms(l.created_at), runsPrets);
      if (!preuve.ok) {
        item.reason = preuve.reason;
        report.unproven += 1;
        report.items.push(item);
        continue;
      }
      item.next = preuve.id;
      if (preuve.ids) item.ids = preuve.ids;
      item.outcome = 'PROVEN';
      if (item.operation === 't6_formulate') report.proven.formulate += 1; else report.proven.evaluate += 1;
      if (o.apply) {
        const ok = await write(o.q, item, report.runId!, o.reason ?? null);
        item.outcome = ok ? 'WRITTEN' : 'CHANGED_SINCE';
        if (ok) report.written += 1;
      }
      for (const x of preuve.ids ?? (preuve.id ? [preuve.id] : [])) gagnent.add(x);
      perdent.add(previous);
      report.items.push(item);
    }
    o.log?.(`${report.examined} appel(s) examiné(s), ${report.proven.formulate + report.proven.evaluate} prouvé(s)${o.apply ? `, ${report.written} rattaché(s)` : ''}`);
    if (lignes.length < PAGE) break;
  }
  report.executionsGaining = gagnent.size;
  report.executionsLosing = perdent.size;
  report.items = report.items.slice(0, 200);
  if (o.apply && report.written === 0) report.runId = null;
  return report;
}

type Preuve = { ok: true; id: string | null; ids?: string[] } | { ok: false; reason: string };

async function prove(q: T6RepairQuery, item: T6AttributionItem, callAt: number | null, runsPrets: boolean): Promise<Preuve> {
  if (!item.traceId) return { ok: false, reason: 'appel sans trace d’exécution' };
  if (item.accountId == null) return { ok: false, reason: 'appel sans compte' };
  if (callAt == null) return { ok: false, reason: 'date de l’appel illisible' };
  if (item.operation === 't6_formulate') {
    const [g] = await q(
      `SELECT created_at FROM home_mascot_generations WHERE trace_id = $1 AND account_id = $2 ORDER BY id LIMIT 1`,
      [item.traceId, item.accountId],
    );
    if (!g) return { ok: false, reason: 'aucune génération T6 du même compte ne porte cette trace' };
    const at = ms(g.created_at);
    if (at == null || Math.abs(at - callAt) > FORMULATE_WINDOW_MINUTES * 60_000) return { ok: false, reason: 'dates discordantes entre l’appel et la génération T6' };
    return { ok: true, id: `T6F:${item.traceId}` };
  }
  if (!runsPrets) return { ok: false, reason: 'table des évaluations T6 absente' };
  const runs = await q(
    `SELECT agenda_item_id, requested_at FROM t6_evaluation_runs WHERE trace_id = $1 AND account_id = $2 ORDER BY agenda_item_id`,
    [item.traceId, item.accountId],
  );
  const valides = runs.filter((r) => { const t = ms(r.requested_at); return t != null && t <= callAt + 60_000; });
  if (valides.length === 0) return { ok: false, reason: runs.length ? 'dates discordantes entre l’appel et la demande d’évaluation' : 'aucune évaluation T6 du même compte ne porte cette trace' };
  const ids = valides.map((r) => `T6E:${Number(r.agenda_item_id)}:${ms(r.requested_at)}`);
  return ids.length === 1 ? { ok: true, id: ids[0] } : { ok: true, id: null, ids };
}

async function write(q: T6RepairQuery, item: T6AttributionItem, runId: string, reason: string | null): Promise<boolean> {
  const trace = { rule: T6_ATTRIBUTION_RULE, runId, previous: item.previous, next: item.next, at: new Date().toISOString(), ...(reason ? { reason: reason.slice(0, 300) } : {}), ...(item.ids ? { addedIds: true } : {}) };
  const r = await q(
    `UPDATE ai_usage_event
        SET business_execution_id = $3,
            metadata = coalesce(metadata, '{}'::jsonb)
              || jsonb_build_object('causedByExecutionId', $2::text, 't6AttributionRepair', $4::jsonb)
              || CASE WHEN $5::jsonb IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('businessExecutionIds', $5::jsonb) END
      WHERE id = $1 AND business_execution_id = $2
      RETURNING id`,
    [item.usageEventId, item.previous, item.next, JSON.stringify(trace), item.ids ? JSON.stringify(item.ids) : null],
  );
  if (r.length === 0) return false;
  // Capture de l'échange : même rattachement (contenu inchangé).
  await q(
    `UPDATE ai_call_captures SET business_execution_id = $3 WHERE usage_event_id = $1 AND business_execution_id = $2`,
    [item.usageEventId, item.previous, item.next],
  ).catch(() => []);
  return true;
}

/** Restauration EXACTE d'une exécution du rattrapage (lignes inchangées depuis). */
export async function restoreT6AttributionRepair(runId: string, q: T6RepairQuery): Promise<T6AttributionRestoreReport> {
  const lignes = await q(
    `SELECT id, business_execution_id AS cur, metadata->'t6AttributionRepair' AS rep FROM ai_usage_event
      WHERE metadata->'t6AttributionRepair'->>'runId' = $1 ORDER BY id`,
    [runId],
  );
  let restored = 0;
  let skipped = 0;
  let captures = 0;
  for (const l of lignes) {
    const rep = (typeof l.rep === 'string' ? JSON.parse(l.rep) : l.rep) as { previous?: string; addedIds?: boolean } | null;
    if (!rep?.previous) { skipped += 1; continue; }
    const r = await q(
      `UPDATE ai_usage_event
          SET business_execution_id = $2,
              metadata = (metadata - 't6AttributionRepair' - 'causedByExecutionId') - CASE WHEN $3::boolean THEN 'businessExecutionIds' ELSE '' END
        WHERE id = $1 AND metadata->'t6AttributionRepair'->>'runId' = $4
          AND business_execution_id IS NOT DISTINCT FROM (metadata->'t6AttributionRepair'->>'next')
        RETURNING id`,
      [Number(l.id), rep.previous, rep.addedIds === true, runId],
    );
    if (r.length === 0) { skipped += 1; continue; }
    restored += 1;
    const c = await q(
      `UPDATE ai_call_captures SET business_execution_id = $2 WHERE usage_event_id = $1 AND business_execution_id IS DISTINCT FROM $2 RETURNING 1`,
      [Number(l.id), rep.previous],
    ).catch(() => []);
    captures += c.length;
  }
  return { runId, restored, skipped, captures };
}
