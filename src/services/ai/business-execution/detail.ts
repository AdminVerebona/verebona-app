/**
 * Détail d'une exécution métier (lecture seule) — lot 84D (CDC Pilotage IA V2
 * P3 : BO-03, BO-08, BO-10). Serveur uniquement.
 *
 * Appels : TOUS ceux de l'exécution, quel que soit le modèle (BO-08 : un
 * filtre de modèle de l'écran n'efface jamais les autres appels d'une même
 * exécution), avec l'état de capture de chaque échange — sans son contenu,
 * réservé à la route existante (`/api/admin/ai/executions/:id/model-output`,
 * `AI_MODEL_OUTPUT_ADMIN_IDS`, journalisée).
 */
import { pgClient } from '@/db';
import { toExecutionDto } from './dto';
import { callsOfExecutions, getBusinessExecution, type Query } from './repository';
import {
  DETAIL_CALLS_MAX, isCauseUnknown, missingOf, relaunchOptions,
  type BusinessExecutionDetailDto, type ExecutionCallView, type ExecutionJobView, type ExecutionReportView,
} from './detail-model';
import type { BusinessExecution } from './types';

type Row = Record<string, unknown>;
const defaultQuery: Query = async (s, p) => (await pgClient.unsafe(s, (p ?? []) as never[])) as unknown as Row[];
const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** Appels de l'exécution (colonne de corrélation, sinon trace native), avec l'état de capture. */
export async function readExecutionCalls(x: Pick<BusinessExecution, 'id' | 'traceIds'>, q: Query = defaultQuery, max = DETAIL_CALLS_MAX): Promise<{ calls: ExecutionCallView[]; truncated: boolean }> {
  const rows = await q(`
    SELECT e.id, e.created_at, e.operation_code, e.model, e.model_rank, e.status, e.error_code, e.metadata->>'callKind' AS call_kind,
           e.duration_ms, e.cost_micros, e.metadata->>'traceId' AS trace_id
      FROM ai_usage_event e
     WHERE e.business_execution_id = $1 OR (e.business_execution_id IS NULL AND (e.metadata->>'traceId') = ANY($2::text[]))
     ORDER BY e.id LIMIT ${max + 1}`, [x.id, x.traceIds]);
  const ids = rows.slice(0, max).map((r) => Number(r.id));
  const caps = new Map<number, Row>();
  if (ids.length) {
    try {
      for (const c of await q(`SELECT DISTINCT ON (usage_event_id) usage_event_id, capture_status, prompt_status, response_status, prompt_chars, response_chars
                                 FROM ai_call_captures WHERE usage_event_id = ANY($1::bigint[]) ORDER BY usage_event_id, id DESC`, [ids])) {
        caps.set(Number(c.usage_event_id), c);
      }
    } catch {
      // Table de capture absente (migration 0649) : état de capture inconnu, jamais inventé.
    }
  }
  return {
    truncated: rows.length > max,
    calls: rows.slice(0, max).map((r) => {
      const c = caps.get(Number(r.id));
      return {
        id: Number(r.id), createdAt: iso(r.created_at)!, operationCode: s(r.operation_code), model: s(r.model), modelRank: s(r.model_rank),
        status: String(r.status), errorCode: s(r.error_code), callKind: s(r.call_kind), durationMs: n(r.duration_ms), costMicros: n(r.cost_micros),
        traceId: s(r.trace_id), captureStatus: c ? s(c.capture_status) : null, promptStatus: c ? s(c.prompt_status) : null,
        responseStatus: c ? s(c.response_status) : null, promptChars: c ? n(c.prompt_chars) : null, responseChars: c ? n(c.response_chars) : null,
      };
    }),
  };
}

async function readJobs(ids: readonly number[], q: Query): Promise<ExecutionJobView[]> {
  if (!ids.length) return [];
  return (await q(`SELECT id, treatment, status, attempts, origin, trigger_code, left(last_error, 500) AS last_error, business_result, created_at, started_at, finished_at
                     FROM ai_job_queue WHERE id = ANY($1::int[]) ORDER BY created_at, id`, [[...ids]])).map((r) => ({
    id: Number(r.id), treatment: String(r.treatment), status: String(r.status), attempts: Number(r.attempts ?? 0), origin: s(r.origin),
    triggerCode: s(r.trigger_code), lastError: s(r.last_error), businessResult: s(r.business_result), createdAt: iso(r.created_at)!,
    startedAt: iso(r.started_at), finishedAt: iso(r.finished_at),
  }));
}

async function readReports(ids: readonly number[], q: Query): Promise<ExecutionReportView[]> {
  if (!ids.length) return [];
  const rows = await q(`
    SELECT r.id, r.status, r.created_at, r.steps, r.entry_count,
           (SELECT json_object_agg(w.k, w.n) FROM (
              SELECT coalesce(e.write_result, 'non précisé') AS k, count(*)::int AS n FROM ai_execution_report_entries e
               WHERE e.report_id = coalesce(r.entries_report_id, r.id) GROUP BY 1) w) AS writes
      FROM ai_execution_reports r WHERE r.id = ANY($1::bigint[]) ORDER BY r.created_at, r.id`, [[...ids]]);
  return rows.map((r) => {
    const steps = (typeof r.steps === 'string' ? JSON.parse(r.steps) : r.steps) as Array<{ step?: string; status?: string }> | null;
    const writes = (typeof r.writes === 'string' ? JSON.parse(r.writes) : r.writes) as Record<string, number> | null;
    return {
      id: Number(r.id), status: String(r.status), createdAt: iso(r.created_at)!, entryCount: n(r.entry_count),
      failedSteps: (steps ?? []).filter((x) => x.status === 'FAILED' && x.step).map((x) => String(x.step)),
      writes: writes ?? {},
    };
  });
}

/** Détail complet d'une exécution ; null : inconnue ou non déterminable. */
export async function readBusinessExecutionDetail(
  id: string, opts: { canReadContents: boolean; now?: Date; q?: Query },
): Promise<BusinessExecutionDetailDto | null> {
  const now = opts.now ?? new Date();
  const q = opts.q ?? defaultQuery;
  const x = await getBusinessExecution(id, now, q);
  if (!x) return null;
  const [summary, calls, jobs, reports] = await Promise.all([
    callsOfExecutions([x], q).then((m) => m.get(x.id) ?? null).catch(() => null),
    readExecutionCalls(x, q),
    readJobs(x.jobIds, q),
    readReports(x.reportIds, q).catch(() => [] as ExecutionReportView[]),
  ]);
  const dto = toExecutionDto(x, summary);
  return {
    readAt: now.toISOString(), execution: dto, missing: missingOf(dto), cause: dto.cause, causeUnknown: isCauseUnknown(dto),
    calls: calls.calls, callsTruncated: calls.truncated, jobs, reports, relaunch: relaunchOptions(dto, jobs), canReadContents: opts.canReadContents,
  };
}
