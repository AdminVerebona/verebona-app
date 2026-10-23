/**
 * Projection « exécution métier » — lecture des états NATIFS et qualification
 * (lot 83C, CDC Pilotage IA V2 P2). Lecture seule : aucune écriture, aucune
 * table propre (voir `types.ts`).
 *
 * Période (SEM-02, BO-05) : une exécution appartient à [from, to[ selon sa
 * date de référence (`mapping#referenceAt` : fin si finale, sinon dernière
 * activité). La même règle sert aux récapitulatifs, aux listes et au détail.
 *
 * Volume : la lecture d'une période est bornée par traitement
 * (`PROJECTION_ROW_CAP`) ; un dépassement est SIGNALÉ (`truncated`), jamais
 * tu. Les exports volumineux relèvent de la phase P3 (collecteur 77C).
 */
import { pgClient } from '@/db';
import { getAssistantConfig } from '@/services/verebona-assistant/config/assistant-config';
import {
  executionIdOfJob, parseExecutionId, t1LegacyJobExecutionId, t1LegacyReportExecutionId,
  t2ExecutionId, t6EvaluateExecutionId, t6FormulateExecutionId, jobExecutionId,
} from './identity';
import {
  inPeriod, latest, qualifyT1, qualifyT2, qualifyT3, qualifyT4, qualifyT6Evaluate, qualifyT6Formulate, referenceAt,
  type JobState, type T1CoverageState, type T1ReportState, type T3ReportState,
} from './mapping';
import type {
  BusinessExecution, BusinessNature, BusinessOrigin, BusinessOutcome, BusinessTreatment, Qualification, TreatmentSummary,
} from './types';
import { BUSINESS_TREATMENTS } from './types';

type Row = Record<string, unknown>;
export type Query = (sql: string, params?: unknown[]) => Promise<Row[]>;
const defaultQuery: Query = async (s, p) => (await pgClient.unsafe(s, (p ?? []) as never[])) as unknown as Row[];

/** Lignes natives lues au plus par traitement et par période. */
export const PROJECTION_ROW_CAP = 20_000;

const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const date = (v: unknown): Date | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d : null;
};
const json = <T>(v: unknown): T | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') { try { return JSON.parse(v) as T; } catch { return null; } }
  return v as T;
};

// ══════════════════════════════════════════════════════════════════════════
// Origine (SEM-06) et nature
// ══════════════════════════════════════════════════════════════════════════

const ORIGINES_UTILISATEUR = ['files/confirm', 'source_uploaded', 'documents/analyze', 'documents/analyze-batch', 'documents/PUT', 'documents/bulk-move'];
const ORIGINES_REPRISE = ['analysis-recovery', 't1-invalid-output-replay', 't1-completeness-retry'];

/** Origine d'une exécution T1 d'après son premier enregistrement (pure). */
export function t1Origin(p: { jobOrigin?: string | null; origin?: string | null; trigger?: string | null }): BusinessOrigin {
  if (p.jobOrigin === 'manual') return 'ADMIN';
  const o = p.origin ?? p.trigger ?? '';
  if (!o) return 'UNKNOWN';
  if (o === 'corpus-pipeline') return 'TEST';
  if (o.endsWith(':reprise') || ORIGINES_REPRISE.includes(o)) return 'RESUME';
  if (ORIGINES_UTILISATEUR.includes(o)) return 'USER';
  return 'AUTOMATIC';
}

/** Origine d'un travail T3 / T4 (pure). */
function jobOrigin(origin: string | null, trigger: string | null): BusinessOrigin {
  if (origin === 'manual') return 'ADMIN';
  return trigger ? 'AUTOMATIC' : 'UNKNOWN';
}

// ══════════════════════════════════════════════════════════════════════════
// Lecture native → JobState
// ══════════════════════════════════════════════════════════════════════════

const JOB_COLS = `j.id, j.treatment, j.account_id, j.target_type, j.target_id, j.status, j.origin, j.trigger_code, j.attempts,
  j.last_error, j.business_result, j.business_result_detail, j.created_at, j.started_at, j.finished_at, j.available_at, j.payload`;

