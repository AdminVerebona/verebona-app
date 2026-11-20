/**
 * Exports des exécutions IA — lot 84D (CDC Pilotage IA V2 P3 : EXP-01 à
 * EXP-05, LOG-07, LOG-10, R24, R27, R28, R63, R64 ; décisions PO 01, 10, 15).
 * Serveur uniquement. Formats, périmètre et reprise : `export-model.ts`.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÉUTILISATION DU COLLECTEUR 77C / 81C / 82E — AUCUN SECOND MOTEUR
 *
 *   · lecture : UNE session REPEATABLE READ READ ONLY (`openReadSession`,
 *     81C) par passage — la projection P2 (`projectBusinessExecutions`, même
 *     règle temporelle que les cartes et la liste) et les appels sont lus dans
 *     le même instantané ; points de reprise SQL (`savepoint`) ;
 *   · colonnes des appels : liste blanche du collecteur (`USAGE_COLS`, 77C) ;
 *   · masquage : `maskForExport` / `maskText` / contrôle de sortie
 *     (`recetteLine`) du diagnostic et de l'export de recette ; contenu des
 *     échanges IA intégral SEULEMENT pour un administrateur habilité
 *     (`AI_MODEL_OUTPUT_ADMIN_IDS`, décision 15), droit revérifié au
 *     lancement, à chaque reprise et à chaque téléchargement ;
 *   · stockage : envoi compressé en flux (`openGzipUpload`, sauvegarde et
 *     export de recette), préfixe `admin-exports/ia-executions/<génération>/`,
 *     même rétention (30 jours) ; volumes ZIP en flux (`streamStoredZip`) ;
 *   · suivi : `admin_export_generations` (81C) — RUNNING → COMPLETE /
 *     PARTIAL / FAILED, signe de vie (82E), point de reprise (`resume_state`,
 *     0692) ; tâche de fond comme l'export de recette (sans bloquer le BO).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash, randomUUID } from 'node:crypto';
import type { S3Client } from '@aws-sdk/client-s3';
import { getBuildIdentity } from '@/lib/runtime-identity';
import { openReadSession, type ReadSession } from '@/services/admin/account-data/session';
import { maskForExport, maskText } from '@/services/admin/diagnostics-export/model';
import { recetteLine } from '@/services/admin/diagnostics-export/recette';
import { REPORT_COLS, USAGE_COLS } from '@/services/admin/diagnostics-export/trace';
import { historyExecutionColumnReady } from '../history-reclassification/columns';
import { isCauseUnknown, missingOf } from './detail-model';
import { toExecutionDto, type BusinessExecutionDto, type ExecutionCallsDto } from './dto';
import { matchesJournalFilter, journalFilterFingerprint, journalFilterToParams, type JournalFilter } from './journal';
import { projectBusinessExecutions } from './repository';
import { NOT_CALLED_ERROR_CODES, NO_GENERATION_STAGES } from '../gateway/fallback-policy';
import {
  ARCHIVE_DOC_DIR, ARCHIVE_INDEX, ARCHIVE_MANIFEST, ARCHIVE_README, EXPORT_AUTONOMOUS_BATCH,
  EXPORT_CALL_BATCH, EXPORT_MIN_SLICE_MS, EXPORT_RETENTION_DAYS, EXECUTION_UNIT_SCHEMA, EXECUTIONS_EXPORT_PREFIX, INDEX_HEADER,
  addToTotals, archiveFileName, autonomousPath, buildManifest, executionLine, executionsExportPrefix, exportReadme, exportStatus, indexPartPath,
  indexRowOfAutonomousCall, indexRowOfExecution, initialResumeState, parseIndexRow, partPath, planArchive, readEnd, sliceAt,
  type ArchivePlanEntry, type ExecutionsManifest, type ExportArchive, type ExportFile, type ExportOmission, type ExportPerimeter, type ExportResumeState,
} from './export-model';
import type { ExportScope, ExportSelection } from './export-selection';
import { SELECTION_TOO_LARGE_MESSAGE, executionsExportLimits, limitBreach, type ExecutionsExportLimits, type LimitBreach } from './export-settings';
import { BUSINESS_TREATMENTS, type BusinessExecution } from './types';
import { improvementCaptureUsableSql } from '@/services/privacy/improvement-opt-out-rules';

type Row = Record<string, unknown>;

export interface ExportStorage { client: Pick<S3Client, 'send'>; bucket: string }

async function defaultStorage(): Promise<ExportStorage> {
  const { getS3Client, getS3Bucket } = await import('@/lib/s3-config');
  return { client: getS3Client('worker'), bucket: getS3Bucket() };
}

const describe = (e: unknown): string => `${(e as { code?: string })?.code ? `${(e as { code?: string }).code} — ` : ''}${(e as Error)?.message ?? String(e)}`.slice(0, 500);
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Masquage des SECRETS dans un contenu autorisé (chaînes, en profondeur), sans masquer le contenu lui-même. */
function deepMaskText(v: unknown): unknown {
  if (typeof v === 'string') return maskText(v);
  if (Array.isArray(v)) return v.map(deepMaskText);
  if (v && typeof v === 'object' && !(v instanceof Date)) return Object.fromEntries(Object.entries(v as Row).map(([k, x]) => [k, deepMaskText(x)]));
  return v;
}

/** [clé exportée, colonne de contenu, colonne de statut] — longueur et SHA-256 calculés PAR LA BASE sans lire le contenu. */
const CONTENT_FIELDS = [
  ['prompt', 'prompt_text', 'prompt_status'],
  ['variables', 'variables', null],
  ['messages', 'messages', null],
  ['attachments', 'attachments', null],
  ['requestParams', 'request_params', null],
  ['providerSteps', 'provider_steps', null],
  ['response', 'response_raw', 'response_status'],
  ['parsed', 'parsed_output', null],
] as const;

/**
 * Échange capturé d'un appel (pur) : intégral (secrets masqués) si
 * `sensitive`, sinon longueur + SHA-256 (calculés en base : le contenu n'est
 * jamais lu) ; contenu absent signalé avec son motif (jamais reconstitué, LOG-08).
 */
/** Lot 102D : motif d'exclusion du contenu (opposition à l'amélioration). */
const IMPROVEMENT_EXCLUSION = 'opposition du compte à l’utilisation de ses données pour l’amélioration (lot 102D)';

export function exchangeOf(capture: Row | null, sensitive: boolean): Record<string, unknown> {
  if (!capture) return { $etat: 'absent', motif: 'aucune capture : appel antérieur à la capture (lot 82C) ou capture non écrite — non reconstitué' };
  const out: Row = {
    captureStatus: capture.capture_status ?? null, captureReason: capture.capture_reason ?? null,
    promptStatus: capture.prompt_status ?? null, responseStatus: capture.response_status ?? null,
    attemptDurationMs: capture.attempt_duration_ms ?? null, executionElapsedMs: capture.execution_elapsed_ms ?? null,
  };
  // Lot 102D : compte opposé à l'utilisation de ses données pour
  // l'amélioration (ou capture antérieure à la fin de son opposition) — un
  // export sert l'analyse et l'amélioration : contenu jamais exporté, même
  // pour un administrateur habilité (longueur et empreinte conservées). La
  // consultation unitaire par le support (fiche d'exécution) reste possible.
  const excluded = capture.improvement_excluded === true;
  if (excluded) out.exclusion = IMPROVEMENT_EXCLUSION;
  for (const [key, col, statusCol] of CONTENT_FIELDS) {
    const len = capture[`${col}_len`];
    if (excluded && len !== null && len !== undefined) {
      out[key] = { $etat: 'exclu', motif: IMPROVEMENT_EXCLUSION, longueur: Number(len), sha256: String(capture[`${col}_sha`]) };
      continue;
    }
    const present = sensitive ? capture[col] !== null && capture[col] !== undefined : len !== null && len !== undefined;
    if (!present) {
      const st = statusCol ? capture[statusCol] : null;
      out[key] = st && st !== 'CAPTURED' && st !== 'MASKED' ? { $etat: 'absent', motif: String(st) } : null;
      continue;
    }
    // Contenu autorisé : intégral, seuls les secrets (jetons, clés) et e-mails sont masqués.
    if (sensitive) { out[key] = deepMaskText(capture[col]); continue; }
    out[key] = {
      $etat: 'masque', motif: 'contenu de l’échange IA (accès réservé AI_MODEL_OUTPUT_ADMIN_IDS)',
      longueur: Number(len), sha256: String(capture[`${col}_sha`]),
    };
  }
  return out;
}

const metaOf = (col: string) => `length(${col}::text) AS ${col}_len, encode(sha256(convert_to(${col}::text, 'UTF8')), 'hex') AS ${col}_sha`;
const CAPTURE_META = `usage_event_id, capture_status, capture_reason, prompt_status, response_status, attempt_duration_ms, execution_elapsed_ms,
  NOT (${improvementCaptureUsableSql('ai_call_captures')}) AS improvement_excluded,
  ${CONTENT_FIELDS.map(([, col]) => metaOf(col)).join(', ')}`;
const CAPTURE_CONTENT = `, prompt_text, variables, messages, attachments, request_params, provider_steps, response_raw, parsed_output`;

/**
 * Appels de plusieurs exécutions, dans l'instantané (aucune borne : lots de
 * `EXPORT_CALL_BATCH` exécutions), avec leur capture. Rattachement : colonne
 * `business_execution_id`, sinon trace native (historique, T6 EVALUATE).
 */
export async function readCallsOf(
  q: ReadSession['q'], xs: readonly Pick<BusinessExecution, 'id' | 'traceIds'>[], sensitive: boolean,
): Promise<Map<string, Array<{ row: Row; capture: Row | null }>>> {
  const out = new Map<string, Array<{ row: Row; capture: Row | null }>>(xs.map((x) => [x.id, []]));
  for (let k = 0; k < xs.length; k += EXPORT_CALL_BATCH) {
    const lot = xs.slice(k, k + EXPORT_CALL_BATCH);
    const traces = new Map<string, string>();
    for (const x of lot) for (const t of x.traceIds) traces.set(t, x.id);
    // Lot 89A (P8, MIG-03) : appels historiques rattachés par le reclassement prouvé (0776).
    const hist = await historyExecutionColumnReady(q);
    const rows = await q(`SELECT ${USAGE_COLS}, business_execution_id${hist ? ', history_execution_id' : ''} FROM ai_usage_event
       WHERE business_execution_id = ANY($1::text[]) OR (business_execution_id IS NULL AND (metadata->>'traceId') = ANY($2::text[]))
       ${hist ? 'OR (business_execution_id IS NULL AND history_execution_id = ANY($1::text[]))' : ''}
       ORDER BY id`, [lot.map((x) => x.id), [...traces.keys()]]);
    const caps = new Map<number, Row>();
    if (rows.length) {
      const ok = (await q(`SELECT to_regclass('ai_call_captures') IS NOT NULL AS ok`))[0]?.ok;
      if (ok) {
        for (const c of await q(`SELECT DISTINCT ON (usage_event_id) ${CAPTURE_META}${sensitive ? CAPTURE_CONTENT : ''}
                                   FROM ai_call_captures WHERE usage_event_id = ANY($1::bigint[]) ORDER BY usage_event_id, id DESC`, [rows.map((r) => Number(r.id))])) {
          caps.set(Number(c.usage_event_id), c);
        }
      }
    }
    for (const r of rows) {
      const id = r.business_execution_id ? String(r.business_execution_id)
        : r.history_execution_id ? String(r.history_execution_id) : traces.get(String(r.trace_id)) ?? null;
      const l = id ? out.get(id) : undefined;
      if (l) l.push({ row: r, capture: caps.get(Number(r.id)) ?? null });
    }
  }
  return out;
}

