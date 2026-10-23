/**
 * Rapport d'exécution T1 / T3 — lot 58C : persistance et lecture (0421).
 *
 * ÉCRITURE : une transaction dédiée, APRÈS les écritures métier. Un échec
 * n'annule jamais l'écriture métier ; il est rendu visible par un rapport
 * réduit (`report_complete = false`, motif dans `report_error`). Si même ce
 * rapport réduit ne peut être écrit, l'échec est journalisé (console) et
 * l'exécution métier continue.
 *
 * LECTURE : toujours bornée au compte du rapport (aucune donnée d'un autre
 * compte), lignes paginées, export complet sans troncature (toutes les pages
 * sont lues, références relues en direct).
 */
import { pgClient } from '@/db';
import {
  entriesFingerprint, errorText, serializeForHash, sha256, valueTypeOf,
  type ReportEntry, type ReportHeader,
} from './model';

type Row = Record<string, unknown>;

let ready: boolean | null = null;
/** Table 0421 présente ? (mémorisé une fois vrai). */
export async function executionReportsReady(): Promise<boolean> {
  if (ready) return true;
  try {
    const r = (await pgClient.unsafe(`SELECT to_regclass('ai_execution_reports') IS NOT NULL AS ok`)) as unknown as Row[];
    ready = r[0]?.ok === true;
  } catch { ready = false; }
  return ready;
}

/** Réinitialise le cache (tests). */
export function resetExecutionReportsReady(): void { ready = null; }

/** Écriture SIMULÉE en échec (tests e2e REP-03 uniquement, jamais en production). */
let failNextReportWrite = false;
export function simulateReportWriteFailure(on: boolean): void { failNextReportWrite = on; }

const j = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

function entryParams(reportId: number, accountId: number, seq: number, e: ReportEntry): unknown[] {
  return [
    reportId, seq, accountId, e.section, e.tableName ?? null, e.recordId == null ? null : String(e.recordId), e.columnPath ?? null,
    e.fieldKey ?? null, e.label ?? null, e.entityType ?? null, e.entityId ?? null,
    j(e.oldValue === undefined ? null : e.oldValue), j(e.value === undefined ? null : e.value),
    e.valueType ?? (e.ref ? 'reference' : valueTypeOf(e.value)), e.ref?.sha256 ?? null, e.ref?.chars ?? null,
    e.recordStatus ?? null, e.writeResult, e.reasonCode ?? null, e.reason ?? null, j(e.links ?? null),
  ];
}
const ENTRY_COLS = `report_id, seq, account_id, section, table_name, record_id, column_path, field_key, label, entity_type, entity_id,
  old_value, value, value_type, value_sha256, value_chars, record_status, write_result, reason_code, reason, links`;
const ENTRY_WIDTH = 21;
const ENTRY_CASTS = new Map<number, string>([[12, '::jsonb'], [13, '::jsonb'], [21, '::jsonb']]);

/**
 * Écrit un rapport. Rend son identifiant, ou `null` si rien n'a pu être écrit
 * (journalisé). Ne lève jamais.
 */