function toJobState(r: Row): JobState & { treatment: string; accountId: number | null; targetType: string | null; targetId: string | null; origin: string | null; triggerCode: string | null; payload: Record<string, unknown> | null } {
  const payload = json<Record<string, unknown>>(r.payload);
  return {
    id: num(r.id), treatment: String(r.treatment), accountId: numOrNull(r.account_id), targetType: str(r.target_type), targetId: str(r.target_id),
    status: String(r.status), attempts: num(r.attempts ?? 0), lastError: str(r.last_error), businessResult: str(r.business_result),
    businessResultDetail: json<Record<string, unknown>>(r.business_result_detail), createdAt: date(r.created_at) ?? new Date(0),
    startedAt: date(r.started_at), finishedAt: date(r.finished_at), availableAt: date(r.available_at),
    costCapDeferredUntil: typeof payload?.costCapDeferredUntil === 'string' ? payload.costCapDeferredUntil : null,
    origin: str(r.origin), triggerCode: str(r.trigger_code), payload,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// T1 — document logique (décision PO 04)
// ══════════════════════════════════════════════════════════════════════════

const T1_EXEC_OF_JOB = `COALESCE(j.payload->'businessExecution'->>'id', 'T1:job:' || j.id)`;
const T1_EXEC_OF_REPORT = `COALESCE(r.sources->>'businessExecutionId', CASE WHEN j.id IS NOT NULL THEN ${T1_EXEC_OF_JOB} ELSE 'T1:report:' || r.id END)`;

/** Exécutions T1 ayant une activité dans la période (sur-ensemble, affiné après qualification). */
async function t1CandidateIds(q: Query, from: Date, to: Date, accountId: number | null): Promise<{ ids: string[]; truncated: boolean }> {
  const acc = accountId === null ? '' : 'AND j.account_id = $3';
  const accR = accountId === null ? '' : 'AND r.account_id = $3';
  const accC = accountId === null ? '' : 'AND c.account_id = $3';
  const params: unknown[] = [from.toISOString(), to.toISOString(), ...(accountId === null ? [] : [accountId])];
  const rows = await q(`
    SELECT id FROM (
      SELECT ${T1_EXEC_OF_JOB} AS id FROM ai_job_queue j
       WHERE j.treatment = 'T1' AND j.target_type = 'asset_file' AND j.account_id IS NOT NULL ${acc}
         AND COALESCE(j.finished_at, j.started_at, j.created_at) >= $1::timestamptz AND j.created_at < $2::timestamptz
      UNION
      SELECT ${T1_EXEC_OF_REPORT} AS id FROM ai_execution_reports r LEFT JOIN ai_job_queue j ON j.id = r.job_id
       WHERE r.treatment = 'T1' ${accR} AND r.created_at >= $1::timestamptz AND r.created_at < $2::timestamptz
      UNION
      SELECT (SELECT ${T1_EXEC_OF_REPORT} FROM ai_execution_reports r LEFT JOIN ai_job_queue j ON j.id = r.job_id
               WHERE r.treatment = 'T1' AND r.account_id = c.account_id AND r.file_id = c.file_id
               ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS id
        FROM document_extraction_coverage c
       WHERE c.updated_at >= $1::timestamptz AND c.updated_at < $2::timestamptz ${accC}
    ) x WHERE id IS NOT NULL LIMIT ${PROJECTION_ROW_CAP + 1}`, params);
  const ids = rows.map((r) => String(r.id));
  return { ids: ids.slice(0, PROJECTION_ROW_CAP), truncated: ids.length > PROJECTION_ROW_CAP };
}

interface T1Bundle {
  id: string;
  jobs: ReturnType<typeof toJobState>[];
  reports: Array<T1ReportState & { accountId: number; fileId: number | null; jobId: number | null; traceIds: string[]; origin: string | null; trigger: string | null; startedAt: Date | null }>;
}

/** Travaux et rapports de chaque exécution T1 (reprises comprises). */
async function loadT1Bundles(q: Query, ids: readonly string[]): Promise<Map<string, T1Bundle>> {
  const out = new Map<string, T1Bundle>();
  if (ids.length === 0) return out;
  const legacyJobs = ids.map((i) => parseExecutionId(i)).flatMap((p) => (p && p.treatment === 'T1' && 'kind' in p && p.kind === 'job' ? [p.jobId] : []));
  const legacyReports = ids.map((i) => parseExecutionId(i)).flatMap((p) => (p && p.treatment === 'T1' && 'kind' in p && p.kind === 'report' ? [p.reportId] : []));
  const get = (id: string): T1Bundle => {
    let b = out.get(id);
    if (!b) { b = { id, jobs: [], reports: [] }; out.set(id, b); }
    return b;
  };
  const jobs = await q(`
    SELECT ${JOB_COLS}, ${T1_EXEC_OF_JOB} AS exec_id FROM ai_job_queue j
     WHERE j.treatment = 'T1' AND j.target_type = 'asset_file' AND j.payload ? 'businessExecution'
       AND (j.payload->'businessExecution'->>'id') = ANY($1::text[])
    UNION
    SELECT ${JOB_COLS}, ${T1_EXEC_OF_JOB} AS exec_id FROM ai_job_queue j
     WHERE j.treatment = 'T1' AND j.target_type = 'asset_file' AND j.id = ANY($2::int[]) AND NOT (j.payload ? 'businessExecution')
    ORDER BY created_at, id`, [[...ids], legacyJobs]);
  for (const r of jobs) {
    const id = String(r.exec_id);
    if (ids.includes(id)) get(id).jobs.push(toJobState(r));
  }
  const jobIds = [...out.values()].flatMap((b) => b.jobs.map((j) => j.id));
  const reports = await q(`
    SELECT r.id, r.account_id, r.file_id, r.job_id, r.status, r.created_at, r.started_at, r.steps, r.trace_ids, r.trigger_code,
           r.sources->>'businessExecutionOrigin' AS origin, ${T1_EXEC_OF_REPORT} AS exec_id, cov.value AS cov_value, cov.links AS cov_links
      FROM ai_execution_reports r
      LEFT JOIN ai_job_queue j ON j.id = r.job_id
      LEFT JOIN LATERAL (
        SELECT e.value, e.links FROM ai_execution_report_entries e
         WHERE e.report_id = COALESCE(r.entries_report_id, r.id) AND e.section = 'COVERAGE' LIMIT 1
      ) cov ON TRUE
     WHERE r.treatment = 'T1' AND (
       (r.sources ? 'businessExecutionId' AND (r.sources->>'businessExecutionId') = ANY($1::text[]))
       OR (r.job_id = ANY($2::int[]) AND NOT (r.sources ? 'businessExecutionId'))
       OR r.id = ANY($3::bigint[]))
     ORDER BY r.created_at, r.id`, [[...ids], jobIds, legacyReports]);
  for (const r of reports) {
    const id = String(r.exec_id);
    if (!ids.includes(id)) continue;
    const steps = json<Array<{ step?: string; status?: string }>>(r.steps) ?? [];
    const links = json<{ anomalies?: string[] }>(r.cov_links);
    // Valeur JSONB scalaire (« COMPLETE ») : rendue telle quelle par le pilote, jamais re-analysée.
    const covValue = typeof r.cov_value === 'string' && r.cov_value.startsWith('"') ? json<unknown>(r.cov_value) : r.cov_value;
    get(id).reports.push({
      id: num(r.id), accountId: num(r.account_id), fileId: numOrNull(r.file_id), jobId: numOrNull(r.job_id),
      status: String(r.status), createdAt: date(r.created_at) ?? new Date(0), startedAt: date(r.started_at),
      failedSteps: steps.filter((s) => s.status === 'FAILED' && s.step && !String(s.step).startsWith('RELECTURE')).map((s) => String(s.step)),
      coverageQuality: typeof covValue === 'string' ? covValue : null,
      coverageAnomalies: Array.isArray(links?.anomalies) ? links!.anomalies.map(String) : null,
      traceIds: Array.isArray(r.trace_ids) ? (r.trace_ids as unknown[]).map(String) : [],
      origin: str(r.origin), trigger: str(r.trigger_code),
    });
  }
  return out;
}

/** Fichier cible d'une exécution T1, et document logique (source principale, PO 04). */
function t1FileOf(b: T1Bundle): { accountId: number | null; fileId: number | null } {
  const rep = b.reports.find((r) => r.fileId !== null);
  if (rep) return { accountId: rep.accountId, fileId: rep.fileId };
  const job = b.jobs[0];
  return { accountId: job?.accountId ?? null, fileId: job?.targetId ? Number(job.targetId) : null };
}

async function qualifyT1Bundles(q: Query, bundles: Map<string, T1Bundle>, now: Date): Promise<BusinessExecution[]> {
  const liste = [...bundles.values()].filter((b) => b.jobs.length > 0 || b.reports.length > 0);
  const fileIds = [...new Set(liste.map((b) => t1FileOf(b).fileId).filter((x): x is number => x !== null))];
  const files = new Map<number, { analysisState: string | null; deleted: boolean; lead: number }>();
  const coverage = new Map<number, T1CoverageState>();
  const dernierRapport = new Map<number, number>();
  const dernierTravail = new Map<number, number>();
  if (fileIds.length > 0) {
    for (const r of await q(`SELECT id, analysis_state, deleted_at, grouped_into_file_id FROM asset_files WHERE id = ANY($1::int[])`, [fileIds])) {
      files.set(num(r.id), { analysisState: str(r.analysis_state), deleted: r.deleted_at != null && r.grouped_into_file_id == null, lead: numOrNull(r.grouped_into_file_id) ?? num(r.id) });
    }
    for (const r of await q(`SELECT file_id, quality_state, anomalies, next_retry_at, updated_at, unresolved_units, uncertain_units, failed_units, dropped_facts_count
                               FROM document_extraction_coverage WHERE file_id = ANY($1::int[])`, [fileIds])) {
      coverage.set(num(r.file_id), {
        qualityState: String(r.quality_state), anomalies: Array.isArray(r.anomalies) ? (r.anomalies as unknown[]).map(String) : [],
        nextRetryAt: date(r.next_retry_at), updatedAt: date(r.updated_at) ?? new Date(0),
        unresolvedUnits: num(r.unresolved_units ?? 0), uncertainUnits: num(r.uncertain_units ?? 0), failedUnits: num(r.failed_units ?? 0), droppedFacts: num(r.dropped_facts_count ?? 0),
      });
    }
    // Dernière analyse de chaque document : seule elle est jugée sur la couverture COURANTE.
    for (const r of await q(`SELECT DISTINCT ON (file_id) file_id, id FROM ai_execution_reports WHERE treatment = 'T1' AND file_id = ANY($1::int[]) ORDER BY file_id, created_at DESC, id DESC`, [fileIds])) {
      dernierRapport.set(num(r.file_id), num(r.id));
    }
    const cles = [...new Set(liste.map((b) => t1FileOf(b)).filter((f) => f.fileId !== null && f.accountId !== null).map((f) => `T1:a${f.accountId}:asset_file:${f.fileId}`))];
    for (const r of await q(`SELECT DISTINCT ON (dedupe_key) target_id, id FROM ai_job_queue WHERE dedupe_key = ANY($1::text[]) ORDER BY dedupe_key, created_at DESC, id DESC`, [cles])) {
      dernierTravail.set(Number(r.target_id), num(r.id));
    }
  }
  return liste.map((b) => {
    const { accountId, fileId } = t1FileOf(b);
    const file = fileId !== null ? files.get(fileId) ?? null : null;
    const lastRep = b.reports.length ? b.reports[b.reports.length - 1] : null;
    const lastJob = b.jobs.length ? b.jobs[b.jobs.length - 1] : null;
    const estDerniere = fileId !== null && (
      (lastRep !== null && dernierRapport.get(fileId) === lastRep.id)
      || (lastRep === null && lastJob !== null && dernierTravail.get(fileId) === lastJob.id));
    const qual = qualifyT1({
      jobs: b.jobs, reports: b.reports,
      coverage: estDerniere && fileId !== null ? coverage.get(fileId) ?? null : null,
      file: file ? { analysisState: file.analysisState, deleted: file.deleted } : null,
    }, now);
    const first = b.jobs[0] ?? null;
    const firstRep = b.reports[0] ?? null;
    const startsWithJob = first !== null && (firstRep === null || new Date(first.createdAt).getTime() <= new Date(firstRep.createdAt).getTime());
    const origin = startsWithJob
      ? t1Origin({ jobOrigin: first.origin, origin: typeof first.payload?.origin === 'string' ? first.payload.origin : null, trigger: first.triggerCode })
      : t1Origin({ origin: firstRep?.origin ?? null, trigger: firstRep?.trigger ?? null });
    const triggeredAt = latest(startsWithJob ? first?.createdAt : firstRep?.startedAt ?? firstRep?.createdAt) ?? qual.lastActivityAt;
    const startedAt = [b.jobs.find((j) => j.startedAt)?.startedAt ?? null, firstRep?.startedAt ?? null]
      .map((d) => (d ? new Date(d) : null)).filter((d): d is Date => d !== null).sort((a, c) => a.getTime() - c.getTime())[0] ?? null;
    const tentatives = b.jobs.reduce((n, j) => n + Math.max(1, j.attempts), 0) + b.reports.filter((r) => r.jobId === null).length;
    return build('T1', b.id, qual, {
      mode: null, nature: origin === 'TEST' ? 'TECHNICAL' : 'BUSINESS', origin, accountId,
      objectType: 'document', objectId: file ? String(file.lead) : fileId !== null ? String(fileId) : null,
      triggeredAt, startedAt, resumptions: Math.max(0, tentatives - 1),
      jobIds: b.jobs.map((j) => j.id), reportIds: b.reports.map((r) => r.id), traceIds: [...new Set(b.reports.flatMap((r) => r.traceIds))],
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════
// T3 / T4 — travail de file
// ══════════════════════════════════════════════════════════════════════════

async function loadJobsInPeriod(q: Query, treatment: 'T3' | 'T4', from: Date, to: Date, accountId: number | null): Promise<{ rows: Row[]; truncated: boolean }> {
  const rows = await q(`SELECT ${JOB_COLS} FROM ai_job_queue j
     WHERE j.treatment = $1 AND COALESCE(j.finished_at, j.started_at, j.created_at) >= $2::timestamptz AND j.created_at < $3::timestamptz
       ${accountId === null ? '' : 'AND j.account_id = $4'}
     ORDER BY j.id LIMIT ${PROJECTION_ROW_CAP + 1}`, [treatment, from.toISOString(), to.toISOString(), ...(accountId === null ? [] : [accountId])]);
  return { rows: rows.slice(0, PROJECTION_ROW_CAP), truncated: rows.length > PROJECTION_ROW_CAP };
}

async function qualifyJobRows(q: Query, rows: Row[], now: Date): Promise<BusinessExecution[]> {
  const jobs = rows.map(toJobState);
  const t3Ids = jobs.filter((j) => j.treatment === 'T3').map((j) => j.id);
  const t3Reports = new Map<number, T3ReportState[]>();
  if (t3Ids.length) {
    for (const r of await q(`SELECT id, job_id, status, created_at, steps FROM ai_execution_reports WHERE treatment = 'T3' AND job_id = ANY($1::int[]) ORDER BY created_at, id`, [t3Ids])) {
      const steps = json<Array<{ step?: string; status?: string }>>(r.steps) ?? [];
      const l = t3Reports.get(num(r.job_id)) ?? [];
      l.push({ id: num(r.id), status: String(r.status), createdAt: date(r.created_at) ?? new Date(0), failedSteps: steps.filter((s) => s.status === 'FAILED' && s.step && !String(s.step).startsWith('RELECTURE')).map((s) => String(s.step)) });
      t3Reports.set(num(r.job_id), l);
    }
  }
  return jobs.map((j) => {
    const treatment = j.treatment as 'T3' | 'T4';
    const qual = treatment === 'T3' ? qualifyT3(j, t3Reports.get(j.id) ?? [], now) : qualifyT4(j, now);
    const kind = typeof j.payload?.kind === 'string' ? j.payload.kind : null;
    // SEM-04 : balayage planifié T3 = orchestration (technique), pas un travail métier.
    const technique = treatment === 'T3' && (j.accountId === null || j.targetType === 't3_sweep');
    return build(treatment, jobExecutionId(treatment, j.id), qual, {
      mode: treatment === 'T3' ? kind : null, nature: technique ? 'TECHNICAL' : 'BUSINESS', origin: jobOrigin(j.origin, j.triggerCode),
      accountId: j.accountId, objectType: j.targetType, objectId: j.targetId,
      triggeredAt: new Date(j.createdAt), startedAt: j.startedAt ? new Date(j.startedAt) : null,
      resumptions: Math.max(0, j.attempts - 1), jobIds: [j.id],
      reportIds: (t3Reports.get(j.id) ?? []).map((r) => r.id), traceIds: [],
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════
// T2 — demandes de l'assistant
// ══════════════════════════════════════════════════════════════════════════

/** Une demande `pending` au-delà de ce délai n'est plus vivante (délai total de l'assistant + marge). */
export function t2StaleAfterMs(): number {
  try {
    return getAssistantConfig().totalTimeoutMs + 10_000;
  } catch {
    return 60_000;
  }
}

const T2_COLS = `r.id, r.request_id, r.account_id, r.user_id, r.status, r.machine_final_state, r.mode, r.error_code, r.created_at, r.latency_ms,
  (SELECT m.support_level FROM verebona_messages m WHERE m.request_id = r.request_id AND m.role = 'assistant' ORDER BY m.id DESC LIMIT 1) AS support_level`;

function qualifyT2Rows(rows: Row[], now: Date): BusinessExecution[] {
  const stale = t2StaleAfterMs();
  return rows.map((r) => {
    const qual = qualifyT2({
      requestId: String(r.request_id), status: str(r.status), machineFinalState: str(r.machine_final_state), mode: str(r.mode),
      errorCode: str(r.error_code), createdAt: date(r.created_at) ?? now, latencyMs: numOrNull(r.latency_ms), supportLevel: str(r.support_level),
    }, now, stale);
    return build('T2', t2ExecutionId(String(r.request_id)), qual, {
      mode: str(r.mode), nature: 'BUSINESS', origin: 'USER', accountId: numOrNull(r.account_id), objectType: 'request', objectId: String(r.request_id),
      triggeredAt: date(r.created_at) ?? now, startedAt: date(r.created_at), resumptions: 0, jobIds: [], reportIds: [], traceIds: [],
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════
// T6 — FORMULATE et EVALUATE
// ══════════════════════════════════════════════════════════════════════════

function qualifyT6FRows(rows: Row[]): BusinessExecution[] {
  return rows.map((r) => {
    const qual = qualifyT6Formulate({ traceId: String(r.trace_id), status: String(r.status), mode: String(r.mode), error: str(r.error), createdAt: date(r.created_at) ?? new Date(0) });
    return build('T6', t6FormulateExecutionId(String(r.trace_id)), qual, {
      mode: 'FORMULATE', nature: 'BUSINESS', origin: r.mode === 'display' ? 'USER' : 'AUTOMATIC', accountId: numOrNull(r.account_id),
      objectType: 'home', objectId: r.account_id == null ? null : String(r.account_id),
      triggeredAt: date(r.created_at) ?? new Date(0), startedAt: null, resumptions: 0, jobIds: [], reportIds: [], traceIds: [String(r.trace_id)],
    });
  });
}

function qualifyT6ERows(rows: Row[], now: Date): BusinessExecution[] {
  return rows.map((r) => {
    const requestedAt = date(r.requested_at) ?? new Date(0);
    const qual = qualifyT6Evaluate({
      agendaItemId: num(r.agenda_item_id), status: String(r.status), attempts: num(r.attempts ?? 0), requestedAt,
      startedAt: date(r.started_at), finishedAt: date(r.finished_at), updatedAt: date(r.updated_at) ?? requestedAt, leaseUntil: date(r.lease_until),
      nextAttemptAt: date(r.next_attempt_at), lastErrorKind: str(r.last_error_kind), lastError: str(r.last_error), lastOutcome: str(r.last_outcome), mode: str(r.mode),
    }, now);
    return build('T6', t6EvaluateExecutionId(num(r.agenda_item_id), requestedAt), qual, {
      mode: 'EVALUATE', nature: 'BUSINESS', origin: str(r.last_outcome)?.includes('reprise explicite') ? 'ADMIN' : 'AUTOMATIC',
      accountId: numOrNull(r.account_id), objectType: 'agenda_item', objectId: String(r.agenda_item_id),
      triggeredAt: requestedAt, startedAt: date(r.started_at), resumptions: Math.max(0, num(r.attempts ?? 0) - 1),
      jobIds: [], reportIds: [], traceIds: r.trace_id ? [String(r.trace_id)] : [],
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════
// Assemblage
// ══════════════════════════════════════════════════════════════════════════

function build(
  treatment: BusinessTreatment, id: string, qual: Qualification,
  p: Omit<BusinessExecution, keyof Qualification | 'id' | 'treatment' | 'referenceAt' | 'previousExecutionId'> & { previousExecutionId?: string | null },
): BusinessExecution {
  return { id, treatment, ...qual, ...p, previousExecutionId: p.previousExecutionId ?? null, referenceAt: referenceAt(qual) };
}

export interface ProjectionFilter {
  from: Date;
  to: Date;
  treatments?: readonly BusinessTreatment[];
  accountId?: number | null;
  nature?: BusinessNature | null;
  outcome?: BusinessOutcome | null;
}

export interface Projection {
  rows: BusinessExecution[];
  /** Traitements dont la lecture a atteint le plafond (`PROJECTION_ROW_CAP`) : résultat partiel, signalé. */
  truncated: BusinessTreatment[];
  /** Traitements illisibles (table absente…) : signalés, jamais comptés comme zéro. */
  unavailable: Array<{ treatment: BusinessTreatment; message: string }>;
}

/**
 * Exécutions métier dont la date de référence est dans [from, to[ — toutes
 * natures (le filtre `nature` les sépare), triées de la plus récente à la
 * plus ancienne.
 */
export async function projectBusinessExecutions(f: ProjectionFilter, now: Date = new Date(), q: Query = defaultQuery): Promise<Projection> {
  const treatments = f.treatments?.length ? f.treatments : BUSINESS_TREATMENTS;
  const accountId = f.accountId ?? null;
  const out: BusinessExecution[] = [];
  const truncated: BusinessTreatment[] = [];
  const unavailable: Projection['unavailable'] = [];
  // Marge de lecture T2 (la fin d'une demande = création + latence).
  const fromT2 = new Date(f.from.getTime() - 10 * 60_000);
  const accParam = accountId === null ? [] : [accountId];
  for (const t of treatments) {
    try {
      if (t === 'T1') {
        const c = await t1CandidateIds(q, f.from, f.to, accountId);
        if (c.truncated) truncated.push('T1');
        out.push(...await qualifyT1Bundles(q, await loadT1Bundles(q, c.ids), now));
      } else if (t === 'T3' || t === 'T4') {
        const r = await loadJobsInPeriod(q, t, f.from, f.to, accountId);
        if (r.truncated) truncated.push(t);
        out.push(...await qualifyJobRows(q, r.rows, now));
      } else if (t === 'T2') {
        const rows = await q(`SELECT ${T2_COLS} FROM verebona_request_runs r
           WHERE r.created_at >= $1::timestamptz AND r.created_at < $2::timestamptz ${accountId === null ? '' : 'AND r.account_id = $3'}
           ORDER BY r.id LIMIT ${PROJECTION_ROW_CAP + 1}`, [fromT2.toISOString(), f.to.toISOString(), ...accParam]);
        if (rows.length > PROJECTION_ROW_CAP) truncated.push('T2');
        out.push(...qualifyT2Rows(rows.slice(0, PROJECTION_ROW_CAP), now));
      } else if (t === 'T6') {
        const gen = await q(`SELECT DISTINCT ON (g.trace_id) g.trace_id, g.account_id, g.status, g.mode, g.error, g.created_at
             FROM home_mascot_generations g
            WHERE g.trace_id IS NOT NULL AND g.status IN ('generated', 'validation_failed', 'error')
              AND g.created_at >= $1::timestamptz AND g.created_at < $2::timestamptz ${accountId === null ? '' : 'AND g.account_id = $3'}
            ORDER BY g.trace_id, g.created_at DESC LIMIT ${PROJECTION_ROW_CAP + 1}`, [f.from.toISOString(), f.to.toISOString(), ...accParam]);
        const ev = (await q(`SELECT to_regclass('t6_evaluation_runs') IS NOT NULL AS ok`))[0]?.ok
          ? await q(`SELECT * FROM t6_evaluation_runs r
               WHERE GREATEST(r.updated_at, r.requested_at) >= $1::timestamptz AND r.requested_at < $2::timestamptz ${accountId === null ? '' : 'AND r.account_id = $3'}
               LIMIT ${PROJECTION_ROW_CAP + 1}`, [f.from.toISOString(), f.to.toISOString(), ...accParam])
          : [];
        if (gen.length > PROJECTION_ROW_CAP || ev.length > PROJECTION_ROW_CAP) truncated.push('T6');
        out.push(...qualifyT6FRows(gen.slice(0, PROJECTION_ROW_CAP)), ...qualifyT6ERows(ev.slice(0, PROJECTION_ROW_CAP), now));
      }
    } catch (e) {
      unavailable.push({ treatment: t, message: String((e as Error)?.message ?? e).slice(0, 300) });
    }
  }
  const rows = out
    .filter((x) => inPeriod(x, f.from, f.to))
    .filter((x) => !f.nature || x.nature === f.nature)
    .filter((x) => !f.outcome || x.outcome === f.outcome)
    .sort((a, b) => b.referenceAt.getTime() - a.referenceAt.getTime() || a.id.localeCompare(b.id));
  return { rows, truncated, unavailable };
}

/** Récapitulatif par traitement : chaque exécution comptée UNE fois, selon son issue actuelle (BO-04). */
export function summarize(rows: readonly BusinessExecution[], treatments: readonly BusinessTreatment[] = BUSINESS_TREATMENTS): TreatmentSummary[] {
  return treatments.map((t) => {
    const s: TreatmentSummary = { treatment: t, succeeded: 0, incomplete: 0, failed: 0, notFinal: 0, void: 0, undetermined: 0, technical: 0 };
    for (const r of rows) {
      if (r.treatment !== t) continue;
      if (r.nature === 'TECHNICAL') { s.technical += 1; continue; }
      switch (r.outcome) {
        case 'SUCCEEDED': s.succeeded += 1; break;
        case 'INCOMPLETE': s.incomplete += 1; break;
        case 'FAILED': s.failed += 1; break;
        case 'NOT_FINAL': s.notFinal += 1; break;
        case 'VOID': s.void += 1; break;
        default: s.undetermined += 1;
      }
    }
    return s;
  });
}

// ══════════════════════════════════════════════════════════════════════════
// Unitaire : une exécution, ses appels, sa filiation
// ══════════════════════════════════════════════════════════════════════════

/** Une exécution par son identifiant (null : inconnue ou illisible). */
export async function getBusinessExecution(id: string, now: Date = new Date(), q: Query = defaultQuery): Promise<BusinessExecution | null> {
  const p = parseExecutionId(id);
  if (!p) return null;
  let x: BusinessExecution | null = null;
  if (p.treatment === 'T1') {
    x = (await qualifyT1Bundles(q, await loadT1Bundles(q, [id]), now))[0] ?? null;
    if (x) x.previousExecutionId = await previousT1Execution(q, x);
  } else if (p.treatment === 'T3' || p.treatment === 'T4') {
    x = (await qualifyJobRows(q, await q(`SELECT ${JOB_COLS} FROM ai_job_queue j WHERE j.id = $1 AND j.treatment = $2`, [p.jobId, p.treatment]), now))[0] ?? null;
  } else if (p.treatment === 'T2') {
    x = qualifyT2Rows(await q(`SELECT ${T2_COLS} FROM verebona_request_runs r WHERE r.request_id = $1 ORDER BY r.id DESC LIMIT 1`, [p.requestId]), now)[0] ?? null;
  } else if ('traceId' in p) {
    x = qualifyT6FRows(await q(`SELECT trace_id, account_id, status, mode, error, created_at FROM home_mascot_generations
       WHERE trace_id = $1 AND status IN ('generated', 'validation_failed', 'error') ORDER BY created_at DESC LIMIT 1`, [p.traceId]))[0] ?? null;
  } else if ('agendaItemId' in p) {
    const rows = await q(`SELECT * FROM t6_evaluation_runs WHERE agenda_item_id = $1`, [p.agendaItemId]);
    const e = qualifyT6ERows(rows, now)[0] ?? null;
    // L'état natif ne garde que la DERNIÈRE demande de l'échéance : une demande antérieure n'est plus déterminable.
    x = e && e.id === id ? e : null;
  }
  return x;
}

/** Exécution T1 précédente du même document logique (nouvelle exécution : filiation, R22). */
async function previousT1Execution(q: Query, x: BusinessExecution): Promise<string | null> {
  if (!x.objectId || x.accountId === null) return null;
  const rows = await q(`
    SELECT id FROM (
      SELECT ${T1_EXEC_OF_JOB} AS id, j.created_at AS at FROM ai_job_queue j
       WHERE j.dedupe_key = $1 AND j.created_at < $2::timestamptz
      UNION ALL
      SELECT ${T1_EXEC_OF_REPORT} AS id, r.created_at AS at FROM ai_execution_reports r LEFT JOIN ai_job_queue j ON j.id = r.job_id
       WHERE r.treatment = 'T1' AND r.account_id = $3 AND r.file_id = $4 AND r.created_at < $2::timestamptz
    ) x WHERE id <> $5 ORDER BY at DESC LIMIT 1`,
  [`T1:a${x.accountId}:asset_file:${x.objectId}`, x.triggeredAt.toISOString(), x.accountId, Number(x.objectId), x.id]);
  return rows[0] ? String(rows[0].id) : null;
}

/**
 * Exécution T1 la plus récente d'un document — reprise (remise en file,
 * reprise serveur, rejeu, reprise ciblée) : la reprise CONTINUE cette
 * exécution (R22). null : aucune (le travail sera sa propre exécution).
 */
export async function latestT1ExecutionIdForFile(accountId: number, fileId: number, q: Query = defaultQuery): Promise<string | null> {
  try {
    const rows = await q(`
      SELECT id FROM (
        (SELECT ${T1_EXEC_OF_JOB} AS id, j.created_at AS at FROM ai_job_queue j WHERE j.dedupe_key = $1 ORDER BY j.created_at DESC, j.id DESC LIMIT 1)
        UNION ALL
        (SELECT ${T1_EXEC_OF_REPORT} AS id, r.created_at AS at FROM ai_execution_reports r LEFT JOIN ai_job_queue j ON j.id = r.job_id
          WHERE r.treatment = 'T1' AND r.account_id = $2 AND r.file_id = $3 ORDER BY r.created_at DESC, r.id DESC LIMIT 1)
      ) x ORDER BY at DESC LIMIT 1`, [`T1:a${accountId}:asset_file:${fileId}`, accountId, fileId]);
    return rows[0] ? String(rows[0].id) : null;
  } catch (e) {
    console.error('[business-execution] dernière exécution du document illisible :', (e as Error).message);
    return null;
  }
}

/** Exécution métier de chaque travail de file (File IA). Lecture tolérante : travail sans exécution = absent. */
export async function businessExecutionsOfJobs(jobIds: readonly number[], now: Date = new Date(), q: Query = defaultQuery): Promise<Map<number, BusinessExecution>> {
  const out = new Map<number, BusinessExecution>();
  if (jobIds.length === 0) return out;
  const rows = await q(`SELECT ${JOB_COLS} FROM ai_job_queue j WHERE j.id = ANY($1::int[])`, [[...jobIds]]);
  const t34 = rows.filter((r) => r.treatment === 'T3' || r.treatment === 'T4');
  for (const x of await qualifyJobRows(q, t34, now)) out.set(x.jobIds[0], x);
  const t1 = rows.filter((r) => r.treatment === 'T1').map(toJobState);
  const ids = [...new Set(t1.map((j) => executionIdOfJob(j)).filter((x): x is string => x !== null))];
  if (ids.length) {
    const exec = await qualifyT1Bundles(q, await loadT1Bundles(q, ids), now);
    const parId = new Map(exec.map((e) => [e.id, e]));
    for (const j of t1) {
      const id = executionIdOfJob(j);
      const e = id ? parId.get(id) : undefined;
      if (e) out.set(j.id, e);
    }
  }
  return out;
}

export interface ExecutionCalls {
  calls: number;
  failedCalls: number;
  repairCalls: number;
  /** null : au moins un appel sans tarif connu (jamais compté zéro, COST-008). */
  costMicros: number | null;
  models: string[];
  usageEventIds: number[];
}

/**
 * Appels de chaque exécution (R56 : tous les appels et leurs coûts, une seule
 * exécution). Rattachement par `business_execution_id` ; T6 EVALUATE (appel
 * partagé) et historique antérieur : par la trace native.
 */
export async function callsOfExecutions(xs: readonly Pick<BusinessExecution, 'id' | 'traceIds'>[], q: Query = defaultQuery): Promise<Map<string, ExecutionCalls>> {
  const out = new Map<string, ExecutionCalls>();
  if (xs.length === 0) return out;
  const vide = (): ExecutionCalls => ({ calls: 0, failedCalls: 0, repairCalls: 0, costMicros: 0, models: [], usageEventIds: [] });
  for (const x of xs) out.set(x.id, vide());
  const ids = xs.map((x) => x.id);
  const traces = new Map<string, string>();
  for (const x of xs) for (const tr of x.traceIds) traces.set(tr, x.id);
  const rows = await q(`
    SELECT e.id, e.business_execution_id, e.metadata->>'traceId' AS trace_id, e.status, e.cost_micros, e.model, e.metadata->>'callKind' AS call_kind
      FROM ai_usage_event e
     WHERE e.business_execution_id = ANY($1::text[])
        OR (e.business_execution_id IS NULL AND (e.metadata->>'traceId') = ANY($2::text[]))
     ORDER BY e.id LIMIT 5000`, [ids, [...traces.keys()]]);
  for (const r of rows) {
    const id = str(r.business_execution_id) ?? traces.get(String(r.trace_id)) ?? null;
    const c = id ? out.get(id) : undefined;
    if (!c) continue;
    c.calls += 1;
    if (r.status !== 'success') c.failedCalls += 1;
    if (r.call_kind === 'repair') c.repairCalls += 1;
    c.costMicros = c.costMicros === null || r.cost_micros === null || r.cost_micros === undefined ? null : c.costMicros + num(r.cost_micros);
    if (r.model && !c.models.includes(String(r.model))) c.models.push(String(r.model));
    c.usageEventIds.push(num(r.id));
  }
  return out;
}

/** Exécution métier d'un appel (détail BO) : colonne, sinon métadonnée (appel partagé). */
export async function businessExecutionIdsOfCall(usageEventId: number, q: Query = defaultQuery): Promise<string[]> {
  try {
    const rows = await q(`SELECT business_execution_id, metadata->'businessExecutionIds' AS ids FROM ai_usage_event WHERE id = $1`, [usageEventId]);
    const r = rows[0];
    if (!r) return [];
    if (r.business_execution_id) return [String(r.business_execution_id)];
    const l = json<unknown[]>(r.ids);
    return Array.isArray(l) ? l.map(String) : [];
  } catch {
    // Colonne absente (migration 0668 non appliquée) : rattachement inconnu, jamais inventé.
    return [];
  }
}

export { t1LegacyJobExecutionId, t1LegacyReportExecutionId };
