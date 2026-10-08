/**
 * Persistance des diagnostics d'appel modèle — lot 33D (migration 0284).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SORTIE DU MODÈLE : DONNÉE UTILISATEUR, ACCÈS ADMINISTRATEUR SEULEMENT
 *
 * La sortie d'un modèle reprend le contenu des documents des utilisateurs.
 * Elle est donc :
 *   · masquée avant écriture (`redact` : IBAN, cartes, clés d'API, NIR —
 *     mécanisme existant de la passerelle) et bornée (`RAW_OUTPUT_MAX_CHARS`) ;
 *   · lue UNIQUEMENT par la route BO dédiée, sous garde administrateur, avec
 *     journal d'accès (`readModelOutput`) — jamais par le détail ordinaire ;
 *   · jamais écrite dans les journaux serveur ni dans l'archive S3, jamais
 *     transmise à un outil de supervision externe ;
 *   · supprimée à l'horizon de rétention des traces IA existant
 *     (`archiveAfterDays`, AI_LOG_ARCHIVE_AFTER_DAYS, 88 jours) ;
 *   · jamais conservée pour l'assistant (T2, CDC Assistant §29.6).
 *
 * La télémétrie ne fait jamais échouer un traitement : toute écriture est
 * isolée et silencieuse en cas d'échec (une ligne d'erreur sans contenu).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { redact } from '../redaction';
import type { CallDiagnostic } from './taxonomy';

/** Taille maximale conservée d'une sortie (caractères). */
export const RAW_OUTPUT_MAX_CHARS = 200_000;

type Row = Record<string, unknown>;

export interface CallDiagnosticRecord {
  traceId: string;
  usageEventId: number | null;
  callIndex: number;
  accountId: number | null;
  useCaseCode: string | null;
  operationCode: string;
  task: string | null;
  model: string | null;
  modelRank: string | null;
  sourceIds: number[];
  diagnostic: CallDiagnostic;
  /** Sortie à conserver (déjà décidée par l'appelant : `null` pour l'assistant). */
  output: { raw: string | null; extracted: string | null; parsed: unknown } | null;
}

function dbDisponible(): boolean {
  // Tests unitaires : aucune connexion (même règle que le reste de la télémétrie).
  return !(process.env.NODE_ENV === 'test' && !process.env.DATABASE_URL);
}

let tableEtat: { ready: boolean; at: number } | null = null;
async function tableReady(): Promise<boolean> {
  if (tableEtat && (tableEtat.ready || Date.now() - tableEtat.at < 5 * 60_000)) return tableEtat.ready;
  let ready = false;
  try {
    const { pgClient } = await import('@/db');
    const r = (await pgClient.unsafe(`SELECT to_regclass('ai_call_diagnostics') IS NOT NULL AS ok`)) as unknown as Row[];
    ready = Boolean(r[0]?.ok);
  } catch {
    ready = false;
  }
  tableEtat = { ready, at: Date.now() };
  return ready;
}

/** Réservé aux tests. */
export function resetDiagnosticTableState(): void {
  tableEtat = null;
}

const borne = (s: string | null | undefined): string | null => {
  if (s == null) return null;
  const m = redact(s);
  return m.length > RAW_OUTPUT_MAX_CHARS ? m.slice(0, RAW_OUTPUT_MAX_CHARS) : m;
};

function masquerJson(v: unknown): unknown {
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map(masquerJson);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Row).map(([k, x]) => [k, masquerJson(x)]));
  return v;
}

export async function recordCallDiagnostic(r: CallDiagnosticRecord): Promise<void> {
  if (!dbDisponible()) return;
  try {
    if (!(await tableReady())) return;
    const { pgClient } = await import('@/db');
    const d = r.diagnostic;
    const raw = borne(r.output?.raw);
    const parsed = r.output?.parsed === undefined || r.output?.parsed === null ? null : JSON.stringify(masquerJson(r.output.parsed));
    await pgClient.unsafe(
      `INSERT INTO ai_call_diagnostics
         (trace_id, usage_event_id, call_index, call_kind, account_id, use_case_code, operation_code, task, model, model_rank,
          outcome, failure_family, failure_subtype, failure_stage, signature, source_ids, schema_name, schema_version, schema_hash,
          diagnostic, raw_output, extracted_output, parsed_output, output_chars)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::int[], $17, $18, $19,
               $20::jsonb, $21, $22, $23::jsonb, $24)`,
      [
        r.traceId, r.usageEventId, r.callIndex, d.callKind, r.accountId, r.useCaseCode, r.operationCode, r.task, r.model, r.modelRank,
        d.outcome, d.family, d.subtype, d.stage, d.signature, r.sourceIds.filter((x) => Number.isInteger(x)),
        d.schema?.name ?? null, d.schema?.version ?? null, d.schema?.hash ?? null,
        JSON.stringify(d), raw, borne(r.output?.extracted), parsed, r.output?.raw == null ? null : r.output.raw.length,
      ] as never[],
    );
  } catch (e) {
    // Jamais la sortie dans le journal : le message d'erreur SQL seulement.
    console.error('[ai-diagnostics] diagnostic non écrit (non bloquant) :', String((e as Error).message ?? e).slice(0, 200));
  }
}

