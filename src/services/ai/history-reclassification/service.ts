/**
 * Reclassement de l'historique et marquage des configurations existantes —
 * lot 89A (CDC Pilotage IA V2, phase P8 : MIG-02, MIG-03, LOG-08, BO-05).
 *
 * Un seul service, appelé par :
 *   · la tâche planifiée `ai-history-reclassification` (AI_PILOTAGE_V2=on) ;
 *   · le rattrapage du BO « IA : reclassement de l'historique » (Exploitation ›
 *     Rattrapages) : Simuler (rien n'est écrit), Appliquer, Restaurer.
 *
 * Garanties :
 *   · NON DESTRUCTIF : les colonnes d'origine des appels et des versions ne
 *     sont jamais modifiées ; le résultat va dans `history_execution_id` /
 *     `history_class` (0776) et `provenance_mark` (0777) ;
 *   · AUCUN ÉCRASEMENT du nouveau chemin : seuls les appels sans
 *     `business_execution_id`, sans liste `metadata.businessExecutionIds`, et
 *     ANTÉRIEURS à la mise en service de la corrélation (application de la
 *     migration 0668) sont examinés ; la condition est revérifiée dans
 *     l'UPDATE lui-même (une écriture concurrente du nouveau chemin gagne) ;
 *   · IDEMPOTENT : un appel déjà classé par la règle courante n'est plus
 *     examiné ; relancé, le service ne réécrit rien ;
 *   · RELANÇABLE par lots bornés (curseur sur l'identifiant, échéance) ;
 *   · RÉVERSIBLE : `restoreHistoryReclassification(runId)` remet les colonnes
 *     à leur état antérieur (classement précédent conservé dans `previous`).
 */
import { pgClient } from '@/db';
import {
  CORRELATION_MIGRATION, HISTORY_RULE_RUN_ID, HISTORY_RULE_VERSION, classifyHistoricalCall, readHistoryClass, withExecutionOutcome,
  type HistoricalCall, type HistoricalLinks, type HistoryClass, type HistoryOutcome,
} from './rule';
import { pilotageV2State, type PilotageV2State } from '../pilotage-v2/activation';

type Row = Record<string, unknown>;
export type Query = (sql: string, params?: unknown[]) => Promise<Row[]>;
const defaultQuery: Query = async (s, p) => (await pgClient.unsafe(s, (p ?? []) as never[])) as unknown as Row[];

/** Migration à partir de laquelle une version de configuration n'est plus « existante » au sens de MIG-02. */
export const PROVENANCE_MIGRATION = '0777_l89a_provenance_configurations_ia.sql' as const;
/** Libellé affiché d'une configuration existante (MIG-02). */
export const MANUAL_NOT_QUALIFIED_LABEL = 'manuel, non qualifié' as const;

export const DEFAULT_BATCH = 500;
/** Plafond d'une simulation (lecture seule, rapport) : au-delà, « reste à examiner ». */
export const SIMULATION_MAX_ROWS = 20_000;
const SAMPLES = 20;

export interface ProvenanceMark {
  rule: string;
  runId: string;
  provenance: 'manual';
  proof: 'not_qualified';
  label: typeof MANUAL_NOT_QUALIFIED_LABEL;
  markedAt: string;
}

/** Lecture tolérante d'une marque stockée (null si absente ou illisible). Pur. */
export function readProvenanceMark(raw: unknown): ProvenanceMark | null {
  const v = typeof raw === 'string' ? (() => { try { return JSON.parse(raw) as unknown; } catch { return null; } })() : raw;
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  return o.provenance === 'manual' && o.proof === 'not_qualified' ? (o as unknown as ProvenanceMark) : null;
}

