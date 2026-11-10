/**
 * Rattrapage « IA : origine des coûts » — lot 113AF (Trello #730, §3 C).
 * Lancé UNIQUEMENT depuis BO › Exploitation › Rattrapages (Simuler, Appliquer
 * avec motif, Restaurer avec l'identifiant donné par le rapport) ; jamais
 * automatiquement.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI EST FAIT
 *
 * Les traces (`ai_usage_event`) et agrégats journaliers (`ai_usage_daily_rollup`)
 * écrits AVANT la migration 1610 n'ont pas d'origine de coût persistée. Le
 * rattrapage leur applique la règle UNIQUE (`cost-classification.ts`, la même
 * qu'à la source et qu'à la lecture), à partir des seules données PERSISTÉES
 * (compte, usage, étape, métadonnées shadow / déclencheur / essai, marqueur du
 * compte technique, ancien `is_billable` pour une étape hors registre) :
 *   · coût lu tel qu'il a été figé à l'appel, correction de régularisation
 *     ACTIVE comprise (#670 / #713, lot 109L / 113O) — jamais recalculé, jamais
 *     au tarif actuel ;
 *   · sans élément fiable : « non déterminable », signalé (jamais deviné) ;
 *   · aucun appel IA, aucune réanalyse, aucun changement de prompt, de modèle,
 *     de tarif, de quota ou d'`is_billable`.
 *
 * GARANTIES
 *   · IDEMPOTENT : seules les lignes sans origine sont écrites, condition
 *     revérifiée dans l'UPDATE ; relancé, rien n'est réécrit ;
 *   · AUDITÉ : motif et auteur journalisés par l'exécuteur du BO ; chaque
 *     ligne porte la règle, la raison, l'exécution et l'ancien `is_billable`
 *     (`cost_class`) ;
 *   · RÉVERSIBLE : `restoreCostClassification(runId)` remet les seules lignes
 *     de cette exécution sans origine (la lecture les classe alors par la même
 *     règle) ;
 *   · RÉCONCILIÉ : rapport avant / après (ancien booléen ↔ origine), totaux
 *     identiques (aucune perte), chevauchement traces ↔ agrégats journaliers
 *     (double comptage) et total du rapport des coûts comparés.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { randomUUID } from 'node:crypto';
import {
  COST_CLASSIFICATION_VERSION, COST_ORIGINS, costOriginSql, costReasonSql, type CostOrigin,
} from './cost-classification';
import { unknownCostSql } from '../telemetry/cost-status';

type Row = Record<string, unknown>;
export type Query = (sql: string, params?: unknown[]) => Promise<Row[]>;

export const COST_BACKFILL_BATCH = 2_000;
const SAMPLES = 20;

/** Une ligne de l'état agrégé (pur). */
export interface SnapshotGroup {
  kind: 'event' | 'rollup';
  origin: CostOrigin;
  reason: string;
  legacyBillable: boolean;
  pending: boolean;
  rows: number;
  calls: number;
  micros: number;
  unknownCalls: number;
}

interface Amount { rows: number; calls: number; micros: number }
const zero = (): Amount => ({ rows: 0, calls: 0, micros: 0 });
const add = (a: Amount, g: SnapshotGroup) => { a.rows += g.rows; a.calls += g.calls; a.micros += g.micros; };

export interface CostClassificationState {
  /** Ancienne lecture : `is_billable` vrai = « métier », faux = « technique ». */
  before: { business: Amount; technical: Amount; total: Amount };
  /** Lecture par origine (persistée sinon déduite par la même règle). */
  after: Record<CostOrigin, Amount> & { total: Amount };
  /** Métier reclassé : l'ancien booléen le rangeait en technique. */
  reclassifiedToBusiness: Amount;
  /** Technique réel que l'ancien booléen comptait en métier (corpus, qualification…). */
  movedToTechnical: Amount;
  /** Appels au coût INCONNU (jamais comptés zéro), par origine. */
  unknownCalls: Record<CostOrigin, number>;
  /** Lignes sans origine persistée (à figer par l'application). */
  pending: { events: number; rollups: number; byOrigin: Record<CostOrigin, number> };
  byReason: Record<string, Amount>;
}