/** Synthèse des appels d'une exécution (même règle que `callsOfExecutions` : inconnu ≠ zéro). */
function callsSummary(calls: Array<{ row: Row }>): ExecutionCallsDto {
  const s: ExecutionCallsDto = { calls: 0, failedCalls: 0, notCalled: 0, transferFailures: 0, generationsRequested: 0, repairCalls: 0, costMicros: 0, models: [], usageEventIds: [] };
  for (const { row: r } of calls) {
    // Lot 113R : mêmes règles que `callsOfExecutions` (détail, liste, export
    // réconciliés) — un rang non sollicité n'est ni un appel ni un échec ;
    // un transfert refusé n'est pas une génération.
    if (NOT_CALLED_ERROR_CODES.has(String(r.error_code ?? ''))) { s.notCalled = (s.notCalled ?? 0) + 1; s.usageEventIds.push(Number(r.id)); continue; }
    s.calls++;
    if (r.status !== 'success') s.failedCalls++;
    if (r.call_kind === 'repair') s.repairCalls++;
    const etape = (r.failure as { stage?: unknown } | null)?.stage ?? null;
    if (etape === 'attachment_transfer') s.transferFailures = (s.transferFailures ?? 0) + 1;
    if (!NO_GENERATION_STAGES.has(String(etape ?? ''))) s.generationsRequested = (s.generationsRequested ?? 0) + 1;
    s.costMicros = s.costMicros === null || r.cost_micros == null ? null : s.costMicros + Number(r.cost_micros);
    if (r.model && !s.models.includes(String(r.model))) s.models.push(String(r.model));
    s.usageEventIds.push(Number(r.id));
  }
  return s;
}

/** Ligne d'appel exportée (masquée ; contenu selon le droit). */
export function callLine(executionId: string, r: Row, capture: Row | null, sensitive: boolean): Record<string, unknown> {
  const { business_execution_id: _ignored, ...meta } = r;
  return { businessExecutionId: executionId, ...(maskForExport(meta) as Row), echange: exchangeOf(capture, sensitive) };
}

// ══════════════════════════════════════════════════════════════════════════
// Profondeur de diagnostic d'une exécution — UN SEUL collecteur (carte #802)
//
// Travaux de file, rapports d'exécution et écritures : lus par
// `readUnitDepth` pour l'export UNITAIRE (une exécution) comme pour l'export
// GROUPÉ (lots d'exécutions) — mêmes colonnes, même ordre, même masquage
// (`unitDiagnostics`). Le groupé n'a pas de seconde chaîne de vérité : la
// ligne `diagnostics/…jsonl` d'une exécution est exactement la partie
// correspondante de son export unitaire.
// ══════════════════════════════════════════════════════════════════════════

export interface UnitDepth { jobs: Row[]; reports: Row[]; entries: Row[] }

const JOB_EXPORT_COLS = `id, treatment, account_id, target_type, target_id, status, origin, trigger_code, attempts, left(last_error, 500) AS last_error,
        business_result, business_result_detail, created_at, started_at, finished_at`;

/** Travaux, rapports et écritures de plusieurs exécutions (lots de `EXPORT_CALL_BATCH`), dans la session de lecture. */
export async function readUnitDepth(q: ReadSession['q'], xs: readonly Pick<BusinessExecution, 'id' | 'jobIds' | 'reportIds'>[]): Promise<Map<string, UnitDepth>> {
  const out = new Map<string, UnitDepth>(xs.map((x) => [x.id, { jobs: [], reports: [], entries: [] }]));
  for (let k = 0; k < xs.length; k += EXPORT_CALL_BATCH) {
    const lot = xs.slice(k, k + EXPORT_CALL_BATCH);
    const jobIds = [...new Set(lot.flatMap((x) => x.jobIds))];
    const reportIds = [...new Set(lot.flatMap((x) => x.reportIds))];
    const jobs = new Map<number, Row>();
    if (jobIds.length) for (const j of await q(`SELECT ${JOB_EXPORT_COLS} FROM ai_job_queue WHERE id = ANY($1::int[]) ORDER BY id`, [jobIds])) jobs.set(Number(j.id), j);
    const reports = new Map<number, Row>();
    const entries = new Map<number, Row[]>();
    if (reportIds.length) {
      for (const r of await q(`SELECT ${REPORT_COLS} FROM ai_execution_reports WHERE id = ANY($1::bigint[]) ORDER BY id`, [reportIds])) reports.set(Number(r.id), r);
      for (const e of await q(`SELECT r.id AS report_id, e.seq, e.section, e.table_name, e.record_id, e.field_key, e.label, e.entity_type, e.entity_id,
        e.value_type, e.value_chars, e.record_status, e.write_result, e.reason_code, e.reason
        FROM ai_execution_reports r JOIN ai_execution_report_entries e ON e.report_id = coalesce(r.entries_report_id, r.id)
       WHERE r.id = ANY($1::bigint[]) ORDER BY r.id, e.seq`, [reportIds])) {
        const l = entries.get(Number(e.report_id)) ?? [];
        l.push(e);
        entries.set(Number(e.report_id), l);
      }
    }
    for (const x of lot) {
      const d = out.get(x.id)!;
      const sorted = (ids: readonly number[]) => [...new Set(ids)].sort((a, b) => a - b);
      for (const id of sorted(x.jobIds)) { const j = jobs.get(id); if (j) d.jobs.push(j); }
      for (const id of sorted(x.reportIds)) {
        const r = reports.get(id);
        if (r) d.reports.push(r);
        d.entries.push(...(entries.get(id) ?? []));
      }
    }
  }
  return out;
}

/**
 * Diagnostic d'une exécution (pur) : ce qui manque, cause inconnue, usage de
 * l'IA en compteurs distincts, travaux, rapports, écritures (masqués), notes.
 * Partie commune de l'export unitaire et de la ligne `diagnostics` du groupé.
 */
export function unitDiagnostics(dto: BusinessExecutionDto, providerCalls: number, depth: UnitDepth, sensitive: boolean): Record<string, unknown> {
  return {
    missing: missingOf(dto), causeUnknown: isCauseUnknown(dto),
    // Lot 99A (point D) : appels réels (lignes `calls`) / réponses du cache / décisions réutilisées — distincts.
    aiUsage: aiUsageOfJobs(providerCalls, depth.jobs),
    jobs: maskForExport(depth.jobs), reports: maskForExport(depth.reports),
    writes: maskForExport(depth.entries),
    notes: [
      'Écritures : métadonnées des lignes de rapport (table, champ, résultat d’écriture, motif) — les valeurs restent consultables au rapport d’exécution (accès journalisé).',
      sensitive ? 'Contenus des échanges IA inclus (administrateur habilité, demande journalisée).' : 'Contenus des échanges IA masqués (longueur + SHA-256).',
    ],
  };
}

// ══════════════════════════════════════════════════════════════════════════
// Export unitaire (JSON structuré)
// ══════════════════════════════════════════════════════════════════════════