export async function writeExecutionReport(h: ReportHeader, entries: ReportEntry[]): Promise<number | null> {
  try {
    if (!(await executionReportsReady())) return null;
  } catch { return null; }
  const fingerprint = entriesFingerprint(entries);
  try {
    if (failNextReportWrite) { failNextReportWrite = false; throw new Error('écriture du rapport simulée en échec (test)'); }
    let id = 0;
    await pgClient.begin(async (tx) => {
      // Passage strictement identique au précédent (même cible, aucune écriture) : lignes partagées.
      let sameAs: number | null = null;
      if (h.treatment === 'T3' && entries.length > 0 && !entries.some((e) => e.writeResult === 'WRITTEN' || e.writeResult === 'FAILED')) {
        const prev = (await tx.unsafe(
          `SELECT id, entries_fingerprint, entries_report_id FROM ai_execution_reports
            WHERE account_id = $1 AND treatment = 'T3' AND scope = $2 AND target_id IS NOT DISTINCT FROM $3
            ORDER BY id DESC LIMIT 1`,
          [h.accountId, h.scope, h.targetId ?? h.assetId ?? null] as never[],
        )) as unknown as Row[];
        if (prev[0] && prev[0].entries_fingerprint === fingerprint) {
          sameAs = prev[0].entries_report_id == null ? Number(prev[0].id) : Number(prev[0].entries_report_id);
        }
      }
      const rows = (await tx.unsafe(
        `INSERT INTO ai_execution_reports (
           account_id, treatment, scope, job_id, job_attempt, trace_ids, file_id, asset_id, target_type, target_id,
           analysis_run_id, extraction_id, reconciliation_run_id, account_run_id, trigger_code, origin_t1_report_id,
           status, report_complete, counters, steps, sources, entry_count, entries_fingerprint, entries_report_id, started_at
         ) VALUES ($1,$2,$3,$4,$5,$6::text[],$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,TRUE,$18::jsonb,$19::jsonb,$20::jsonb,$21,$22,$23,$24::timestamptz)
         RETURNING id`,
        [
          h.accountId, h.treatment, h.scope, h.jobId ?? null, h.jobAttempt ?? null, h.traceIds ?? [], h.fileId ?? null, h.assetId ?? null,
          h.targetType ?? null, h.targetId ?? null, h.analysisRunId ?? null, h.extractionId ?? null, h.reconciliationRunId ?? null,
          h.accountRunId ?? null, h.triggerCode ?? null, h.originT1ReportId ?? null, h.status,
          JSON.stringify(h.counters), JSON.stringify(h.steps), JSON.stringify(h.sources ?? {}),
          entries.length, fingerprint, sameAs, h.startedAt ? h.startedAt.toISOString() : null,
        ] as never[],
      )) as unknown as Row[];
      id = Number(rows[0].id);
      if (sameAs !== null) return;
      // Lots bornés par le nombre de paramètres (65 535) — AUCUNE ligne n'est abandonnée.
      const LOT = 500;
      for (let i = 0; i < entries.length; i += LOT) {
        const lot = entries.slice(i, i + LOT);
        const values = lot.map((_, k) => `(${Array.from({ length: ENTRY_WIDTH }, (_x, c) => `$${k * ENTRY_WIDTH + c + 1}${ENTRY_CASTS.get(c + 1) ?? ''}`).join(',')})`).join(',');
        await tx.unsafe(
          `INSERT INTO ai_execution_report_entries (${ENTRY_COLS}) VALUES ${values}`,
          lot.flatMap((e, k) => entryParams(id, h.accountId, i + k + 1, e)) as never[],
        );
      }
    });
    return id;
  } catch (e) {
    const motif = errorText(e);
    console.error(`[execution-report] rapport ${h.treatment} non écrit (compte ${h.accountId}) :`, motif);
    // Rapport réduit : l'échec du rapport est VISIBLE, l'écriture métier reste acquise.
    try {
      const rows = (await pgClient.unsafe(
        `INSERT INTO ai_execution_reports (
           account_id, treatment, scope, job_id, job_attempt, trace_ids, file_id, asset_id, target_type, target_id,
           analysis_run_id, extraction_id, reconciliation_run_id, account_run_id, trigger_code, origin_t1_report_id,
           status, report_complete, report_error, counters, steps, entry_count, started_at
         ) VALUES ($1,$2,$3,$4,$5,$6::text[],$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,FALSE,$18,$19::jsonb,$20::jsonb,0,$21::timestamptz)
         RETURNING id`,
        [
          h.accountId, h.treatment, h.scope, h.jobId ?? null, h.jobAttempt ?? null, h.traceIds ?? [], h.fileId ?? null, h.assetId ?? null,
          h.targetType ?? null, h.targetId ?? null, h.analysisRunId ?? null, h.extractionId ?? null, h.reconciliationRunId ?? null,
          h.accountRunId ?? null, h.triggerCode ?? null, h.originT1ReportId ?? null, h.status, motif,
          JSON.stringify(h.counters), JSON.stringify(h.steps), h.startedAt ? h.startedAt.toISOString() : null,
        ] as never[],
      )) as unknown as Row[];
      return Number(rows[0].id);
    } catch (e2) {
      console.error('[execution-report] rapport réduit non écrit :', errorText(e2));
      return null;
    }
  }
}