export interface StoredCallDiagnostic {
  id: number;
  createdAt: string;
  traceId: string;
  usageEventId: number | null;
  callIndex: number;
  model: string | null;
  modelRank: string | null;
  operationCode: string;
  task: string | null;
  diagnostic: CallDiagnostic;
  /** Une sortie modèle est conservée (lisible par la route dédiée). */
  hasModelOutput: boolean;
  outputChars: number | null;
}

/** Diagnostics d'une trace, SANS la sortie du modèle (détail BO, export). */
export async function listTraceDiagnostics(traceId: string): Promise<StoredCallDiagnostic[]> {
  if (!dbDisponible() || !(await tableReady())) return [];
  const { pgClient } = await import('@/db');
  const rows = (await pgClient.unsafe(
    `SELECT id, created_at, trace_id, usage_event_id, call_index, model, model_rank, operation_code, task, diagnostic,
            (raw_output IS NOT NULL OR extracted_output IS NOT NULL OR parsed_output IS NOT NULL) AS has_output, output_chars
       FROM ai_call_diagnostics WHERE trace_id = $1 ORDER BY call_index, id LIMIT 40`,
    [traceId] as never[],
  )) as unknown as Row[];
  return rows.map((x) => ({
    id: Number(x.id),
    createdAt: new Date(String(x.created_at)).toISOString(),
    traceId: String(x.trace_id),
    usageEventId: x.usage_event_id == null ? null : Number(x.usage_event_id),
    callIndex: Number(x.call_index),
    model: x.model == null ? null : String(x.model),
    modelRank: x.model_rank == null ? null : String(x.model_rank),
    operationCode: String(x.operation_code),
    task: x.task == null ? null : String(x.task),
    diagnostic: (typeof x.diagnostic === 'string' ? JSON.parse(x.diagnostic) : x.diagnostic) as CallDiagnostic,
    hasModelOutput: Boolean(x.has_output),
    outputChars: x.output_chars == null ? null : Number(x.output_chars),
  }));
}

/** Dernier échec diagnostiqué pour une source (résultat métier T1, rejeu). */
export async function latestFailureForSource(sourceId: number): Promise<{
  traceId: string; family: string | null; subtype: string | null; stage: string | null; signature: string | null; createdAt: string;
} | null> {
  if (!dbDisponible() || !(await tableReady())) return null;
  const { pgClient } = await import('@/db');
  const rows = (await pgClient.unsafe(
    `SELECT trace_id, failure_family, failure_subtype, failure_stage, signature, created_at
       FROM ai_call_diagnostics
      WHERE outcome = 'FAILED' AND call_kind = 'analysis' AND source_ids @> ARRAY[$1::int]
      ORDER BY id DESC LIMIT 1`,
    [sourceId] as never[],
  )) as unknown as Row[];
  const x = rows[0];
  if (!x) return null;
  return {
    traceId: String(x.trace_id),
    family: x.failure_family == null ? null : String(x.failure_family),
    subtype: x.failure_subtype == null ? null : String(x.failure_subtype),
    stage: x.failure_stage == null ? null : String(x.failure_stage),
    signature: x.signature == null ? null : String(x.signature),
    createdAt: new Date(String(x.created_at)).toISOString(),
  };
}

export interface ModelOutputView {
  diagnosticId: number;
  model: string | null;
  callIndex: number;
  raw: string | null;
  extracted: string | null;
  parsed: unknown;
}

/** Sorties modèle d'une trace — route BO dédiée UNIQUEMENT (accès journalisé par l'appelant). */
export async function readTraceModelOutputs(traceId: string): Promise<ModelOutputView[]> {
  if (!dbDisponible() || !(await tableReady())) return [];
  const { pgClient } = await import('@/db');
  const rows = (await pgClient.unsafe(
    `SELECT id, model, call_index, raw_output, extracted_output, parsed_output
       FROM ai_call_diagnostics WHERE trace_id = $1 ORDER BY call_index, id LIMIT 40`,
    [traceId] as never[],
  )) as unknown as Row[];
  return rows.map((x) => ({
    diagnosticId: Number(x.id),
    model: x.model == null ? null : String(x.model),
    callIndex: Number(x.call_index),
    raw: x.raw_output == null ? null : String(x.raw_output),
    extracted: x.extracted_output == null ? null : String(x.extracted_output),
    parsed: typeof x.parsed_output === 'string' ? JSON.parse(x.parsed_output) : x.parsed_output ?? null,
  }));
}

/**
 * Purge à l'horizon de rétention des traces IA (`archiveAfterDays`), par lots
 * bornés. Rend le nombre de lignes supprimées.
 */
export async function purgeCallDiagnostics(opts: { olderThanDays: number; batch?: number; deadline?: number }): Promise<number> {
  if (!(await tableReady())) return 0;
  const { pgClient } = await import('@/db');
  const batch = Math.max(100, Math.min(opts.batch ?? 5_000, 50_000));
  let total = 0;
  for (;;) {
    const r = (await pgClient.unsafe(
      `WITH old AS (
         SELECT id FROM ai_call_diagnostics
          WHERE created_at < NOW() - ($1::int * interval '1 day')
          ORDER BY id LIMIT $2)
       DELETE FROM ai_call_diagnostics d USING old WHERE d.id = old.id RETURNING d.id`,
      [opts.olderThanDays, batch] as never[],
    )) as unknown as Row[];
    total += r.length;
    if (r.length < batch || (opts.deadline && Date.now() >= opts.deadline)) break;
  }
  return total;
}