/** Une exécution, tous ses appels et échanges, travaux et rapports (lecture cohérente). null : inconnue. */
export async function buildExecutionUnitExport(id: string, opts: { sensitive: boolean; now?: Date; session?: ReadSession }): Promise<Record<string, unknown> | null> {
  const { getBusinessExecution } = await import('./repository');
  const own = !opts.session;
  const s = opts.session ?? await openReadSession();
  try {
    const now = opts.now ?? new Date(s.info.at);
    const x = await getBusinessExecution(id, now, s.q);
    if (!x) return null;
    const calls = (await readCallsOf(s.q, [x], opts.sensitive)).get(x.id) ?? [];
    const dto = toExecutionDto(x, callsSummary(calls));
    const depth = (await readUnitDepth(s.q, [x])).get(x.id)!;
    const { missing, causeUnknown, ...rest } = unitDiagnostics(dto, calls.length, depth, opts.sensitive);
    return {
      format: EXECUTION_UNIT_SCHEMA, readAt: s.info.at, snapshot: { isolation: s.info.isolation, at: s.info.at, snapshot: s.info.snapshot },
      sensitiveContent: opts.sensitive,
      execution: executionLine(dto), missing, causeUnknown,
      calls: calls.map((c) => callLine(x.id, c.row, c.capture, opts.sensitive)),
      ...rest,
    };
  } finally {
    if (own) await (s as ReadSession & { close(): Promise<void> }).close().catch(() => undefined);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Export groupé — carte #802 : UN SEUL ZIP complet et vérifiable, ou un
// blocage explicite (tâche de fond, stockée, reprenable après interruption)
// ══════════════════════════════════════════════════════════════════════════

export function perimeterOf(f: JournalFilter, sensitive: boolean): ExportPerimeter {
  return {
    params: Object.fromEntries(journalFilterToParams(f)), from: f.period.from.toISOString(), to: f.period.to.toISOString(), rule: f.period.rule,
    timeZone: 'Europe/Paris', treatment: f.treatment, outcome: f.outcome, nature: f.nature, origin: f.origin, accountId: f.accountId,
    sensitiveContent: sensitive, fingerprint: sha256(journalFilterFingerprint(f)).slice(0, 16), scope: 'executions',
  };
}

const CALLS_PERIOD_RULE = 'date de création de l’appel ; bornes de l’onglet « Appels modèles » : jours UTC, début inclus, fin de journée incluse';
const EPOCH = '1970-01-01T00:00:00.000Z';

/** Périmètre figé d'une sélection de l'écran (journal des exécutions ou onglet « Appels modèles »). */
export function perimeterOfSelection(sel: ExportSelection, sensitive: boolean, readAt: Date): ExportPerimeter {
  if (sel.scope === 'executions') return perimeterOf(sel.journal, sensitive);
  const c = sel.calls;
  return {
    params: sel.params, from: c.since?.toISOString() ?? EPOCH, to: c.until?.toISOString() ?? readAt.toISOString(), rule: CALLS_PERIOD_RULE,
    timeZone: 'UTC', treatment: (c.treatment ?? null) as ExportPerimeter['treatment'], outcome: null, nature: null, origin: null, accountId: c.accountId ?? null,
    sensitiveContent: sensitive, fingerprint: sha256(JSON.stringify(Object.entries(sel.params).sort(([x], [y]) => x.localeCompare(y)))).slice(0, 16), scope: 'calls',
  };
}

const filterOf = (p: ExportPerimeter): Pick<JournalFilter, 'treatment' | 'outcome' | 'nature' | 'origin' | 'accountId'> => ({
  treatment: p.treatment, outcome: p.outcome, nature: p.nature, origin: p.origin as JournalFilter['origin'], accountId: p.accountId,
});

/**
 * Carte #802 — refus DÉFINITIF d'une génération : limite technique atteinte
 * ou complétude non garantie. Les artefacts sont purgés, la génération est
 * en échec explicite et n'est pas reprenable (la même sélection échouerait).
 */
export class ExportRefusedError extends Error {
  constructor(readonly code: string, message: string, readonly breach: LimitBreach | null = null) { super(message); this.name = 'ExportRefusedError'; }
}

const tooLarge = (b: LimitBreach): ExportRefusedError => new ExportRefusedError(`LIMIT_${b.code}`, `${SELECTION_TOO_LARGE_MESSAGE} — ${b.cause}.`, b);
const incomplete = (code: string, cause: string): ExportRefusedError => new ExportRefusedError(
  code, `Export incomplet, non livré : ${cause}. Aucun ZIP n’a été produit ; relancez l’export ou réduisez la période et affinez les filtres (traitement, compte, statut).`,
);

/** Exécution de rattachement d'un appel (colonne, sinon reclassement prouvé 89A) — même règle que le détail du BO. */
const CALL_EXECUTION_SQL = `COALESCE(e.business_execution_id, to_jsonb(e)->>'history_execution_id')`;
const GOVERNANCE_USE_CASE = 'AI_GOVERNANCE';

/** Capture la plus récente de chaque appel (méta ; contenu seulement si autorisé). */
async function readCapturesOf(q: ReadSession['q'], usageEventIds: readonly number[], sensitive: boolean): Promise<Map<number, Row>> {
  const caps = new Map<number, Row>();
  if (!usageEventIds.length) return caps;
  const ok = (await q(`SELECT to_regclass('ai_call_captures') IS NOT NULL AS ok`))[0]?.ok;
  if (!ok) return caps;
  for (const c of await q(`SELECT DISTINCT ON (usage_event_id) ${CAPTURE_META}${sensitive ? CAPTURE_CONTENT : ''}
                             FROM ai_call_captures WHERE usage_event_id = ANY($1::bigint[]) ORDER BY usage_event_id, id DESC`, [usageEventIds])) {
    caps.set(Number(c.usage_event_id), c);
  }
  return caps;
}

type CallRow = { row: Row; capture: Row | null };

/** Appels (colonnes du collecteur 77C) par identifiant, avec leur capture. */
async function readCallsByIds(q: ReadSession['q'], ids: readonly number[], sensitive: boolean): Promise<CallRow[]> {
  if (!ids.length) return [];
  const rows = await q(`SELECT ${USAGE_COLS}, business_execution_id, to_jsonb(ai_usage_event)->>'history_execution_id' AS history_execution_id,
       metadata->'businessExecutionIds' AS shared_execution_ids FROM ai_usage_event WHERE id = ANY($1::bigint[]) ORDER BY id`, [ids]);
  const caps = await readCapturesOf(q, rows.map((r) => Number(r.id)), sensitive);
  return rows.map((r) => ({ row: r, capture: caps.get(Number(r.id)) ?? null }));
}

/**
 * Ligne d'un appel SANS exécution (pur) : sonde, qualification, test
 * fournisseur, évaluation de prompt (`TECHNIQUE`), appel historique sans
 * rattachement prouvé (`NON_RATTACHE`) ou dont l'exécution déclarée n'est pas
 * dans la projection (`EXECUTION_INTROUVABLE`). Jamais une exécution métier :
 * `businessExecutionId` reste celui que porte l'appel (souvent null).
 */
export function autonomousCallLine(r: Row, capture: Row | null, sensitive: boolean, declaredExecutionId: string | null = null): Record<string, unknown> {
  const { business_execution_id: _b, history_execution_id: _h, shared_execution_ids: shared, ...meta } = r;
  const classe = declaredExecutionId ? 'EXECUTION_INTROUVABLE' : r.use_case_code === GOVERNANCE_USE_CASE ? 'TECHNIQUE' : 'NON_RATTACHE';
  return {
    type: 'APPEL_AUTONOME', classe, businessExecutionId: declaredExecutionId, executionsPartagees: Array.isArray(shared) ? shared.map(String) : null,
    note: classe === 'TECHNIQUE' ? 'appel technique sans exécution métier (sonde, qualification, test fournisseur, évaluation de prompt)'
      : classe === 'NON_RATTACHE' ? 'appel sans rattachement prouvé à une exécution — jamais inventé'
        : 'exécution déclarée par l’appel introuvable dans la projection des exécutions — aucune fiche inventée',
    ...(maskForExport(meta) as Row), echange: exchangeOf(capture, sensitive),
  };
}

const autonomousClass = (r: Row, declared: string | null): string => (declared ? 'EXECUTION_INTROUVABLE' : r.use_case_code === GOVERNANCE_USE_CASE ? 'TECHNIQUE' : 'NON_RATTACHE');

/** Les appels techniques autonomes entrent-ils dans un export du journal ? Sinon : motif (rendu au manifeste et au précontrôle). */
export function autonomousCallsScope(p: Pick<ExportPerimeter, 'nature' | 'treatment' | 'outcome' | 'origin'>): { included: boolean; reason: string } {
  if (p.nature === 'BUSINESS') return { included: false, reason: 'vue métier : les appels techniques sans exécution (sondes, qualification, tests) relèvent du périmètre technique' };
  const actifs = [p.treatment && 'traitement', p.outcome && 'issue', p.origin && 'origine'].filter(Boolean) as string[];
  if (actifs.length) return { included: false, reason: `filtre ${actifs.join(', ')} actif : un appel sans exécution n’a ni traitement, ni issue, ni origine d’exécution` };
  return { included: true, reason: 'périmètre technique sans filtre de traitement, d’issue ni d’origine' };
}

interface SliceProblems { partial: boolean; warnings: string[] }
const MINUTE_CAP = 'Plafond de lecture atteint sur une tranche d’une minute';

/**
 * Sélection du journal par TRANCHES de temps successives (une seule
 * définition, partagée par le précontrôle et la génération) : la projection
 * P2 de chaque tranche, filtrée par `matchesJournalFilter`, triée (date de
 * référence, identifiant). Une tranche plafonnée est coupée en deux, jusqu'à
 * une minute ; au-delà, ou si un traitement est illisible, `problems.partial`
 * est posé (jamais une coupe silencieuse).
 */
async function* selectedSlices(
  s: ReadSession, p: ExportPerimeter, readAt: Date, start: Date, sliceMs: number, problems: SliceProblems,
): AsyncGenerator<{ to: Date; sel: BusinessExecution[] }> {
  const end = readEnd(p, readAt.toISOString());
  const filter = filterOf(p);
  const treatments = p.treatment ? [p.treatment] : [...BUSINESS_TREATMENTS];
  let cursor = start;
  let width = sliceMs;
  while (cursor < end) {
    const sl = sliceAt(cursor, end, width);
    const rows: BusinessExecution[] = [];
    let truncated = false;
    for (const t of treatments) {
      try {
        const proj = await s.savepoint(() => projectBusinessExecutions({ from: sl.from, to: sl.to, treatments: [t], accountId: p.accountId }, readAt, s.q));
        if (proj.truncated.length) truncated = true;
        for (const u of proj.unavailable) {
          problems.partial = true;
          problems.warnings.push(`${u.treatment} illisible sur [${sl.from.toISOString()} ; ${sl.to.toISOString()}[ : ${u.message}`);
        }
        rows.push(...proj.rows);
      } catch (e) {
        if ((e as { code?: string })?.code === '25006') throw e;
        problems.partial = true;
        problems.warnings.push(`${t} illisible sur [${sl.from.toISOString()} ; ${sl.to.toISOString()}[ : ${describe(e)}`);
      }
    }
    if (truncated && sl.to.getTime() - sl.from.getTime() > EXPORT_MIN_SLICE_MS) {
      // Plafond de lecture atteint : tranche coupée en deux (aucune coupe silencieuse).
      width = Math.max(EXPORT_MIN_SLICE_MS, Math.floor((sl.to.getTime() - sl.from.getTime()) / 2));
      continue;
    }
    if (truncated) {
      problems.partial = true;
      problems.warnings.push(`${MINUTE_CAP} [${sl.from.toISOString()} ; ${sl.to.toISOString()}[ : exécutions au-delà du plafond NON exportées.`);
    }
    const sel = rows
      .filter((r) => matchesJournalFilter(r, filter) && r.referenceAt.getTime() < readAt.getTime())
      .sort((a, b) => a.referenceAt.getTime() - b.referenceAt.getTime() || a.id.localeCompare(b.id));
    yield { to: sl.to, sel };
    cursor = sl.to;
    width = sliceMs;
  }
}

/** Refus correspondant à une lecture partielle (plafond de projection ou source illisible). */
function partialRefusal(warnings: readonly string[], limits: ExecutionsExportLimits): ExportRefusedError {
  const last = warnings[warnings.length - 1] ?? 'lecture partielle';
  if (warnings.some((w) => w.startsWith(MINUTE_CAP))) return tooLarge(limitBreach('PROJECTION_CAP', null, limits, ` — ${last}`));
  return incomplete('SOURCE_UNREADABLE', `une source de la sélection est illisible (${last})`);
}

// ── Historique et archives (CA11) ────────────────────────────────────────────

const HISTORY_DAYS = 90;

/**
 * Ce que l'historique de la période ne contient plus (annoncé au précontrôle,
 * écrit au manifeste) : journées d'appels archivées PUIS supprimées de la base
 * (archives antérieures au lot 82C) et données purgées au-delà de 90 jours.
 * Jamais bloquant ; jamais passé sous silence.
 */
export async function historyOmissions(q: ReadSession['q'], p: Pick<ExportPerimeter, 'from' | 'to'>, readAt: Date): Promise<ExportOmission[]> {
  const out: ExportOmission[] = [];
  const from = p.from === EPOCH ? null : new Date(p.from);
  const to = new Date(Math.min(Date.parse(p.to), readAt.getTime()));
  try {
    const [r] = await q(`SELECT count(DISTINCT period_day)::int AS days, COALESCE(sum(row_count), 0)::bigint AS rows FROM ai_log_archives
       WHERE source_table = 'ai_usage_event' AND ($1::date IS NULL OR period_day >= $1::date) AND period_day <= $2::date
         AND NOT COALESCE((to_jsonb(ai_log_archives)->>'source_rows_kept')::boolean, false)`, [from ? from.toISOString().slice(0, 10) : null, to.toISOString().slice(0, 10)]);
    if (Number(r?.days ?? 0) > 0) {
      out.push({
        what: 'Appels modèles archivés puis supprimés de la base', status: 'NON_EXPORTE', count: Number(r.rows),
        reason: `${Number(r.days)} journée(s) de la période n’existent plus que dans les archives du stockage (onglet « Archives ») : hors contrat de cet export — les exécutions correspondantes sont exportées sans ces appels`,
      });
    }
  } catch (e) {
    out.push({ what: 'Registre des archives de journaux', status: 'NON_EXPORTE', reason: `registre illisible (${describe(e)}) : la présence d’appels archivés sur la période n’a pas pu être vérifiée` });
  }
  if (!from || readAt.getTime() - from.getTime() > HISTORY_DAYS * 86_400_000) {
    out.push({
      what: `Données de plus de ${HISTORY_DAYS} jours`, status: 'INEXISTANT',
      reason: `la période remonte à plus de ${HISTORY_DAYS} jours : les étapes de l’assistant et le contenu conversationnel T2 sont purgés au-delà (règle de conservation) et les échanges antérieurs à la capture n’ont jamais été conservés — ils sont signalés absents, jamais reconstitués`,
    });
  }
  return out;
}

// ── Précontrôle (avant tout lancement) ───────────────────────────────────────

/** Estimation avant compression (octets par ligne écrite) : ordres de grandeur relevés sur le jeu de test e2e de la carte #802 ; prudents (majorants). */
export const EXPORT_ESTIMATE = { execution: 2_600, callMasked: 3_600, job: 900, report: 1_800, entry: 500 } as const;

const CAPTURE_BYTES_SQL = CONTENT_FIELDS.map(([, col]) => `COALESCE(length(c.${col}::text), 0)`).join(' + ');

export interface ExportPrecheck {
  ok: boolean;
  scope: ExportScope;
  filters: Record<string, string>;
  sensitiveContent: boolean;
  readAt: string;
  period: { from: string; to: string };
  /** Exécutions attendues (périmètre « appels » : exécutions portant au moins un appel filtré). */
  executions: number;
  calls: number;
  autonomousCalls: number;
  autonomous: { included: boolean; reason: string };
  estimatedRawBytes: number;
  estimateNote: string;
  limits: ExecutionsExportLimits;
  refusal: { code: string; message: string; cause: string; limit: string | null } | null;
  /** Annonces avant lancement (historique, archives, appels autonomes). */
  notices: string[];
  omissions: ExportOmission[];
  durationMs: number;
}

const ESTIMATE_NOTE = 'Estimation avant compression (le ZIP est plus petit) : nombres exacts à l’instant du précontrôle, tailles moyennes par ligne '
  + 'et, pour un export avec contenus, longueur réelle des échanges capturés.';

/**
 * Précontrôle côté serveur, AVANT toute création : ensemble attendu, taille
 * estimée (captures et contenus compris), limites. Ne crée rien. Refuse
 * (`refusal`) une sélection au-delà d'une limite, plafonnée par la
 * projection, illisible, ou impossible à dénombrer dans le délai accordé.
 */
export async function precheckExecutionsExport(
  sel: ExportSelection, opts: { sensitive: boolean; now?: Date; limits?: ExecutionsExportLimits; sliceMs?: number; clock?: () => number; session?: ReadSession },
): Promise<ExportPrecheck> {
  const clock = opts.clock ?? Date.now;
  const t0 = clock();
  const limits = opts.limits ?? executionsExportLimits();
  const readAt = opts.now ?? new Date();
  const perimeter = perimeterOfSelection(sel, opts.sensitive, readAt);
  const own = !opts.session;
  const s = opts.session ?? await openReadSession();
  const base: ExportPrecheck = {
    ok: false, scope: sel.scope, filters: sel.params, sensitiveContent: opts.sensitive, readAt: readAt.toISOString(),
    period: { from: perimeter.from, to: readEnd(perimeter, readAt.toISOString()).toISOString() },
    executions: 0, calls: 0, autonomousCalls: 0, autonomous: { included: true, reason: 'onglet « Appels modèles » : appels sans exécution compris dans les appels filtrés' },
    estimatedRawBytes: 0, estimateNote: ESTIMATE_NOTE, limits, refusal: null, notices: [], omissions: [], durationMs: 0,
  };
  const refuse = (e: ExportRefusedError): ExportPrecheck => ({
    ...base, ok: false, durationMs: clock() - t0,
    refusal: { code: e.code, message: e.message, cause: e.breach?.cause ?? e.message, limit: e.breach?.limit != null ? String(e.breach.limit) : null },
  });
  const overBudget = () => clock() - t0 > limits.precheckBudgetMs;
  try {
    let contentBytes = 0;
    let jobs = 0;
    let reports = 0;
    let entries = 0;
    const capturesReady = Boolean((await s.q(`SELECT to_regclass('ai_call_captures') IS NOT NULL AS ok`))[0]?.ok);
    const content = opts.sensitive && capturesReady;
    if (sel.scope === 'executions') {
      const problems: SliceProblems = { partial: false, warnings: [] };
      for await (const { to, sel: xs } of selectedSlices(s, perimeter, readAt, new Date(perimeter.from), Math.max(EXPORT_MIN_SLICE_MS, opts.sliceMs ?? 24 * 3600_000), problems)) {
        if (problems.partial) return refuse(partialRefusal(problems.warnings, limits));
        base.executions += xs.length;
        for (let k = 0; k < xs.length; k += EXPORT_CALL_BATCH) {
          const lot = xs.slice(k, k + EXPORT_CALL_BATCH);
          const traces = [...new Set(lot.flatMap((x) => x.traceIds))];
          const [c] = await s.q(`SELECT count(*)::int AS n${content ? `, COALESCE(sum((SELECT ${CAPTURE_BYTES_SQL} FROM ai_call_captures c WHERE c.usage_event_id = e.id ORDER BY c.id DESC LIMIT 1)), 0)::bigint AS bytes` : ''}
              FROM ai_usage_event e
             WHERE e.business_execution_id = ANY($1::text[]) OR (e.business_execution_id IS NULL AND (e.metadata->>'traceId') = ANY($2::text[]))
                OR (e.business_execution_id IS NULL AND to_jsonb(e)->>'history_execution_id' = ANY($1::text[]))`, [lot.map((x) => x.id), traces]);
          base.calls += Number(c?.n ?? 0);
          contentBytes += Number(c?.bytes ?? 0);
          jobs += lot.reduce((n, x) => n + x.jobIds.length, 0);
          const reportIds = [...new Set(lot.flatMap((x) => x.reportIds))];
          reports += reportIds.length;
          if (reportIds.length) {
            const [e] = await s.q(`SELECT count(*)::int AS n FROM ai_execution_reports r JOIN ai_execution_report_entries e ON e.report_id = coalesce(r.entries_report_id, r.id) WHERE r.id = ANY($1::bigint[])`, [reportIds]);
            entries += Number(e?.n ?? 0);
          }
          if (overBudget()) return refuse(tooLarge(limitBreach('PRECHECK_BUDGET', clock() - t0, limits, ` : ${base.executions} exécution(s) déjà comptée(s) jusqu’au ${to.toISOString()}`)));
        }
        if (overBudget()) return refuse(tooLarge(limitBreach('PRECHECK_BUDGET', clock() - t0, limits, ` : ${base.executions} exécution(s) déjà comptée(s) jusqu’au ${to.toISOString()}`)));
      }
      if (problems.partial) return refuse(partialRefusal(problems.warnings, limits));
      base.autonomous = autonomousCallsScope(perimeter);
      if (base.autonomous.included) {
        const [a] = await s.q(`SELECT count(*)::int AS n${content ? `, COALESCE(sum((SELECT ${CAPTURE_BYTES_SQL} FROM ai_call_captures c WHERE c.usage_event_id = e.id ORDER BY c.id DESC LIMIT 1)), 0)::bigint AS bytes` : ''}
            FROM ai_usage_event e WHERE e.use_case_code = '${GOVERNANCE_USE_CASE}' AND ${CALL_EXECUTION_SQL} IS NULL
             AND e.created_at >= $1::timestamptz AND e.created_at < $2::timestamptz AND ($3::int IS NULL OR e.account_id = $3)`,
        [perimeter.from, base.period.to, perimeter.accountId]);
        base.autonomousCalls = Number(a?.n ?? 0);
        contentBytes += Number(a?.bytes ?? 0);
      }
    } else {
      const { executionWhere, EXECUTION_JOB_JOIN } = await import('../telemetry/execution-log.repository');
      const { where, params } = executionWhere(sel.calls);
      const [c] = await s.q(`SELECT count(*)::int AS n, count(DISTINCT ${CALL_EXECUTION_SQL})::int AS execs, (count(*) FILTER (WHERE ${CALL_EXECUTION_SQL} IS NULL))::int AS auto
          ${content ? `, COALESCE(sum((SELECT ${CAPTURE_BYTES_SQL} FROM ai_call_captures c WHERE c.usage_event_id = e.id ORDER BY c.id DESC LIMIT 1)), 0)::bigint AS bytes` : ''}
          FROM ai_usage_event e ${EXECUTION_JOB_JOIN} ${where} AND e.created_at < $18::timestamptz`, [...params, readAt.toISOString()]);
      base.autonomousCalls = Number(c?.auto ?? 0);
      base.calls = Number(c?.n ?? 0) - base.autonomousCalls;
      base.executions = Number(c?.execs ?? 0);
      contentBytes += Number(c?.bytes ?? 0);
      // Travaux, rapports et écritures : inconnus avant lecture — majorés par un travail et un rapport par exécution.
      jobs = base.executions;
      reports = base.executions;
      if (overBudget()) return refuse(tooLarge(limitBreach('PRECHECK_BUDGET', clock() - t0, limits)));
    }
    base.estimatedRawBytes = base.executions * EXPORT_ESTIMATE.execution + (base.calls + base.autonomousCalls) * EXPORT_ESTIMATE.callMasked
      + jobs * EXPORT_ESTIMATE.job + reports * EXPORT_ESTIMATE.report + entries * EXPORT_ESTIMATE.entry + contentBytes;
    base.omissions = [
      ...(sel.scope === 'executions' && !base.autonomous.included
        ? [{ what: 'Appels techniques autonomes (sondes, qualification, tests)', status: 'NON_APPLICABLE' as const, reason: base.autonomous.reason }] : []),
      ...await historyOmissions(s.q, perimeter, readAt),
    ];
    base.notices = base.omissions.map((o) => `${o.what} : ${o.reason}`);
    if (base.estimatedRawBytes > limits.maxRawBytes) {
      return refuse(tooLarge(limitBreach('RAW_BYTES', base.estimatedRawBytes, limits, ` : ${base.executions} exécution(s), ${base.calls + base.autonomousCalls} appel(s) attendus (estimation)`)));
    }
    return { ...base, ok: true, durationMs: clock() - t0 };
  } finally {
    if (own) await (s as ReadSession & { close(): Promise<void> }).close().catch(() => undefined);
  }
}

// ── Stockage : lecture, purge ────────────────────────────────────────────────

async function readStored(storage: ExportStorage, key: string): Promise<Buffer> {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const o = await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: key })) as { Body?: AsyncIterable<Uint8Array> };
  if (!o.Body) throw new Error(`${key} : objet vide`);
  const chunks: Buffer[] = [];
  for await (const c of o.Body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

/** Supprime les objets d'une génération (sauf `keep`) ; rend le nombre d'objets supprimés. */
export async function purgeExecutionsExportArtifacts(storage: ExportStorage, prefix: string, keep: ReadonlySet<string> = new Set()): Promise<number> {
  const { ListObjectsV2Command, DeleteObjectsCommand } = await import('@aws-sdk/client-s3');
  let token: string | undefined;
  let n = 0;
  do {
    const r = await storage.client.send(new ListObjectsV2Command({ Bucket: storage.bucket, Prefix: prefix, ContinuationToken: token })) as {
      Contents?: Array<{ Key?: string }>; IsTruncated?: boolean; NextContinuationToken?: string;
    };
    const del = (r.Contents ?? []).filter((o) => o.Key && !keep.has(o.Key)).map((o) => ({ Key: o.Key! }));
    if (del.length) { await storage.client.send(new DeleteObjectsCommand({ Bucket: storage.bucket, Delete: { Objects: del, Quiet: true } })); n += del.length; }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return n;
}

export interface RunOptions {
  generationId: string;
  state: ExportResumeState;
  storage?: ExportStorage;
  /** Limites techniques (défaut : celles figées au lancement, sinon `executionsExportLimits()`). */
  limits?: ExecutionsExportLimits;
  /** Horloge de la durée maximale (tests). */
  clock?: () => number;
  /** Point de reprise écrit (tests : simuler un arrêt du processus en levant ici). */
  onCheckpoint?: (s: ExportResumeState) => Promise<void> | void;
  onProgress?: (p: { rowsExported: number; files: number; bytes: number }) => void;
  session?: ReadSession;
}

type PartKind = 'executions' | 'appels' | 'diagnostics' | 'autonomes' | 'index';
const PART_KINDS: readonly PartKind[] = ['executions', 'appels', 'diagnostics', 'autonomes', 'index'];
const storedPathOf = (kind: PartKind, n: number): string => (kind === 'autonomes' ? autonomousPath(n) : kind === 'index' ? indexPartPath(n) : partPath(kind, n));
const zeros = (): Record<PartKind, number> => ({ executions: 0, appels: 0, diagnostics: 0, autonomes: 0, index: 0 });

/**
 * Produit (ou poursuit) l'export à partir du point de reprise, vérifie la
 * complétude, assemble l'archive UNIQUE, la relit et la vérifie, purge les
 * fichiers intermédiaires et rend le manifeste. Carte #802 :
 *   · un refus définitif (`ExportRefusedError` : limite, plafond, source
 *     illisible, doublon, écart) purge TOUS les artefacts et clôt la
 *     génération (non reprenable) — aucun ZIP ;
 *   · toute autre erreur (arrêt du processus, stockage momentanément
 *     indisponible) laisse le dernier point de reprise valide : la génération
 *     se reprend sans doublon ni perte ; aucun ZIP tant qu'elle n'a pas abouti.
 */
export async function runExecutionsExport(opts: RunOptions): Promise<ExecutionsManifest> {
  const st = opts.state;
  const storage = opts.storage ?? await defaultStorage();
  const prefix = executionsExportPrefix(opts.generationId);
  const { openGzipUpload, openRawUpload } = await import('@/services/backup/s3-gzip-upload');
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const { saveResumeState } = await import('@/services/admin/export-generations');
  const limits = opts.limits ?? st.limits ?? executionsExportLimits();
  st.limits = limits;
  const clock = opts.clock ?? Date.now;
  const t0 = clock();
  const own = !opts.session;
  const s = opts.session ?? await openReadSession();
  const readAt = new Date(st.readAt);
  const end = readEnd(st.perimeter, st.readAt);
  const scope: ExportScope = st.perimeter.scope ?? 'executions';
  const sensitive = st.perimeter.sensitiveContent;
  st.rawBytes ??= 0;
  st.compressedBytes ??= 0;
  st.totals.autonomousCalls ??= { expected: 0, exported: 0 };
  st.totals.callsOutsideFilter ??= 0;
  type Up = Awaited<ReturnType<typeof openGzipUpload>>;
  /** Partie ouverte : envois ouverts à la demande, lignes émises / attendues / acquittées. */
  interface Part { n: number; ups: Map<PartKind, Up>; buf: Record<PartKind, string>; emitted: Record<PartKind, number>; written: Record<PartKind, number>; expected: Record<PartKind, number>; raw: number; rows: number; outcomes: Array<{ outcome: string; treatment: string; nature: string }>; outside: number; foreign: number }
  const cur: { part: Part | null } = { part: null };
  const bytesSoFar = () => (st.rawBytes ?? 0) + (cur.part?.raw ?? 0);
  const tick = () => opts.onProgress?.({ rowsExported: st.totals.executions.exported + (cur.part?.written.executions ?? 0), files: st.files.length, bytes: bytesSoFar() });
  const checkpoint = async () => {
    await saveResumeState(opts.generationId, st, { rowsExported: st.totals.executions.exported, files: st.files.length, bytes: st.rawBytes ?? 0 });
    await opts.onCheckpoint?.(st);
  };
  /** Limites vérifiées au fil de l'eau : dépassement = arrêt propre (purge, échec explicite). */
  const guard = () => {
    if (clock() - t0 > limits.maxDurationMs) throw tooLarge(limitBreach('DURATION', clock() - t0, limits, ` : ${st.totals.executions.exported + (cur.part?.written.executions ?? 0)} exécution(s) écrite(s) à l’arrêt`));
    if (bytesSoFar() > limits.maxRawBytes) throw tooLarge(limitBreach('RAW_BYTES', bytesSoFar(), limits, ' (constaté pendant la génération)'));
    if ((st.compressedBytes ?? 0) > limits.maxZipBytes) throw tooLarge(limitBreach('ZIP_BYTES', st.compressedBytes ?? 0, limits, ' (constaté pendant la génération)'));
  };
  const part = (): Part => (cur.part ??= { n: st.nextPart, ups: new Map(), buf: { executions: '', appels: '', diagnostics: '', autonomes: '', index: '' }, emitted: zeros(), written: zeros(), expected: zeros(), raw: 0, rows: 0, outcomes: [], outside: 0, foreign: 0 });
  const flush = async (kind: PartKind) => {
    const p = cur.part;
    if (!p || !p.buf[kind]) return;
    let up = p.ups.get(kind);
    if (!up) {
      up = await openGzipUpload(storage.client, storage.bucket, `${prefix}${storedPathOf(kind, p.n)}`, { contentType: 'application/gzip' });
      p.ups.set(kind, up);
    }
    const text = p.buf[kind];
    p.buf[kind] = '';
    await up.write(text);
    // Lignes ACQUITTÉES par l'envoi (comptées après l'écriture, jamais avant).
    p.written[kind] = p.emitted[kind];
    p.raw += Buffer.byteLength(text);
  };
  const emit = async (kind: PartKind, line: string) => {
    const p = part();
    p.buf[kind] += `${line}\n`;
    p.emitted[kind]++;
    if (p.buf[kind].length > 1_000_000) await flush(kind);
  };
  const flushAll = async () => { for (const k of PART_KINDS) await flush(k); };
  /** Ouvre (vides) les fichiers d'une partie : un export sans aucune exécution reste un export vérifiable. */
  const openEmpty = async (kinds: readonly PartKind[]) => {
    const p = part();
    for (const k of kinds) if (!p.ups.has(k)) p.ups.set(k, await openGzipUpload(storage.client, storage.bucket, `${prefix}${storedPathOf(k, p.n)}`, { contentType: 'application/gzip' }));
  };
  const closePart = async () => {
    const p = cur.part;
    if (!p) return;
    await flushAll();
    for (const kind of PART_KINDS) {
      const up = p.ups.get(kind);
      if (!up) continue;
      const r = await up.finish();
      p.ups.delete(kind);
      const expected = kind === 'index' ? p.emitted.index : p.expected[kind];
      st.files.push({
        path: storedPathOf(kind, p.n), kind, part: p.n, expected, exported: p.written[kind], bytes: r.bytes, compressedBytes: r.compressedBytes, sha256: r.sha256,
        status: expected === p.written[kind] ? 'COMPLETE' : 'PARTIAL',
      });
      st.compressedBytes = (st.compressedBytes ?? 0) + r.compressedBytes;
    }
    st.rawBytes = (st.rawBytes ?? 0) + p.raw;
    st.totals.executions.expected += p.expected.executions;
    st.totals.executions.exported += p.written.executions;
    st.totals.calls.expected += p.expected.appels;
    st.totals.calls.exported += p.written.appels;
    st.totals.autonomousCalls!.expected += p.expected.autonomes;
    st.totals.autonomousCalls!.exported += p.written.autonomes;
    st.totals.callsOutsideFilter = (st.totals.callsOutsideFilter ?? 0) + p.outside;
    st.totals.callsOtherAccount = (st.totals.callsOtherAccount ?? 0) + p.foreign;
    for (const r of p.outcomes) addToTotals(st.totals, r as never);
    st.nextPart = p.n + 1;
    cur.part = null;
    guard();
  };

  /** Écrit des exécutions : fiche, appels, diagnostic (profondeur de l'export unitaire) et ligne d'index. */
  const writeUnits = async (xs: readonly BusinessExecution[], callsOf: Map<string, CallRow[]>, extra?: (x: BusinessExecution) => Record<string, unknown>) => {
    if (!xs.length) return;
    const depth = await s.savepoint(() => readUnitDepth(s.q, xs));
    const p = part();
    p.expected.executions += xs.length;
    p.expected.diagnostics += xs.length;
    for (const x of xs) p.expected.appels += (callsOf.get(x.id) ?? []).length;
    for (const x of xs) {
      const cs = callsOf.get(x.id) ?? [];
      const dto = toExecutionDto(x, callsSummary(cs));
      const firstCallLine = cs.length ? p.emitted.appels + 1 : null;
      await emit('executions', recetteLine(maskForExport(executionLine(dto)) as Row));
      for (const c of cs) await emit('appels', recetteLine(callLine(x.id, c.row, c.capture, sensitive)));
      await emit('diagnostics', recetteLine({ executionId: x.id, ...unitDiagnostics(dto, cs.length, depth.get(x.id) ?? { jobs: [], reports: [], entries: [] }, sensitive), ...(extra?.(x) ?? {}) }));
      await emit('index', indexRowOfExecution(dto, {
        file: storedPathOf('executions', p.n), line: p.emitted.executions, diagnostics: storedPathOf('diagnostics', p.n),
        callsFile: storedPathOf('appels', p.n), firstCallLine, calls: cs.length,
      }));
      p.outcomes.push({ outcome: dto.outcome, treatment: dto.treatment, nature: dto.nature });
      p.rows++;
    }
  };
  const writeAutonomous = async (calls: readonly CallRow[], declared?: Map<number, string>) => {
    if (!calls.length) return;
    const p = part();
    p.expected.autonomes += calls.length;
    for (const c of calls) {
      const d = declared?.get(Number(c.row.id)) ?? null;
      await emit('autonomes', recetteLine(autonomousCallLine(c.row, c.capture, sensitive, d)));
      await emit('index', indexRowOfAutonomousCall({
        id: Number(c.row.id), classe: autonomousClass(c.row, d), accountId: c.row.account_id == null ? null : Number(c.row.account_id),
        createdAt: c.row.created_at instanceof Date ? c.row.created_at.toISOString() : c.row.created_at == null ? null : String(c.row.created_at),
        operationCode: c.row.operation_code == null ? null : String(c.row.operation_code),
      }, { file: storedPathOf('autonomes', p.n), line: p.emitted.autonomes }));
      p.rows++;
    }
  };
  const closeIfFull = async (advance: () => void) => {
    await flushAll();
    guard();
    tick();
    if (cur.part && cur.part.rows >= st.partRows) {
      await closePart();
      advance();
      await checkpoint();
    }
  };

  try {
    st.sessions.push({ at: s.info.at, snapshot: s.info.snapshot, fromCursor: st.cursorAt });
    st.omissions = await s.savepoint(() => historyOmissions(s.q, st.perimeter, readAt));
    st.traceAttachedGovernanceIds ??= [];

    if (scope === 'executions') {
      // ── Journal des exécutions : tranches de temps ─────────────────────────
      for await (const { to, sel } of selectedSlices(s, st.perimeter, readAt, new Date(st.cursorAt), st.sliceMs, st)) {
        if (st.partial) throw partialRefusal(st.warnings, limits);
        if (sel.length) {
          const calls = await s.savepoint(() => readCallsOf(s.q, sel, sensitive));
          // Appel de gouvernance rattaché par sa trace à une exécution : jamais réexporté comme « autonome ».
          for (const l of calls.values()) for (const c of l) if (c.row.business_execution_id == null && c.row.use_case_code === GOVERNANCE_USE_CASE) st.traceAttachedGovernanceIds.push(Number(c.row.id));
          // Isolation des comptes : sous un filtre de compte, un appel rattaché mais porté par un AUTRE compte n'est jamais exporté (compté, motivé).
          if (st.perimeter.accountId !== null) {
            for (const [id, l] of calls) {
              const kept = l.filter((c) => c.row.account_id == null || Number(c.row.account_id) === st.perimeter.accountId);
              if (kept.length !== l.length) { part().foreign += l.length - kept.length; calls.set(id, kept); }
            }
          }
          await writeUnits(sel, calls);
        }
        await closeIfFull(() => { st.cursorAt = to.toISOString(); });
        if (!cur.part) st.cursorAt = to.toISOString();
      }
      if (st.partial) throw partialRefusal(st.warnings, limits);
      if (cur.part) { await closePart(); }
      st.cursorAt = end.toISOString();
      if ((st.totals.callsOtherAccount ?? 0) > 0) {
        st.omissions.unshift({
          what: 'Appels rattachés aux exécutions exportées mais portés par un autre compte', status: 'NON_EXPORTE', count: st.totals.callsOtherAccount,
          reason: `filtre de compte ${st.perimeter.accountId} : séparation des comptes — ces appels ne sont pas exportés`,
        });
      }
      const auto = autonomousCallsScope(st.perimeter);
      st.autonomousCursor ??= { after: 0, done: false };
      if (!auto.included) {
        st.omissions.unshift({ what: 'Appels techniques autonomes (sondes, qualification, tests)', status: 'NON_APPLICABLE', reason: auto.reason });
        st.autonomousCursor.done = true;
      }
      // Curseur de LECTURE local ; le curseur de reprise n'avance qu'à la fermeture d'une partie (rien d'écrit n'est perdu ni doublé).
      for (let after = st.autonomousCursor.after; !st.autonomousCursor.done;) {
        const ids = (await s.q(`SELECT e.id FROM ai_usage_event e WHERE e.use_case_code = '${GOVERNANCE_USE_CASE}' AND ${CALL_EXECUTION_SQL} IS NULL
             AND e.created_at >= $1::timestamptz AND e.created_at < $2::timestamptz AND ($3::int IS NULL OR e.account_id = $3)
             AND e.id > $4 AND NOT (e.id = ANY($5::bigint[])) ORDER BY e.id LIMIT ${EXPORT_AUTONOMOUS_BATCH}`,
        [st.perimeter.from, end.toISOString(), st.perimeter.accountId, after, st.traceAttachedGovernanceIds])).map((r) => Number(r.id));
        if (!ids.length) { if (cur.part) await closePart(); st.autonomousCursor.after = after; st.autonomousCursor.done = true; break; }
        await writeAutonomous(await s.savepoint(() => readCallsByIds(s.q, ids, sensitive)));
        after = ids[ids.length - 1];
        const reached = after;
        await closeIfFull(() => { st.autonomousCursor!.after = reached; });
      }
    } else {
      // ── Onglet « Appels modèles » : appels filtrés, regroupés par exécution ──
      const { executionWhere, EXECUTION_JOB_JOIN } = await import('../telemetry/execution-log.repository');
      const { executionApiFilters } = await import('../telemetry/execution-filters');
      const { getBusinessExecution } = await import('./repository');
      const cp = st.callParams ?? {};
      const { where, params } = executionWhere(executionApiFilters({ get: (k) => cp[k] ?? null }));
      const from = `FROM ai_usage_event e ${EXECUTION_JOB_JOIN} ${where} AND e.created_at < $18::timestamptz`;
      const base = [...params, readAt.toISOString()];
      st.callCursor ??= { after: 0, done: false };
      const accountFilter = st.perimeter.accountId;
      for (let after = st.callCursor.after; !st.callCursor.done;) {
        const groups = await s.q(`SELECT ${CALL_EXECUTION_SQL} AS exec_id, min(e.id) AS first_id ${from} AND ${CALL_EXECUTION_SQL} IS NOT NULL
            GROUP BY 1 HAVING min(e.id) > $19 ORDER BY min(e.id) LIMIT ${EXPORT_CALL_BATCH}`, [...base, after]);
        if (!groups.length) { if (cur.part) await closePart(); st.callCursor.after = after; st.callCursor.done = true; break; }
        const execIds = groups.map((g) => String(g.exec_id));
        const matching = await s.q(`SELECT e.id, ${CALL_EXECUTION_SQL} AS exec_id ${from} AND ${CALL_EXECUTION_SQL} = ANY($19::text[]) ORDER BY e.id`, [...base, execIds]);
        const totalsOf = new Map<string, number>((await s.q(`SELECT ${CALL_EXECUTION_SQL} AS exec_id, count(*)::int AS n FROM ai_usage_event e
            WHERE ${CALL_EXECUTION_SQL} = ANY($1::text[]) AND e.created_at < $2::timestamptz GROUP BY 1`, [execIds, readAt.toISOString()])).map((r) => [String(r.exec_id), Number(r.n)]));
        const execOfCall = new Map<number, string>(matching.map((m) => [Number(m.id), String(m.exec_id)]));
        const rows = await s.savepoint(() => readCallsByIds(s.q, matching.map((m) => Number(m.id)), sensitive));
        const xs: BusinessExecution[] = [];
        const callsOf = new Map<string, CallRow[]>();
        const orphans: CallRow[] = [];
        const declared = new Map<number, string>();
        const known = new Map<string, BusinessExecution | null>();
        for (const id of execIds) {
          let x: BusinessExecution | null;
          try { x = await s.savepoint(() => getBusinessExecution(id, readAt, s.q)); } catch (e) {
            if ((e as { code?: string })?.code === '25006') throw e;
            throw incomplete('SOURCE_UNREADABLE', `l’exécution ${id} d’un appel filtré est illisible (${describe(e)})`);
          }
          // Isolation des comptes : la fiche d'une exécution d'un AUTRE compte que celui filtré n'est jamais exportée.
          if (x && accountFilter !== null && x.accountId !== accountFilter) x = null;
          known.set(id, x);
          if (x) { xs.push(x); callsOf.set(x.id, []); }
        }
        for (const c of rows) {
          const id = execOfCall.get(Number(c.row.id))!;
          const x = known.get(id);
          if (x) callsOf.get(x.id)!.push(c);
          else { orphans.push(c); declared.set(Number(c.row.id), id); }
        }
        await writeUnits(xs, callsOf, (x) => {
          const exported = (callsOf.get(x.id) ?? []).length;
          const total = totalsOf.get(x.id) ?? exported;
          part().outside += Math.max(0, total - exported);
          return {
            callsFilter: {
              applied: true, exported, totalOfExecution: total, notExported: Math.max(0, total - exported),
              note: 'Export lancé depuis l’onglet « Appels modèles » : seuls les appels correspondant aux filtres sont exportés ; les autres appels de l’exécution existent mais ne sont pas exportés (hors filtre). La synthèse `calls` de la fiche porte sur les appels exportés.',
            },
          };
        });
        await writeAutonomous(orphans, declared);
        after = Number(groups[groups.length - 1].first_id);
        const reached = after;
        await closeIfFull(() => { st.callCursor!.after = reached; });
      }
      st.autonomousCursor ??= { after: 0, done: false };
      for (let after = st.autonomousCursor.after; !st.autonomousCursor.done;) {
        const ids = (await s.q(`SELECT e.id ${from} AND ${CALL_EXECUTION_SQL} IS NULL AND e.id > $19 ORDER BY e.id LIMIT ${EXPORT_AUTONOMOUS_BATCH}`, [...base, after])).map((r) => Number(r.id));
        if (!ids.length) { if (cur.part) await closePart(); st.autonomousCursor.after = after; st.autonomousCursor.done = true; break; }
        await writeAutonomous(await s.savepoint(() => readCallsByIds(s.q, ids, sensitive)));
        after = ids[ids.length - 1];
        const reached = after;
        await closeIfFull(() => { st.autonomousCursor!.after = reached; });
      }
      if ((st.totals.callsOutsideFilter ?? 0) + (cur.part?.outside ?? 0) > 0) {
        st.omissions.unshift({
          what: 'Appels des exécutions exportées ne correspondant pas aux filtres', status: 'NON_EXPORTE',
          reason: 'export lancé depuis l’onglet « Appels modèles » : seuls les appels filtrés sont exportés (décompte par exécution : `callsFilter` de sa ligne de diagnostic)',
          count: (st.totals.callsOutsideFilter ?? 0) + (cur.part?.outside ?? 0),
        });
      }
    }
    if (cur.part) await closePart();
    if (!st.files.some((f) => f.kind === 'executions')) {
      // Sélection vide : fichiers vides mais présents (archive vérifiable, « 0 exécution » dit explicitement).
      await openEmpty(['executions', 'appels', 'diagnostics', 'index']);
      await closePart();
    }
    await checkpoint();

    // ── Complétude : aucun COMPLETE sans preuve ──────────────────────────────
    guard();
    st.files = st.files.filter((f) => f.part !== null);
    const verdict = exportStatus({ ...st, done: true });
    if (verdict !== 'COMPLETE') {
      const auto = st.totals.autonomousCalls!;
      throw incomplete('COMPLETENESS_MISMATCH', `écart entre l’attendu et l’exporté (exécutions ${st.totals.executions.exported} / ${st.totals.executions.expected}, appels ${st.totals.calls.exported} / ${st.totals.calls.expected}, appels autonomes ${auto.exported} / ${auto.expected})`);
    }
    // Index relu DEPUIS LE STOCKAGE : décompte indépendant et unicité des identifiants sur toute la sélection.
    const { gunzipSync } = await import('node:zlib');
    const seen = new Set<string>();
    const dup: string[] = [];
    const indexed = { executions: 0, autonomousCalls: 0, uniqueIds: true };
    const indexUp = await openGzipUpload(storage.client, storage.bucket, `${prefix}${ARCHIVE_DOC_DIR}${ARCHIVE_INDEX}.gz`, { contentType: 'application/gzip' });
    let indexDoc: { bytes: number; compressedBytes: number; sha256: string };
    try {
      await indexUp.write(`﻿${INDEX_HEADER}\n`);
      for (const f of st.files.filter((x) => x.kind === 'index').sort((a, b) => (a.part ?? 0) - (b.part ?? 0))) {
        const text = gunzipSync(await readStored(storage, `${prefix}${f.path}`)).toString('utf8');
        for (const line of text.split('\n')) {
          if (!line) continue;
          const [type, id] = parseIndexRow(line);
          const key = `${type}:${id}`;
          if (seen.has(key)) { if (dup.length < 5) dup.push(id); indexed.uniqueIds = false; } else seen.add(key);
          if (type === 'EXECUTION') indexed.executions++; else indexed.autonomousCalls++;
        }
        await indexUp.write(text);
        guard();
      }
      indexDoc = await indexUp.finish();
    } catch (e) {
      await indexUp.abort().catch(() => undefined);
      throw e;
    }
    if (!indexed.uniqueIds) throw incomplete('DUPLICATE_IDS', `identifiant(s) en double dans la sélection (${dup.join(', ')}${dup.length >= 5 ? '…' : ''})`);
    if (indexed.executions !== st.totals.executions.exported || indexed.autonomousCalls !== st.totals.autonomousCalls!.exported) {
      throw incomplete('INDEX_MISMATCH', `l’index relu depuis le stockage (${indexed.executions} exécution(s), ${indexed.autonomousCalls} appel(s) autonome(s)) ne correspond pas aux lignes écrites (${st.totals.executions.exported}, ${st.totals.autonomousCalls!.exported})`);
    }

    // ── Manifeste, LISEZMOI, archive UNIQUE (assemblée, relue, vérifiée) ─────
    const finishedAt = new Date().toISOString();
    const build = getBuildIdentity();
    const dataFiles = st.files.filter((f) => f.kind !== 'index');
    const indexFile: ExportFile = { path: `${ARCHIVE_INDEX}.gz`, kind: 'index', part: null, expected: indexed.executions + indexed.autonomousCalls, exported: indexed.executions + indexed.autonomousCalls, bytes: indexDoc.bytes, compressedBytes: indexDoc.compressedBytes, sha256: indexDoc.sha256, status: 'COMPLETE' };
    const docEntry = (path: string, d: { bytes: number; compressedBytes: number; sha256: string }): ArchivePlanEntry => ({ path, storedPath: `${ARCHIVE_DOC_DIR}${path}.gz`, bytes: d.bytes, compressedBytes: d.compressedBytes, sha256: d.sha256 });
    const putDoc = async (path: string, text: string) => {
      const up = await openGzipUpload(storage.client, storage.bucket, `${prefix}${ARCHIVE_DOC_DIR}${path}.gz`, { contentType: 'application/gzip' });
      try { await up.write(text); return await up.finish(); } catch (e) { await up.abort().catch(() => undefined); throw e; }
    };
    const entryPaths = [ARCHIVE_INDEX, ARCHIVE_MANIFEST, ARCHIVE_README, ...planArchive(dataFiles, []).map((e) => e.path)];
    const extra = {
      generatedAt: st.sessions[0]?.at ?? st.readAt, finishedAt, environment: (process.env.NEXT_PUBLIC_APP_ENV || process.env.NODE_ENV || 'inconnu').trim(),
      build: { version: build.version ?? null, commit: build.commit ?? null }, indexed, archiveEntries: entryPaths,
    };
    const finalState: ExportResumeState = { ...st, files: [...dataFiles, indexFile], done: true };
    const readme = exportReadme(buildManifest(opts.generationId, finalState, extra));
    const readmeDoc = await putDoc(ARCHIVE_README, readme);
    finalState.files = [...finalState.files, { path: ARCHIVE_README, kind: 'documentation', part: null, expected: null, exported: 0, bytes: readmeDoc.bytes, compressedBytes: readmeDoc.compressedBytes, sha256: readmeDoc.sha256, status: 'COMPLETE' }];
    const manifest = buildManifest(opts.generationId, finalState, extra);
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    const manifestDoc = await putDoc(ARCHIVE_MANIFEST, manifestText);
    const plan = planArchive(dataFiles, [docEntry(ARCHIVE_INDEX, indexDoc), docEntry(ARCHIVE_MANIFEST, manifestDoc), docEntry(ARCHIVE_README, readmeDoc)]);
    const { writeArchive, verifyStoredArchive } = await import('@/services/admin/diagnostic-jobs/archive');
    const entries = plan.map((e) => ({ path: e.path, key: `${prefix}${e.storedPath}`, bytes: e.bytes, compressedBytes: e.compressedBytes, sha256: e.sha256 }));
    const archiveKey = `${prefix}archive/${archiveFileName(opts.generationId)}`;
    const up = await openRawUpload(storage.client, storage.bucket, archiveKey, { contentType: 'application/zip', metadata: { generation: opts.generationId } });
    let archive: ExportArchive;
    try {
      let zipBytes = 0;
      const zr = await writeArchive(storage, entries, new Date(extra.generatedAt), async (c) => {
        zipBytes += c.length;
        if (zipBytes > limits.maxZipBytes) throw tooLarge(limitBreach('ZIP_BYTES', zipBytes, limits, ' (constaté à l’assemblage de l’archive)'));
        if (clock() - t0 > limits.maxDurationMs) throw tooLarge(limitBreach('DURATION', clock() - t0, limits, ' (à l’assemblage de l’archive)'));
        await up.write(c);
      });
      const fin = await up.finish();
      const chk = await verifyStoredArchive(storage, archiveKey, entries, fin.bytes);
      if (!chk.ok) throw incomplete('ARCHIVE_INVALID', `l’archive stockée ne correspond pas aux fichiers produits (${chk.problems.slice(0, 3).join(' ; ')})`);
      archive = { fileName: archiveFileName(opts.generationId), key: archiveKey, bytes: fin.bytes, sha256: fin.sha256, entries: zr.entries, zip64: zr.zip64, verifiedAt: new Date().toISOString() };
    } catch (e) {
      await up.abort().catch(() => undefined);
      throw e;
    }
    // Livraison : manifeste de suivi (hors archive), état final, puis purge des fichiers intermédiaires.
    await storage.client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: `${prefix}manifeste.json`, Body: manifestText, ContentType: 'application/json; charset=utf-8' }));
    st.files = finalState.files;
    st.archive = archive;
    st.done = true;
    st.failure = null;
    await checkpoint();
    await purgeExecutionsExportArtifacts(storage, prefix, new Set([archiveKey, `${prefix}manifeste.json`]))
      .catch((e) => console.error('[ai/executions-export] purge des fichiers intermédiaires impossible :', (e as Error).message));
    return manifest;
  } catch (e) {
    const p = cur.part;
    if (p) for (const up of p.ups.values()) await up.abort().catch(() => undefined);
    cur.part = null;
    if (e instanceof ExportRefusedError) {
      // Arrêt propre : aucun artefact ne survit, la génération est close (non reprenable), aucun ZIP.
      await purgeExecutionsExportArtifacts(storage, prefix).catch((x) => console.error('[ai/executions-export] purge après refus impossible :', (x as Error).message));
      st.done = true;
      st.archive = null;
      st.failure = { code: e.code, message: e.message, at: new Date().toISOString() };
      await saveResumeState(opts.generationId, st, { rowsExported: st.totals.executions.exported, files: 0, bytes: 0 });
    }
    throw e;
  } finally {
    if (own) await (s as ReadSession & { close(): Promise<void> }).close().catch(() => undefined);
  }
}