/** Synthèse pure d'un état agrégé (testée sans base). */
export function summarizeState(groups: readonly SnapshotGroup[]): CostClassificationState {
  const by = () => Object.fromEntries(COST_ORIGINS.map((o) => [o, zero()])) as Record<CostOrigin, Amount>;
  const s: CostClassificationState = {
    before: { business: zero(), technical: zero(), total: zero() },
    after: { ...by(), total: zero() },
    reclassifiedToBusiness: zero(),
    movedToTechnical: zero(),
    unknownCalls: Object.fromEntries(COST_ORIGINS.map((o) => [o, 0])) as Record<CostOrigin, number>,
    pending: { events: 0, rollups: 0, byOrigin: Object.fromEntries(COST_ORIGINS.map((o) => [o, 0])) as Record<CostOrigin, number> },
    byReason: {},
  };
  for (const g of groups) {
    add(g.legacyBillable ? s.before.business : s.before.technical, g);
    add(s.before.total, g);
    add(s.after[g.origin] ?? (s.after[g.origin] = zero()), g);
    add(s.after.total, g);
    add(s.byReason[`${g.origin}:${g.reason}`] ??= zero(), g);
    if (!g.legacyBillable && g.origin === 'ACCOUNT_SERVICE') add(s.reclassifiedToBusiness, g);
    if (g.legacyBillable && (g.origin === 'TECHNICAL' || g.origin === 'SHADOW')) add(s.movedToTechnical, g);
    s.unknownCalls[g.origin] = (s.unknownCalls[g.origin] ?? 0) + g.unknownCalls;
    if (g.pending) {
      if (g.kind === 'event') s.pending.events += g.rows; else s.pending.rollups += g.rows;
      s.pending.byOrigin[g.origin] = (s.pending.byOrigin[g.origin] ?? 0) + g.rows;
    }
  }
  return s;
}

/** Colonnes 1610 présentes sur les deux tables ? */
async function columnsReady(q: Query): Promise<boolean> {
  const [r] = await q(`SELECT COUNT(*)::int AS n FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name IN ('ai_usage_event', 'ai_usage_daily_rollup')
       AND column_name IN ('cost_origin', 'cost_imputable', 'cost_class')`);
  return Number(r?.n ?? 0) === 6;
}

/** État agrégé (lecture seule) : coût effectif, ancien booléen, origine, raison, en attente. */
export async function readState(q: Query): Promise<SnapshotGroup[]> {
  const rows = await q(`
    SELECT 'event' AS kind, ${costOriginSql('u')} AS origin, ${costReasonSql('u')} AS reason, u.is_billable AS b,
           (u.cost_origin IS NULL) AS pending, COUNT(*)::int AS nrows, COUNT(*)::int AS calls,
           COALESCE(SUM(COALESCE(c.corrected_cost_micros, u.cost_micros)), 0)::bigint AS micros,
           COUNT(*) FILTER (WHERE c.id IS NULL AND ${unknownCostSql('u')})::int AS unknown
      FROM ai_usage_event u
      LEFT JOIN ai_cost_corrections c ON c.target_kind = 'event' AND c.target_id = u.id AND c.reverted_at IS NULL
     GROUP BY 1, 2, 3, 4, 5
    UNION ALL
    SELECT 'rollup', ${costOriginSql('r', { kind: 'rollup' })}, ${costReasonSql('r', { kind: 'rollup' })}, r.is_billable,
           (r.cost_origin IS NULL), COUNT(*)::int, COALESCE(SUM(r.calls), 0)::int,
           COALESCE(SUM(COALESCE(rc.corrected_cost_micros, r.cost_micros)), 0)::bigint,
           COALESCE(SUM(CASE WHEN rc.id IS NULL THEN r.unpriced_calls ELSE 0 END), 0)::int
      FROM ai_usage_daily_rollup r
      LEFT JOIN ai_cost_corrections rc ON rc.target_kind = 'rollup' AND rc.target_id = r.id AND rc.reverted_at IS NULL
     GROUP BY 1, 2, 3, 4, 5`);
  return rows.map((r) => ({
    kind: String(r.kind) as 'event' | 'rollup', origin: String(r.origin) as CostOrigin, reason: String(r.reason),
    legacyBillable: Boolean(r.b), pending: Boolean(r.pending), rows: Number(r.nrows), calls: Number(r.calls),
    micros: Number(r.micros), unknownCalls: Number(r.unknown),
  }));
}

/**
 * Double comptage traces ↔ agrégats : un appel encore en base ne doit pas
 * être AUSSI résumé dans un agrégat journalier (archive antérieure au lot 82C
 * dont les lignes ont été supprimées). Rend les appels concernés (attendu : 0).
 */
