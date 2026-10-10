/**
 * Statut fonctionnel des analyses de documents (T1), calculé à partir de
 * l'état RÉEL — lot 34C.
 *
 * Deux sources, lues ensemble :
 *   · la file durable (`ai_job_queue`) : un job T1 vivant (`PENDING` ou
 *     `RUNNING`) du document fait foi ;
 *   · le document (`asset_files.analysis_state`, et le motif technique
 *     `analysis_fail_reason`, classé ici en code fonctionnel puis JAMAIS
 *     transmis).
 *
 * `toUserFile` est le seul passage d'une ligne `asset_files` vers une
 * réponse de l'application : il retire le motif technique et ajoute le
 * statut fonctionnel.
 */
import { pgClient } from '@/db';
import {
  computeProcessingStatus, type LiveJobSnapshot, type ProcessingView,
} from '@/lib/ai/processing-status';
import { classifyUserFailure } from './failure-classifier';
import { toUserFile, processingFields } from './user-file';

export { toUserFile, processingFields, TECHNICAL_FILE_FIELDS, type UserProcessingFields } from './user-file';

type Row = Record<string, unknown>;

/**
 * Jobs T1 vivants des documents donnés — le plus récent par document.
 * Illisible (base indisponible) : carte vide, le statut retombe sur l'état
 * du document, jamais sur « en file ».
 */
export async function loadLiveT1Jobs(fileIds: number[]): Promise<Map<number, LiveJobSnapshot>> {
  const ids = [...new Set(fileIds.filter((id) => Number.isInteger(id) && id > 0))];
  const out = new Map<number, LiveJobSnapshot>();
  if (ids.length === 0) return out;
  try {
    const rows = (await pgClient.unsafe(
      `SELECT DISTINCT ON (target_id) target_id, status, attempts, available_at,
              payload->>'costCapDeferredUntil' AS cost_cap_until
         FROM ai_job_queue
        WHERE treatment = 'T1' AND target_type = 'asset_file'
          AND status IN ('PENDING', 'RUNNING')
          AND target_id = ANY($1::text[])
        ORDER BY target_id, (status = 'RUNNING') DESC, id DESC`,
      [ids.map(String)] as never[],
    )) as unknown as Row[];
    for (const r of rows) {
      const id = Number(r.target_id);
      if (!Number.isInteger(id)) continue;
      out.set(id, {
        status: r.status === 'RUNNING' ? 'RUNNING' : 'PENDING',
        attempts: Number(r.attempts ?? 0),
        availableAt: r.available_at ? new Date(String(r.available_at)).toISOString() : null,
        costCapDeferredUntil: r.cost_cap_until ? String(r.cost_cap_until) : null,
      });
    }
  } catch (e) {
    console.warn('[processing-status] file durable illisible :', (e as Error).message);
  }
  return out;
}

export interface FileStateInput {
  id: number;
  analysisState: string | null | undefined;
  /** Motif TECHNIQUE (serveur seulement) — classé, jamais rendu. */
  analysisFailReason?: string | null;
}

/** Statut fonctionnel de chaque document (une seule lecture de la file). */
export async function getProcessingViews(files: FileStateInput[]): Promise<Map<number, ProcessingView>> {
  const jobs = await loadLiveT1Jobs(files.map((f) => f.id));
  const out = new Map<number, ProcessingView>();
  for (const f of files) {
    out.set(f.id, computeProcessingStatus({
      analysisState: f.analysisState ?? null,
      liveJob: jobs.get(f.id) ?? null,
      failureCode: f.analysisState === 'ANALYSIS_FAILED' ? classifyUserFailure(f.analysisFailReason) : null,
    }));
  }
  return out;
}

/** Statut fonctionnel d'un document du compte ; `null` si le document n'existe pas pour ce compte. */
export async function getFileProcessingView(fileId: number, accountId: number): Promise<ProcessingView | null> {
  const rows = (await pgClient.unsafe(
    `SELECT id, analysis_state, analysis_fail_reason FROM asset_files WHERE id = $1 AND account_id = $2 LIMIT 1`,
    [fileId, accountId] as never[],
  )) as unknown as Row[];
  const r = rows[0];
  if (!r) return null;
  const views = await getProcessingViews([{
    id: Number(r.id),
    analysisState: r.analysis_state == null ? null : String(r.analysis_state),
    analysisFailReason: r.analysis_fail_reason == null ? null : String(r.analysis_fail_reason),
  }]);
  return views.get(Number(r.id)) ?? null;
}

/** Projection d'une liste de lignes `asset_files` (une seule lecture de la file). */
export async function toUserFiles<T extends { id: number; analysisState?: string | null; analysisFailReason?: string | null }>(
  rows: T[],
): Promise<Array<ReturnType<typeof toUserFile<T>>>> {
  const views = await getProcessingViews(rows.map((r) => ({
    id: r.id, analysisState: r.analysisState ?? null, analysisFailReason: r.analysisFailReason ?? null,
  })));
  return rows.map((r) => toUserFile(r, views.get(r.id)));
}

/** Clés d'un événement de flux qui peuvent porter un texte technique. */
const STREAM_TECHNICAL_KEYS = ['message', 'error', 'reason', 'detail', 'stack', 'cause'];

/**
 * Événement du flux d'analyse (SSE) rendu à l'application — lot 34C.
 *
 * Tout texte est retiré ; un événement qui porte un état du document est
 * complété du statut FONCTIONNEL relu en base (job vivant, document) et son
 * `analysisState` devient l'état d'affichage correspondant. Un `error` émis
 * par le pipeline alors que le traitement continue (reprise réelle en file,
 * job encore en cours) devient un simple `state_update` : aucune alerte pour
 * un échec intermédiaire (cas 1, cas 2).
 */
export async function userStreamEvent(
  fileId: number, accountId: number, data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...data };
  for (const k of STREAM_TECHNICAL_KEYS) delete out[k];
  if (!('analysisState' in data) && data.type !== 'error') return out;
  const vue = await getFileProcessingView(fileId, accountId).catch(() => null);
  if (!vue) return out;
  const { displayAnalysisState, isSettledProcessingStatus } = await import('@/lib/ai/processing-status');
  out.analysisState = displayAnalysisState(typeof data.analysisState === 'string' ? data.analysisState : null, vue.processingStatus);
  Object.assign(out, processingFields(vue));
  if (data.type === 'error' && !isSettledProcessingStatus(vue.processingStatus)) out.type = 'state_update';
  return out;
}