// ── Lancement, reprise, suivi ────────────────────────────────────────────────

export class ExecutionsExportBusyError extends Error {
  readonly code = 'EXPORT_BUSY';
  constructor(readonly activeId: string | null) { super('Un export des exécutions IA est déjà en cours de génération.'); this.name = 'ExecutionsExportBusyError'; }
}

const enCours = (): Map<string, Promise<void>> => {
  const g = globalThis as unknown as { __vbAiExecutionsExports?: Map<string, Promise<void>> };
  return (g.__vbAiExecutionsExports ??= new Map());
};

/** Attend la fin d'une génération lancée par ce processus (tests). */
export async function waitForExecutionsExport(id: string): Promise<void> {
  await enCours().get(id);
}

export const EXPORT_HEARTBEAT_MS = 30_000;

type Admin = { id: number; email?: string };
type LaunchOptions = Pick<RunOptions, 'storage' | 'onCheckpoint' | 'limits' | 'clock'> & { sliceMs?: number; partRows?: number; now?: Date };

async function audit(admin: Admin, result: 'SUCCESS' | 'FAILURE' | 'DENIED', details: Record<string, unknown>): Promise<void> {
  const { logAdminAction } = await import('@/lib/admin-audit');
  await logAdminAction({ adminId: admin.id, adminEmail: admin.email, action: 'AI_EXECUTIONS_EXPORT', targetType: 'AI_EXECUTIONS_EXPORT', targetId: null, result, details })
    .catch(() => undefined);
}