async function overlap(q: Query): Promise<{ calls: number; micros: number; days: string[] }> {
  try {
    const rows = await q(`
      SELECT to_char((u.created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day, COUNT(*)::int AS n,
             COALESCE(SUM(u.cost_micros), 0)::bigint AS micros
        FROM ai_usage_event u
        JOIN ai_log_archives a ON a.source_table = 'ai_usage_event'
                              AND NOT COALESCE((to_jsonb(a) ->> 'source_rows_kept')::boolean, false)
                              AND u.id BETWEEN a.min_id AND a.max_id
       WHERE EXISTS (SELECT 1 FROM ai_usage_daily_rollup r WHERE r.day = (u.created_at AT TIME ZONE 'UTC')::date)
       GROUP BY 1 ORDER BY 1 LIMIT 100`);
    return {
      calls: rows.reduce((n, r) => n + Number(r.n), 0), micros: rows.reduce((n, r) => n + Number(r.micros), 0),
      days: rows.map((r) => String(r.day)),
    };
  } catch {
    return { calls: 0, micros: 0, days: [] };
  }
}

async function nonClassifiableSamples(q: Query): Promise<string[]> {
  const ev = await q(`
    SELECT u.id, to_char(u.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, u.use_case_code, COALESCE(u.operation_code, u.operation_type) AS op, u.account_id
      FROM ai_usage_event u WHERE ${costOriginSql('u')} = 'UNDETERMINED' ORDER BY u.id DESC LIMIT ${SAMPLES}`);
  const ro = await q(`
    SELECT r.id, to_char(r.day, 'YYYY-MM-DD') AS day, r.use_case_code, r.account_id, r.calls
      FROM ai_usage_daily_rollup r WHERE ${costOriginSql('r', { kind: 'rollup' })} = 'UNDETERMINED' ORDER BY r.id DESC LIMIT ${SAMPLES}`);
  return [
    ...ev.map((r) => `appel ${String(r.id)} · ${String(r.day)} · ${String(r.use_case_code ?? '—')} · ${String(r.op ?? '—')} · compte ${String(r.account_id ?? '—')}`),
    ...ro.map((r) => `agrégat ${String(r.id)} · ${String(r.day)} · ${String(r.use_case_code ?? '—')} · compte ${String(r.account_id ?? '—')} · ${String(r.calls)} appel(s)`),
  ].slice(0, SAMPLES);
}

export interface Reconciliation {
  /** Total avant (ancien booléen) = total après (origine) : aucun appel perdu ni ajouté. */
  totalsMatch: boolean;
  before: Amount;
  after: Amount;
  /** Appels encore en base ET résumés dans un agrégat journalier (attendu : 0). */
  overlap: { calls: number; micros: number; days: string[] };
  /** Rapport BO › Coûts IA sur tout l'historique : même total et mêmes appels ? */
  costReport: { providerMicros: number; calls: number; matches: boolean } | null;
}

export interface CostClassificationReport {
  rule: string;
  mode: 'simulate' | 'apply';
  /** Identifiant d'exécution (application) — à fournir pour « Restaurer ». */
  runId: string | null;
  disabled: string | null;
  before: CostClassificationState | null;
  after: CostClassificationState | null;
  written: { events: number; rollups: number; byOrigin: Record<string, number> };
  /** Temps imparti écoulé : relancer (rien n'est réécrit). */
  more: boolean;
  nonClassifiable: { rows: number; calls: number; micros: number; samples: string[] };
  reconciliation: Reconciliation | null;
}

export interface CostBackfillOptions {
  apply: boolean;
  q: Query;
  deadline?: number;
  batch?: number;
  log?: (m: string) => void;
  /** Totaux du rapport des coûts sur tout l'historique (réconciliation) — injecté par l'exécuteur. */
  costReportTotals?: () => Promise<{ providerMicros: number; calls: number }>;
}