export interface ReclassificationReport {
  rule: string;
  runId: string;
  applied: boolean;
  pilotageV2: PilotageV2State;
  /** Raison d'un passage sans effet (migrations absentes, date de mise en service inconnue). */
  disabled: string | null;
  /** Mise en service de la corrélation à la source : seuls les appels antérieurs sont examinés. */
  correlationStartedAt: string | null;
  calls: {
    examined: number;
    classified: number;
    /** Écriture refusée par la garde (appel rattaché entre-temps par le nouveau chemin). */
    skippedConcurrent: number;
    byNature: Record<string, number>;
    byTreatment: Record<string, number>;
    byOutcome: Record<string, number>;
    undeterminedReasons: Record<string, number>;
    samples: Array<{ callId: number; nature: string; treatment: string | null; executionId: string | null; outcome: string; reason: string | null }>;
    /** Appels historiques déjà classés par la règle courante (rien à refaire). */
    alreadyClassified: number;
    more: boolean;
  };
  configurations: {
    examined: number;
    marked: number;
    alreadyMarked: number;
    automaticSkipped: number;
    versionIds: number[];
  };
}

export interface ReclassificationOptions {
  apply: boolean;
  deadline?: number;
  batchSize?: number;
  /** Plafond de lignes examinées par passe (défaut : simulation bornée, application illimitée jusqu'à l'échéance). */
  maxRows?: number;
  now?: Date;
  env?: Record<string, string | undefined>;
  q?: Query;
  log?: (m: string) => void;
}

/** Présence des colonnes 0776 / 0777 (jamais d'erreur). */
export async function historyColumnsReady(q: Query = defaultQuery): Promise<{ calls: boolean; configs: boolean }> {
  try {
    const rows = await q(`SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND ((table_name = 'ai_usage_event' AND column_name IN ('history_class', 'history_execution_id'))
           OR (table_name = 'ai_config_versions' AND column_name = 'provenance_mark'))`);
    const has = (t: string, c: string) => rows.some((r) => r.table_name === t && r.column_name === c);
    return { calls: has('ai_usage_event', 'history_class') && has('ai_usage_event', 'history_execution_id'), configs: has('ai_config_versions', 'provenance_mark') };
  } catch {
    return { calls: false, configs: false };
  }
}

async function migrationAppliedAt(q: Query, filename: string): Promise<Date | null> {
  try {
    const r = await q(`SELECT applied_at FROM _migrations WHERE filename = $1`, [filename]);
    return r[0]?.applied_at ? new Date(String(r[0].applied_at)) : null;
  } catch {
    return null;
  }
}

const inc = (o: Record<string, number>, k: string) => { o[k] = (o[k] ?? 0) + 1; };