/** Exécute la génération en tâche de fond (signe de vie, fin, journal). */
function runInBackground(admin: Admin, generationId: string, st: ExportResumeState, opts: LaunchOptions, release: () => void, phase: 'launched' | 'resumed'): void {
  const done = (async () => {
    const gen = await import('@/services/admin/export-generations');
    let last = { rowsExported: st.totals.executions.exported, files: st.files.length, bytes: 0 };
    const beat = setInterval(() => { void gen.heartbeatGeneration(generationId, last); }, EXPORT_HEARTBEAT_MS);
    beat.unref?.();
    try {
      const m = await runExecutionsExport({ ...opts, generationId, state: st, onProgress: (p) => { last = p; } });
      // Carte #802 : une génération qui aboutit est COMPLETE (archive assemblée, relue, vérifiée) — sinon elle a levé.
      await gen.finishGeneration(generationId, {
        status: 'COMPLETE', snapshotAt: m.sessions[m.sessions.length - 1]?.at ?? null, pgSnapshot: m.sessions[m.sessions.length - 1]?.snapshot ?? null,
        rowsExpected: m.totals.executions.expected, rowsExported: m.totals.executions.exported, batches: null,
        bytes: st.archive?.bytes ?? null, files: 1, sections: m.files,
        error: null, fileName: st.archive?.key ?? null,
      });
      await audit(admin, 'SUCCESS', {
        generationId, phase: 'finished', from: phase, status: 'COMPLETE', executions: m.totals.executions.exported, calls: m.totals.calls.exported,
        autonomousCalls: m.totals.autonomousCalls?.exported ?? 0, archiveBytes: st.archive?.bytes ?? null, archiveSha256: st.archive?.sha256 ?? null,
      });
      await purgeOldExecutionsExports(opts.storage).catch((e) => console.error('[ai/executions-export] purge des anciens exports impossible :', (e as Error).message));
    } catch (e) {
      if (e instanceof ExportRefusedError) {
        // Arrêt propre (limite technique ou complétude non garantie) : artefacts déjà purgés, échec explicite, aucun ZIP, pas de reprise.
        console.error('[ai/executions-export] génération arrêtée :', e.code, e.message);
        await gen.finishGeneration(generationId, { status: 'FAILED', rowsExported: 0, files: 0, bytes: 0, error: e.message });
        await audit(admin, 'FAILURE', { generationId, phase: 'refused', from: phase, code: e.code, limit: e.breach?.limit ?? null, measured: e.breach?.measured ?? null, error: e.message });
      } else {
        console.error('[ai/executions-export] génération interrompue :', (e as Error)?.message ?? e);
        // Le point de reprise (dernière partie close) reste en place : la génération peut être reprise. Aucun ZIP tant qu'elle n'a pas abouti.
        await gen.finishGeneration(generationId, {
          status: 'FAILED', rowsExported: st.totals.executions.exported, files: st.files.length,
          error: `génération interrompue — reprise possible à partir de ${st.cursorAt} : ${describe(e)}`,
        });
        await audit(admin, 'FAILURE', { generationId, phase: 'interrupted', from: phase, cursorAt: st.cursorAt, error: describe(e) });
      }
    } finally {
      clearInterval(beat);
      release();
    }
  })().finally(() => enCours().delete(generationId));
  enCours().set(generationId, done);
}