/** Dernier rapport T1 d'un document (corrélation T1 → T3). */
export async function latestT1ReportFor(accountId: number, fileId: number): Promise<number | null> {
  if (!(await executionReportsReady())) return null;
  const r = (await pgClient.unsafe(
    `SELECT id FROM ai_execution_reports WHERE account_id = $1 AND file_id = $2 AND treatment = 'T1' ORDER BY id DESC LIMIT 1`,
    [accountId, fileId] as never[],
  )) as unknown as Row[];
  return r[0] ? Number(r[0].id) : null;
}

// ── Lecture (BO) ─────────────────────────────────────────────────────────────

export interface ReportSummary {
  id: number; accountId: number; treatment: string; scope: string; jobId: number | null; jobAttempt: number | null;
  traceIds: string[]; fileId: number | null; assetId: number | null; targetType: string | null; targetId: number | null;
  analysisRunId: number | null; extractionId: number | null; reconciliationRunId: number | null; accountRunId: number | null;
  triggerCode: string | null; originT1ReportId: number | null; status: string; reportComplete: boolean; reportError: string | null;
  counters: Record<string, number>; steps: unknown[]; sources: Record<string, unknown>; entryCount: number;
  entriesReportId: number | null; startedAt: string | null; createdAt: string;
}

const HEADER_COLS = `id, account_id, treatment, scope, job_id, job_attempt, trace_ids, file_id, asset_id, target_type, target_id,
  analysis_run_id, extraction_id, reconciliation_run_id, account_run_id, trigger_code, origin_t1_report_id, status,
  report_complete, report_error, counters, steps, sources, entry_count, entries_report_id, started_at, created_at`;

const num = (v: unknown) => (v == null ? null : Number(v));
const iso = (v: unknown) => (v == null ? null : new Date(String(v)).toISOString());

function toSummary(r: Row): ReportSummary {
  return {
    id: Number(r.id), accountId: Number(r.account_id), treatment: String(r.treatment), scope: String(r.scope),
    jobId: num(r.job_id), jobAttempt: num(r.job_attempt), traceIds: (r.trace_ids as string[] | null) ?? [],
    fileId: num(r.file_id), assetId: num(r.asset_id), targetType: (r.target_type as string | null) ?? null, targetId: num(r.target_id),
    analysisRunId: num(r.analysis_run_id), extractionId: num(r.extraction_id), reconciliationRunId: num(r.reconciliation_run_id),
    accountRunId: num(r.account_run_id), triggerCode: (r.trigger_code as string | null) ?? null, originT1ReportId: num(r.origin_t1_report_id),
    status: String(r.status), reportComplete: r.report_complete === true, reportError: (r.report_error as string | null) ?? null,
    counters: (r.counters as Record<string, number>) ?? {}, steps: (r.steps as unknown[]) ?? [], sources: (r.sources as Record<string, unknown>) ?? {},
    entryCount: Number(r.entry_count ?? 0), entriesReportId: num(r.entries_report_id),
    startedAt: iso(r.started_at), createdAt: iso(r.created_at) as string,
  };
}

export interface ReportListFilter {
  treatment?: string; accountId?: number; fileId?: number; assetId?: number; status?: string; offset?: number; limit?: number;
}