function corpusAccountId(env: Record<string, string | undefined>): number | null {
  const n = Number(env.CORPUS_ACCOUNT_ID);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Liens persistants des appels d'un lot (chacun vérifié en base). */
async function loadLinks(q: Query, calls: HistoricalCall[], corpus: number | null): Promise<Map<number, HistoricalLinks>> {
  const jobIds = [...new Set(calls.flatMap((c) => (c.jobId !== null ? [c.jobId] : [])))];
  const traces = [...new Set(calls.flatMap((c) => (c.traceId ? [c.traceId] : [])))];
  const jobs = new Map<number, HistoricalLinks['job']>();
  if (jobIds.length) {
    for (const r of await q(`SELECT id, treatment, account_id, target_type, payload->'businessExecution'->>'id' AS be
                               FROM ai_job_queue WHERE id = ANY($1::int[])`, [jobIds])) {
      jobs.set(Number(r.id), {
        id: Number(r.id), treatment: String(r.treatment), accountId: r.account_id == null ? null : Number(r.account_id),
        targetType: r.target_type == null ? null : String(r.target_type),
        businessExecutionId: typeof r.be === 'string' && r.be.startsWith('T1:') ? r.be : null,
      });
    }
  }
  const reports = new Map<string, { id: number; executionId: string }>();
  const generations = new Set<string>();
  const evaluations = new Map<string, { agendaItemId: number; executionId: string }>();
  if (traces.length) {
    for (const r of await q(`
        SELECT r.id, t.trace,
               COALESCE(r.sources->>'businessExecutionId',
                        CASE WHEN j.id IS NOT NULL THEN COALESCE(j.payload->'businessExecution'->>'id', 'T1:job:' || j.id) ELSE 'T1:report:' || r.id END) AS exec_id
          FROM ai_execution_reports r
          LEFT JOIN ai_job_queue j ON j.id = r.job_id
          CROSS JOIN LATERAL unnest(r.trace_ids) AS t(trace)
         WHERE r.treatment = 'T1' AND r.trace_ids && $1::text[] AND t.trace = ANY($1::text[])
         ORDER BY r.created_at, r.id`, [traces])) {
      // Une trace citée par plusieurs rapports : le PREMIER (l'analyse qui a fait l'appel).
      if (!reports.has(String(r.trace))) reports.set(String(r.trace), { id: Number(r.id), executionId: String(r.exec_id) });
    }
    for (const r of await q(`SELECT DISTINCT trace_id FROM home_mascot_generations
                              WHERE trace_id = ANY($1::text[]) AND status IN ('generated', 'validation_failed', 'error')`, [traces])) {
      generations.add(String(r.trace_id));
    }
    const ev = (await q(`SELECT to_regclass('t6_evaluation_runs') IS NOT NULL AS ok`))[0]?.ok;
    if (ev) {
      for (const r of await q(`SELECT agenda_item_id, requested_at, trace_id FROM t6_evaluation_runs WHERE trace_id = ANY($1::text[])`, [traces])) {
        const ms = new Date(String(r.requested_at)).getTime();
        evaluations.set(String(r.trace_id), { agendaItemId: Number(r.agenda_item_id), executionId: `T6E:${Number(r.agenda_item_id)}:${Number.isFinite(ms) ? ms : 0}` });
      }
    }
  }
  const out = new Map<number, HistoricalLinks>();
  for (const c of calls) {
    out.set(c.id, {
      job: c.jobId !== null ? jobs.get(c.jobId) ?? null : null,
      t1Report: c.traceId ? reports.get(c.traceId) ?? null : null,
      t6Generation: c.traceId && generations.has(c.traceId) ? { traceId: c.traceId } : null,
      t6Evaluation: c.traceId ? evaluations.get(c.traceId) ?? null : null,
      corpusAccountId: corpus,
    });
  }
  return out;
}

/**
 * Reclassement de l'historique des appels, puis marquage des configurations
 * existantes. `apply: false` : simulation, rien n'est écrit.
 */
export async function runHistoryReclassification(o: ReclassificationOptions): Promise<ReclassificationReport> {
  const q = o.q ?? defaultQuery;
  const env = o.env ?? process.env;
  const now = o.now ?? new Date();
  const log = o.log ?? (() => {});
  const batch = Math.max(1, Math.min(o.batchSize ?? DEFAULT_BATCH, 2_000));
  const maxRows = o.maxRows ?? (o.apply ? Number.POSITIVE_INFINITY : SIMULATION_MAX_ROWS);
  const deadline = o.deadline ?? Date.now() + 8 * 60_000;
  const report: ReclassificationReport = {
    rule: HISTORY_RULE_VERSION, runId: HISTORY_RULE_RUN_ID, applied: o.apply, pilotageV2: pilotageV2State(env), disabled: null, correlationStartedAt: null,
    calls: { examined: 0, classified: 0, skippedConcurrent: 0, byNature: {}, byTreatment: {}, byOutcome: {}, undeterminedReasons: {}, samples: [], alreadyClassified: 0, more: false },
    configurations: { examined: 0, marked: 0, alreadyMarked: 0, automaticSkipped: 0, versionIds: [] },
  };
  const ready = await historyColumnsReady(q);
  if (!ready.calls || !ready.configs) {
    report.disabled = 'migrations 0776 / 0777 absentes : rien à reclasser';
    return report;
  }
  const cutoff = await migrationAppliedAt(q, CORRELATION_MIGRATION);
  if (!cutoff) {
    report.disabled = `mise en service de la corrélation inconnue (${CORRELATION_MIGRATION} absente du journal des migrations) : aucun appel n'est réputé historique`;
  } else {
    report.correlationStartedAt = cutoff.toISOString();
    await reclassifyCalls(q, o, env, now, cutoff, batch, maxRows, deadline, report, log);
  }
  await markConfigurations(q, o.apply, now, report, log);
  return report;
}

async function reclassifyCalls(
  q: Query, o: ReclassificationOptions, env: Record<string, string | undefined>, now: Date, cutoff: Date,
  batch: number, maxRows: number, deadline: number, report: ReclassificationReport, log: (m: string) => void,
): Promise<void> {
  const r = report.calls;
  const [{ n: deja }] = (await q(`SELECT count(*)::int AS n FROM ai_usage_event
     WHERE created_at < $1::timestamptz AND business_execution_id IS NULL AND history_class->>'rule' = $2`, [cutoff.toISOString(), HISTORY_RULE_VERSION])) as Array<{ n: number }>;
  r.alreadyClassified = Number(deja ?? 0);
  const corpus = corpusAccountId(env);
  const execCache = new Map<string, { outcome: HistoryOutcome; nature: 'BUSINESS' | 'TECHNICAL' } | null>();
  const { getBusinessExecution } = await import('../business-execution/repository');
  let cursor = 0;
  for (;;) {
    if (Date.now() >= deadline || r.examined >= maxRows) { r.more = true; break; }
    const rows = await q(`
      SELECT id, account_id, use_case_code, operation_code, job_id, metadata->>'traceId' AS trace_id, metadata->>'trigger' AS trigger_code, history_class
        FROM ai_usage_event
       WHERE id > $1 AND created_at < $2::timestamptz
         AND business_execution_id IS NULL
         AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'businessExecutionIds')
         AND (history_class IS NULL OR (history_class->>'rule') IS DISTINCT FROM $3)
       ORDER BY id LIMIT $4`, [cursor, cutoff.toISOString(), HISTORY_RULE_VERSION, batch]);
    if (rows.length === 0) break;
    cursor = Number(rows[rows.length - 1].id);
    const calls: HistoricalCall[] = rows.map((x) => ({
      id: Number(x.id), accountId: x.account_id == null ? null : Number(x.account_id),
      useCaseCode: x.use_case_code == null ? null : String(x.use_case_code), operationCode: x.operation_code == null ? null : String(x.operation_code),
      jobId: x.job_id == null ? null : Number(x.job_id), traceId: x.trace_id == null ? null : String(x.trace_id),
      trigger: x.trigger_code == null ? null : String(x.trigger_code),
    }));
    const previous = new Map(rows.map((x) => [Number(x.id), readHistoryClass(x.history_class)]));
    const links = await loadLinks(q, calls, corpus);
    const writes: Array<{ id: number; k: HistoryClass }> = [];
    for (const c of calls) {
      let k = classifyHistoricalCall(c, links.get(c.id)!, now);
      if (k.executionId) {
        if (!execCache.has(k.executionId)) {
          const x = await getBusinessExecution(k.executionId, now, q).catch(() => null);
          execCache.set(k.executionId, x ? { outcome: x.outcome, nature: x.nature } : null);
        }
        k = withExecutionOutcome(k, execCache.get(k.executionId) ?? null);
      }
      const prev = previous.get(c.id);
      if (prev) k = { ...k, previous: { ...prev, previous: undefined } as Omit<HistoryClass, 'previous'> };
      r.examined += 1;
      inc(r.byNature, k.nature);
      inc(r.byTreatment, k.treatment ?? 'non établi');
      inc(r.byOutcome, k.outcome);
      if (k.reason) inc(r.undeterminedReasons, k.reason.replace(/\d+/g, 'N'));
      if (r.samples.length < SAMPLES) r.samples.push({ callId: c.id, nature: k.nature, treatment: k.treatment, executionId: k.executionId, outcome: k.outcome, reason: k.reason });
      writes.push({ id: c.id, k });
    }
    if (o.apply && writes.length) {
      // Garde revérifiée dans l'écriture : jamais un appel du nouveau chemin, jamais deux fois la même règle.
      const done = await q(`
        UPDATE ai_usage_event e SET history_class = w.k, history_execution_id = w.k->>'executionId'
          FROM jsonb_to_recordset($1::jsonb) AS w(id int, k jsonb)
         WHERE e.id = w.id AND e.business_execution_id IS NULL
           AND (e.history_class IS NULL OR (e.history_class->>'rule') IS DISTINCT FROM $2)
        RETURNING e.id`, [JSON.stringify(writes), HISTORY_RULE_VERSION]);
      r.classified += done.length;
      r.skippedConcurrent += writes.length - done.length;
    }
    log(`${r.examined} appel(s) historique(s) examiné(s)${o.apply ? `, ${r.classified} classé(s)` : ''}`);
    if (rows.length < batch) break;
  }
}

async function markConfigurations(q: Query, apply: boolean, now: Date, report: ReclassificationReport, log: (m: string) => void): Promise<void> {
  const c = report.configurations;
  // « Existantes » : créées avant le déploiement de P8 (application de 0777) ; sans date connue, toutes celles d'avant maintenant.
  const cutoff = (await migrationAppliedAt(q, PROVENANCE_MIGRATION)) ?? now;
  const rows = await q(`SELECT id, origin, provenance_mark FROM ai_config_versions WHERE created_at < $1::timestamptz ORDER BY id`, [cutoff.toISOString()]);
  const mark: ProvenanceMark = {
    rule: HISTORY_RULE_VERSION, runId: HISTORY_RULE_RUN_ID, provenance: 'manual', proof: 'not_qualified', label: MANUAL_NOT_QUALIFIED_LABEL, markedAt: now.toISOString(),
  };
  const ids: number[] = [];
  for (const r of rows) {
    c.examined += 1;
    if (String(r.origin ?? 'manual') === 'auto') { c.automaticSkipped += 1; continue; }
    if (r.provenance_mark != null) { c.alreadyMarked += 1; continue; }
    ids.push(Number(r.id));
  }
  if (apply && ids.length) {
    // `updated_at` inchangé : ce n'est pas une modification de configuration (comportement inchangé).
    const done = await q(`UPDATE ai_config_versions SET provenance_mark = $2::jsonb
       WHERE id = ANY($1::int[]) AND provenance_mark IS NULL AND origin IS DISTINCT FROM 'auto' RETURNING id`, [ids, JSON.stringify(mark)]);
    c.marked = done.length;
    c.versionIds = done.map((x) => Number(x.id)).sort((a, b) => a - b);
  } else {
    c.versionIds = ids;
    if (!apply) c.marked = 0;
  }
  log(`${c.examined} version(s) de configuration examinée(s), ${apply ? c.marked : ids.length} ${apply ? 'marquée(s)' : 'à marquer'} « ${MANUAL_NOT_QUALIFIED_LABEL} »`);
}

export interface ReclassificationRestoreReport {
  runId: string;
  callsRestored: number;
  configurationsRestored: number;
}

/**
 * Annulation d'un reclassement (retour arrière, LIV-02) : chaque appel classé
 * par cette exécution reprend son classement précédent (ou aucun) ; chaque
 * version marquée perd sa marque. Traces d'origine jamais touchées. Par lots.
 */
export async function restoreHistoryReclassification(runId: string, opts: { q?: Query; log?: (m: string) => void } = {}): Promise<ReclassificationRestoreReport> {
  const q = opts.q ?? defaultQuery;
  const log = opts.log ?? (() => {});
  const out: ReclassificationRestoreReport = { runId, callsRestored: 0, configurationsRestored: 0 };
  const ready = await historyColumnsReady(q);
  if (ready.calls) {
    for (;;) {
      const done = await q(`
        WITH c AS (SELECT id FROM ai_usage_event WHERE history_class IS NOT NULL AND history_class->>'runId' = $1 ORDER BY id LIMIT 2000)
        UPDATE ai_usage_event e
           SET history_class = CASE WHEN jsonb_typeof(e.history_class->'previous') = 'object' THEN e.history_class->'previous' END,
               history_execution_id = CASE WHEN jsonb_typeof(e.history_class->'previous') = 'object' THEN e.history_class->'previous'->>'executionId' END
          FROM c WHERE e.id = c.id RETURNING e.id`, [runId]);
      out.callsRestored += done.length;
      if (done.length === 0) break;
      log(`${out.callsRestored} appel(s) remis dans leur état antérieur`);
    }
  }
  if (ready.configs) {
    const done = await q(`UPDATE ai_config_versions SET provenance_mark = NULL WHERE provenance_mark->>'runId' = $1 RETURNING id`, [runId]);
    out.configurationsRestored = done.length;
  }
  log(`restauration : ${out.callsRestored} appel(s), ${out.configurationsRestored} version(s)`);
  return out;
}