async function acquire(): Promise<() => void> {
  const gen = await import('@/services/admin/export-generations');
  const slot = gen.tryAcquireExportSlot('AI_EXECUTIONS_EXPORT');
  if (!slot) throw new ExecutionsExportBusyError(null);
  try {
    const actives = (await gen.listGenerations({ kind: 'AI_EXECUTIONS_EXPORT', pageSize: 10 })).items.filter((x) => x.status === 'RUNNING');
    if (actives.length) throw new ExecutionsExportBusyError(actives[0].id);
  } catch (e) {
    slot.release();
    throw e;
  }
  return slot.release;
}

/** Carte #802 — précontrôle négatif : RIEN n'est lancé (ni génération, ni fichier). */
export class ExportPrecheckRefusedError extends Error {
  readonly code = 'PRECHECK_REFUSED';
  constructor(readonly precheck: ExportPrecheck) { super(precheck.refusal?.message ?? 'Précontrôle négatif.'); this.name = 'ExportPrecheckRefusedError'; }
}

const isSelection = (x: JournalFilter | ExportSelection): x is ExportSelection => 'scope' in x;

/**
 * Lance un export diagnostic (tâche de fond) ; rend l'identifiant dès que la
 * génération est enregistrée (RUNNING) avec son point de reprise initial.
 * Carte #802 : le PRÉCONTRÔLE est refait ici, côté serveur, quel que soit ce
 * que l'écran a affiché — un précontrôle négatif lève
 * `ExportPrecheckRefusedError` et rien n'est créé.
 */