/** Applique la règle aux lignes sans origine, par lots (une table). Rend le nombre écrit par origine. */
async function classifyTable(o: CostBackfillOptions, kind: 'event' | 'rollup', runId: string, out: Record<string, number>): Promise<{ written: number; more: boolean }> {
  const table = kind === 'event' ? 'ai_usage_event' : 'ai_usage_daily_rollup';
  const a = kind === 'event' ? 'u' : 'r';
  const batch = Math.max(1, o.batch ?? COST_BACKFILL_BATCH);
  let cursor = 0;
  let written = 0;
  for (;;) {
    if (o.deadline && Date.now() > o.deadline) return { written, more: true };
    const rows = await o.q(`
      WITH x AS (
        SELECT ${a}.id, ${costOriginSql(a, { kind, persisted: false })} AS o, ${costReasonSql(a, { kind, persisted: false })} AS rs, ${a}.is_billable AS b
          FROM ${table} ${a}
         WHERE ${a}.cost_origin IS NULL AND ${a}.id > $1
         ORDER BY ${a}.id LIMIT $2
      ), upd AS (
        UPDATE ${table} t
           SET cost_origin = x.o, cost_imputable = (x.o = 'ACCOUNT_SERVICE'),
               cost_class = jsonb_build_object('rule', $3::text, 'reason', x.rs, 'source', 'backfill', 'runId', $4::text,
                                               'legacyBillable', x.b, 'at', now())
          FROM x WHERE t.id = x.id AND t.cost_origin IS NULL
        RETURNING t.id, t.cost_origin
      )
      SELECT (SELECT MAX(id) FROM x) AS last, (SELECT COUNT(*) FROM x)::int AS seen,
             upd.cost_origin AS origin, COUNT(upd.id)::int AS n
        FROM upd GROUP BY upd.cost_origin
      UNION ALL
      SELECT (SELECT MAX(id) FROM x), (SELECT COUNT(*) FROM x)::int, NULL, 0
       WHERE NOT EXISTS (SELECT 1 FROM upd)`,
      [cursor, batch, COST_CLASSIFICATION_VERSION, runId]);
    const seen = Number(rows[0]?.seen ?? 0);
    if (seen === 0) return { written, more: false };
    for (const r of rows) {
      if (r.origin == null) continue;
      written += Number(r.n);
      out[String(r.origin)] = (out[String(r.origin)] ?? 0) + Number(r.n);
    }
    cursor = Number(rows[0]?.last ?? cursor);
    o.log?.(`${kind === 'event' ? 'appels' : 'agrégats'} : ${written} classé(s) (jusqu’à l’identifiant ${cursor})`);
    if (seen < batch) return { written, more: false };
  }
}

async function reconcile(o: CostBackfillOptions, st: CostClassificationState): Promise<Reconciliation> {
  const ov = await overlap(o.q);
  let costReport: Reconciliation['costReport'] = null;
  if (o.costReportTotals) {
    try {
      const t = await o.costReportTotals();
      costReport = { ...t, matches: t.providerMicros === st.after.total.micros && t.calls === st.after.total.calls };
    } catch {
      costReport = null;
    }
  }
  return {
    totalsMatch: st.before.total.micros === st.after.total.micros && st.before.total.calls === st.after.total.calls,
    before: st.before.total, after: st.after.total, overlap: ov, costReport,
  };
}

/**
 * Simulation (rien n'est écrit) ou application (lignes sans origine figées,
 * par lots, idempotente). Rapport avant / après et réconciliation.
 */
export async function runCostClassificationBackfill(o: CostBackfillOptions): Promise<CostClassificationReport> {
  const base: CostClassificationReport = {
    rule: COST_CLASSIFICATION_VERSION, mode: o.apply ? 'apply' : 'simulate', runId: null, disabled: null,
    before: null, after: null, written: { events: 0, rollups: 0, byOrigin: {} }, more: false,
    nonClassifiable: { rows: 0, calls: 0, micros: 0, samples: [] }, reconciliation: null,
  };
  if (!(await columnsReady(o.q))) return { ...base, disabled: 'migration 1610 non appliquée (colonnes cost_origin / cost_imputable / cost_class absentes)' };
  const before = summarizeState(await readState(o.q));
  let after = before;
  if (o.apply) {
    const runId = randomUUID();
    base.runId = runId;
    const ev = await classifyTable(o, 'event', runId, base.written.byOrigin);
    base.written.events = ev.written;
    const ro = ev.more ? { written: 0, more: true } : await classifyTable(o, 'rollup', runId, base.written.byOrigin);
    base.written.rollups = ro.written;
    base.more = ev.more || ro.more;
    after = summarizeState(await readState(o.q));
  }
  const nd = after.after.UNDETERMINED;
  return {
    ...base, before, after,
    nonClassifiable: { ...nd, samples: nd.rows > 0 ? await nonClassifiableSamples(o.q) : [] },
    reconciliation: await reconcile(o, after),
  };
}

export interface CostClassificationRestoreReport { runId: string; events: number; rollups: number }

/** Retire le classement écrit par UNE exécution du rattrapage (les écritures à la source ne sont jamais touchées). */
export async function restoreCostClassification(runId: string, q: Query): Promise<CostClassificationRestoreReport> {
  const undo = async (table: string) => Number((await q(`
    WITH r AS (
      UPDATE ${table} SET cost_origin = NULL, cost_imputable = NULL, cost_class = NULL
       WHERE cost_class->>'source' = 'backfill' AND cost_class->>'runId' = $1
      RETURNING 1)
    SELECT COUNT(*)::int AS n FROM r`, [runId]))[0]?.n ?? 0);
  return { runId, events: await undo('ai_usage_event'), rollups: await undo('ai_usage_daily_rollup') };
}