export async function listExecutionReports(f: ReportListFilter): Promise<{ rows: ReportSummary[]; total: number; available: boolean }> {
  if (!(await executionReportsReady())) return { rows: [], total: 0, available: false };
  const where: string[] = []; const params: unknown[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (f.treatment === 'T1' || f.treatment === 'T3' || f.treatment === 'T6') add('treatment = ?', f.treatment);
  if (f.accountId) add('account_id = ?', f.accountId);
  if (f.fileId) add('file_id = ?', f.fileId);
  if (f.assetId) add('asset_id = ?', f.assetId);
  if (f.status) add('status = ?', f.status);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  const offset = Math.max(f.offset ?? 0, 0);
  const [rows, total] = await Promise.all([
    pgClient.unsafe(`SELECT ${HEADER_COLS} FROM ai_execution_reports ${w} ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`, params as never[]),
    pgClient.unsafe(`SELECT count(*)::int AS n FROM ai_execution_reports ${w}`, params as never[]),
  ]);
  return { rows: (rows as unknown as Row[]).map(toSummary), total: Number((total as unknown as Row[])[0]?.n ?? 0), available: true };
}

/**
 * Rapports d'une exécution du BO (appel `ai_usage_event`) : même job ou même
 * trace, TOUJOURS dans le compte de l'appel.
 */
export async function reportsForExecution(p: { accountId: number | null; jobId: number | null; traceId: string | null; fileId: number | null }): Promise<ReportSummary[]> {
  if (!(await executionReportsReady()) || p.accountId == null) return [];
  if (p.jobId == null && !p.traceId) return [];
  const rows = (await pgClient.unsafe(
    `SELECT ${HEADER_COLS} FROM ai_execution_reports
      WHERE account_id = $1
        AND (($2::int IS NOT NULL AND job_id = $2::int) OR ($3::text IS NOT NULL AND $3::text = ANY(trace_ids)))
      ORDER BY id`,
    [p.accountId, p.jobId, p.traceId] as never[],
  )) as unknown as Row[];
  return rows.map(toSummary);
}

export async function getExecutionReport(id: number): Promise<ReportSummary | null> {
  if (!(await executionReportsReady())) return null;
  const r = (await pgClient.unsafe(`SELECT ${HEADER_COLS} FROM ai_execution_reports WHERE id = $1`, [id] as never[])) as unknown as Row[];
  return r[0] ? toSummary(r[0]) : null;
}

export interface ReportEntryView {
  seq: number; section: string; tableName: string | null; recordId: string | null; columnPath: string | null;
  fieldKey: string | null; label: string | null; entityType: string | null; entityId: number | null;
  oldValue: unknown; value: unknown; valueType: string | null; ref: { sha256: string; chars: number } | null;
  recordStatus: string | null; writeResult: string; reasonCode: string | null; reason: string | null; links: Record<string, unknown> | null;
}

function toEntry(r: Row): ReportEntryView {
  return {
    seq: Number(r.seq), section: String(r.section), tableName: (r.table_name as string | null) ?? null, recordId: (r.record_id as string | null) ?? null,
    columnPath: (r.column_path as string | null) ?? null, fieldKey: (r.field_key as string | null) ?? null, label: (r.label as string | null) ?? null,
    entityType: (r.entity_type as string | null) ?? null, entityId: num(r.entity_id), oldValue: r.old_value ?? null, value: r.value ?? null,
    valueType: (r.value_type as string | null) ?? null,
    ref: r.value_sha256 ? { sha256: String(r.value_sha256), chars: Number(r.value_chars ?? 0) } : null,
    recordStatus: (r.record_status as string | null) ?? null, writeResult: String(r.write_result),
    reasonCode: (r.reason_code as string | null) ?? null, reason: (r.reason as string | null) ?? null,
    links: (r.links as Record<string, unknown> | null) ?? null,
  };
}

/** Rapport qui PORTE les lignes (lui-même, ou le rapport identique désigné). */
const entriesOwner = (s: ReportSummary) => s.entriesReportId ?? s.id;

/** Une page de lignes d'un rapport (filtre optionnel par section / résultat). */
export async function readReportEntries(s: ReportSummary, q: { offset?: number; limit?: number; section?: string; writeResult?: string }): Promise<{ entries: ReportEntryView[]; total: number }> {
  const params: unknown[] = [entriesOwner(s), s.accountId];
  let w = 'report_id = $1 AND account_id = $2';
  if (q.section) { params.push(q.section); w += ` AND section = $${params.length}`; }
  if (q.writeResult) { params.push(q.writeResult); w += ` AND write_result = $${params.length}`; }
  const limit = Math.min(Math.max(q.limit ?? 200, 1), 1000);
  const offset = Math.max(q.offset ?? 0, 0);
  const [rows, total] = await Promise.all([
    pgClient.unsafe(`SELECT * FROM ai_execution_report_entries WHERE ${w} ORDER BY seq LIMIT ${limit} OFFSET ${offset}`, params as never[]),
    pgClient.unsafe(`SELECT count(*)::int AS n FROM ai_execution_report_entries WHERE ${w}`, params as never[]),
  ]);
  return { entries: (rows as unknown as Row[]).map(toEntry), total: Number((total as unknown as Row[])[0]?.n ?? 0) };
}

/** Répartition des lignes (section × résultat) — anomalies visibles d'emblée. */
export async function reportBreakdown(s: ReportSummary): Promise<Array<{ section: string; writeResult: string; count: number }>> {
  const rows = (await pgClient.unsafe(
    `SELECT section, write_result, count(*)::int AS n FROM ai_execution_report_entries
      WHERE report_id = $1 AND account_id = $2 GROUP BY section, write_result ORDER BY section, write_result`,
    [entriesOwner(s), s.accountId] as never[],
  )) as unknown as Row[];
  return rows.map((r) => ({ section: String(r.section), writeResult: String(r.write_result), count: Number(r.n) }));
}

/** Colonnes relisibles en direct (liste fermée : aucune table ni colonne arbitraire). */
const RESOLVABLE: Readonly<Record<string, readonly string[]>> = {
  document_extractions: ['full_text', 'metadata', 'structural_evidence', 'visual_observations', 'description', 'visual_summary'],
  // Lot 61 : extract brut déterministe (texte intégral par page).
  document_raw_extracts: ['full_text', 'pages'],
  document_source_units: ['content_text', 'value_text', 'label', 'payload', 'location'],
  document_unresolved_facts: ['original_payload', 'raw_value', 'detail'],
  document_facts: ['value_json', 'value_text', 'excerpt', 'location', 'visual_evidence'],
  document_operation_candidates: ['payload'],
  document_table_cells: ['value_text'],
  document_tables: ['columns', 'issues'],
  field_evidence: ['value_json', 'evidence_excerpt', 'source_location', 'visual_evidence'],
  document_analysis_proposals: ['proposed_value_json'],
  // Lot 60 : justification de l'évaluation IA d'interpellation (T6).
  t6_interpellation_assessments: ['reason'],
};

export type ResolvedContent =
  | { state: 'TRACED'; content: unknown }
  | { state: 'NOT_TRACED'; reason: string };

/**
 * Contenu complet d'une ligne référencée, relu en direct dans le compte du
 * rapport ; « non tracé » si l'enregistrement a disparu ou changé depuis
 * l'exécution (empreinte différente) — jamais une valeur supposée.
 */
export async function resolveRef(accountId: number, e: Pick<ReportEntryView, 'tableName' | 'recordId' | 'columnPath' | 'ref'>): Promise<ResolvedContent> {
  if (!e.ref || !e.tableName || !e.recordId || !e.columnPath) return { state: 'NOT_TRACED', reason: 'aucune référence' };
  const cols = RESOLVABLE[e.tableName];
  if (!cols || !cols.includes(e.columnPath) || !/^\d+$/.test(e.recordId)) return { state: 'NOT_TRACED', reason: 'référence non relisible' };
  const rows = (await pgClient.unsafe(
    `SELECT ${e.columnPath} AS v FROM ${e.tableName} WHERE id = $1 AND account_id = $2`,
    [e.recordId, accountId] as never[],
  )) as unknown as Row[];
  if (!rows[0]) return { state: 'NOT_TRACED', reason: 'enregistrement supprimé ou remplacé depuis l’exécution' };
  const v = rows[0].v;
  if (v == null || sha256(serializeForHash(v)) !== e.ref.sha256) {
    return { state: 'NOT_TRACED', reason: 'contenu modifié depuis l’exécution (empreinte différente)' };
  }
  return { state: 'TRACED', content: v };
}

/** Rapports corrélés : T1 d'origine et T3 déclenchés ensuite (même compte) — tous (lot 81C : plus de borne 500 / 50). */
export async function correlatedReports(s: ReportSummary): Promise<{ origin: ReportSummary | null; followups: ReportSummary[]; previousForSameDocument: ReportSummary[] }> {
  const origin = s.originT1ReportId
    ? (await pgClient.unsafe(`SELECT ${HEADER_COLS} FROM ai_execution_reports WHERE id = $1 AND account_id = $2`, [s.originT1ReportId, s.accountId] as never[])) as unknown as Row[]
    : [];
  const followups = s.treatment === 'T1'
    ? (await pgClient.unsafe(
      `SELECT ${HEADER_COLS} FROM ai_execution_reports WHERE origin_t1_report_id = $1 AND account_id = $2 ORDER BY id`,
      [s.id, s.accountId] as never[],
    )) as unknown as Row[]
    : [];
  const previous = s.treatment === 'T1' && s.fileId != null
    ? (await pgClient.unsafe(
      `SELECT ${HEADER_COLS} FROM ai_execution_reports WHERE account_id = $1 AND file_id = $2 AND treatment = 'T1' AND id <> $3 ORDER BY id DESC`,
      [s.accountId, s.fileId, s.id] as never[],
    )) as unknown as Row[]
    : [];
  return { origin: origin[0] ? toSummary(origin[0]) : null, followups: followups.map(toSummary), previousForSameDocument: previous.map(toSummary) };
}

/**
 * Export EXHAUSTIF : en-tête, corrélations et TOUTES les lignes (lues page
 * par page jusqu'à la dernière), références relues en direct. Aucune limite
 * silencieuse : `entryCount` et `entriesExported` sont comparables.
 */
export async function* exportReportChunks(s: ReportSummary, now: Date): AsyncGenerator<string> {
  const corr = await correlatedReports(s);
  const head = {
    exportedAt: now.toISOString(), schema: 'verebona.ai-execution-report/1', report: s, correlations: corr,
    notice: s.entriesReportId ? `Passage identique au rapport #${s.entriesReportId} : lignes de ce rapport.` : null,
  };
  const headJson = JSON.stringify(head, null, 2);
  yield `${headJson.slice(0, -2)},\n  "entries": [\n`;
  const PAGE = 500;
  let exported = 0;
  for (let offset = 0; ; offset += PAGE) {
    const { entries } = await readReportEntries(s, { offset, limit: PAGE });
    for (const e of entries) {
      const content = e.ref ? await resolveRef(s.accountId, e).catch((x) => ({ state: 'NOT_TRACED', reason: errorText(x) })) : undefined;
      yield `${exported > 0 ? ',\n' : ''}    ${JSON.stringify(content ? { ...e, content } : e)}`;
      exported++;
    }
    if (entries.length < PAGE) break;
  }
  const expected = s.entriesReportId ? null : s.entryCount;
  yield `\n  ],\n  "entriesExported": ${exported},\n  "entriesExpected": ${expected === null ? exported : expected},\n  "complete": ${expected === null || expected === exported}\n}\n`;
}