export async function startExecutionsExport(
  admin: Admin, f: JournalFilter | ExportSelection, opts: LaunchOptions & { sensitive: boolean },
): Promise<{ generationId: string; storagePrefix: string; precheck: ExportPrecheck }> {
  const sel: ExportSelection = isSelection(f) ? f : { scope: 'executions', journal: f, params: Object.fromEntries(journalFilterToParams(f)) };
  const release = await acquire();
  try {
    const gen = await import('@/services/admin/export-generations');
    const readAt = opts.now ?? new Date();
    const limits = opts.limits ?? executionsExportLimits();
    const precheck = await precheckExecutionsExport(sel, { sensitive: opts.sensitive, now: readAt, limits, sliceMs: opts.sliceMs, clock: opts.clock });
    if (!precheck.ok) {
      await audit(admin, 'DENIED', { phase: 'precheck', scope: sel.scope, perimeter: sel.params, code: precheck.refusal?.code ?? null, cause: precheck.refusal?.cause ?? null, contenusSensibles: opts.sensitive });
      throw new ExportPrecheckRefusedError(precheck);
    }
    const generationId = randomUUID();
    const storagePrefix = executionsExportPrefix(generationId);
    const perimeter = perimeterOfSelection(sel, opts.sensitive, readAt);
    const st = initialResumeState(perimeter, readAt, { sliceMs: opts.sliceMs, partRows: opts.partRows });
    st.limits = limits;
    st.precontrol = { at: precheck.readAt, executions: precheck.executions, calls: precheck.calls, autonomousCalls: precheck.autonomousCalls, estimatedRawBytes: precheck.estimatedRawBytes };
    if (sel.scope === 'calls') st.callParams = sel.params;
    await gen.startGeneration({
      id: generationId, kind: 'AI_EXECUTIONS_EXPORT', mode: 'stockage', adminUserId: admin.id, targetType: 'AI_EXECUTIONS',
      targetId: null, targetAccountId: perimeter.accountId,
      perimeter: { ...perimeter.params, perimetre: sel.scope === 'calls' ? 'appels' : 'executions', from: perimeter.from, to: perimeter.to, contenusSensibles: opts.sensitive }, storagePrefix,
    });
    await gen.saveResumeState(generationId, st);
    await audit(admin, 'SUCCESS', {
      generationId, phase: 'launched', scope: sel.scope, perimeter: perimeter.params, from: perimeter.from, to: perimeter.to, readAt: st.readAt, contenusSensibles: opts.sensitive,
      precheck: st.precontrol,
    });
    runInBackground(admin, generationId, st, opts, release, 'launched');
    return { generationId, storagePrefix, precheck };
  } catch (e) {
    release();
    throw e;
  }
}

export class ExportNotResumableError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'NOT_RESUMABLE' | 'SENSITIVE_CONTENT_FORBIDDEN', message: string) { super(message); this.name = 'ExportNotResumableError'; }
}

/**
 * Reprend une génération interrompue à son dernier point de reprise. Droits
 * REVÉRIFIÉS : contenus sensibles → l'administrateur qui reprend doit être
 * habilité ; refus journalisé.
 */
export async function resumeExecutionsExport(admin: Admin, generationId: string, opts: LaunchOptions = {}): Promise<{ generationId: string; cursorAt: string }> {
  const gen = await import('@/services/admin/export-generations');
  const g = await gen.getGeneration(generationId);
  if (!g || g.kind !== 'AI_EXECUTIONS_EXPORT') throw new ExportNotResumableError('NOT_FOUND', 'Export introuvable.');
  const st = await gen.readResumeState<ExportResumeState>(generationId);
  if (!st || st.done) throw new ExportNotResumableError('NOT_RESUMABLE', 'Export terminé ou sans point de reprise.');
  const { isModelOutputAccessAllowed } = await import('@/services/ai/telemetry/model-output-access');
  if (st.perimeter.sensitiveContent && !isModelOutputAccessAllowed(admin.id)) {
    await audit(admin, 'DENIED', { generationId, phase: 'resume', code: 'SENSITIVE_CONTENT_FORBIDDEN' });
    throw new ExportNotResumableError('SENSITIVE_CONTENT_FORBIDDEN', 'Export avec contenus sensibles : reprise réservée aux administrateurs habilités (AI_MODEL_OUTPUT_ADMIN_IDS).');
  }
  const release = await acquire();
  try {
    if (!(await gen.reopenGeneration(generationId))) throw new ExportNotResumableError('NOT_RESUMABLE', 'Génération encore en cours (signe de vie récent) ou terminée.');
    st.resumes.push({ at: new Date().toISOString(), adminUserId: admin.id, fromCursor: st.cursorAt });
    // Une partie ouverte au moment de l'arrêt n'a jamais été écrite : la reprise repart de la dernière partie close.
    st.files = st.files.filter((f) => f.part !== null);
    await gen.saveResumeState(generationId, st);
    await audit(admin, 'SUCCESS', { generationId, phase: 'resumed', fromCursor: st.cursorAt, partsKept: st.nextPart - 1 });
    runInBackground(admin, generationId, st, opts, release, 'resumed');
    return { generationId, cursorAt: st.cursorAt };
  } catch (e) {
    release();
    throw e;
  }
}

/** Manifeste stocké ; null : absent (en cours, interrompue ou purgée). */
export async function readExecutionsManifest(generationId: string, storage?: ExportStorage): Promise<ExecutionsManifest | null> {
  const st = storage ?? await defaultStorage();
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  try {
    const o = await st.client.send(new GetObjectCommand({ Bucket: st.bucket, Key: `${executionsExportPrefix(generationId)}manifeste.json` })) as { Body?: { transformToString(): Promise<string> } };
    return JSON.parse(await o.Body!.transformToString()) as ExecutionsManifest;
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === 'NoSuchKey' || (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

/**
 * Règle remplacée (carte #802) : plus de fichiers téléchargeables un par un ni
 * de volumes. SEULE l'archive unique d'une génération aboutie (état final :
 * archive assemblée, relue, vérifiée, sans échec) est remise ; null sinon.
 */
export function deliverableArchive(st: Pick<ExportResumeState, 'done' | 'archive' | 'failure'> | null): ExportArchive | null {
  return st && st.done && !st.failure && st.archive ? st.archive : null;
}

/** L'archive est-elle toujours dans le stockage (taille inchangée) ? false : purgée ou altérée — rien n'est remis. */
export async function archiveStillStored(a: Pick<ExportArchive, 'key' | 'bytes'>, storage?: ExportStorage): Promise<boolean> {
  const st = storage ?? await defaultStorage();
  const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
  try {
    const h = await st.client.send(new HeadObjectCommand({ Bucket: st.bucket, Key: a.key })) as { ContentLength?: number };
    return Number(h.ContentLength) === a.bytes;
  } catch {
    return false;
  }
}

/** Exports de plus de `EXPORT_RETENTION_DAYS` jours : supprimés du stockage. */
export async function purgeOldExecutionsExports(storage?: ExportStorage, now: Date = new Date()): Promise<number> {
  const st = storage ?? await defaultStorage();
  const { ListObjectsV2Command, DeleteObjectsCommand } = await import('@aws-sdk/client-s3');
  const limite = now.getTime() - EXPORT_RETENTION_DAYS * 24 * 60 * 60_000;
  let token: string | undefined;
  let n = 0;
  do {
    const r = await st.client.send(new ListObjectsV2Command({ Bucket: st.bucket, Prefix: EXECUTIONS_EXPORT_PREFIX, ContinuationToken: token })) as {
      Contents?: Array<{ Key?: string; LastModified?: Date }>; IsTruncated?: boolean; NextContinuationToken?: string;
    };
    const old = (r.Contents ?? []).filter((o) => o.Key && o.LastModified && o.LastModified.getTime() < limite).map((o) => ({ Key: o.Key! }));
    if (old.length) { await st.client.send(new DeleteObjectsCommand({ Bucket: st.bucket, Delete: { Objects: old, Quiet: true } })); n += old.length; }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return n;
}

/**
 * Lot 99A — usage de l'IA d'une exécution en compteurs DISTINCTS (pure) :
 * appels réels au fournisseur (traces `ai_usage_event` corrélées), réponses
 * servies par le cache et décisions réutilisées (résumé métier des travaux).
 */
export function aiUsageOfJobs(providerCalls: number, jobs: ReadonlyArray<Record<string, unknown>>): {
  providerCalls: number; cacheResponses: number; decisionsReused: number; withoutAiCall: boolean;
} {
  let cache = 0;
  let reutilisees = 0;
  for (const j of jobs) {
    const raw = j.business_result_detail;
    const d = (typeof raw === 'string' ? (() => { try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; } })() : raw) as Record<string, unknown> | null;
    if (!d) continue;
    cache += Number(d.aiCacheResponses ?? 0) || 0;
    reutilisees += Number(d.aiDecisionsReused ?? 0) || 0;
  }
  return { providerCalls, cacheResponses: cache, decisionsReused: reutilisees, withoutAiCall: providerCalls === 0 };
}
