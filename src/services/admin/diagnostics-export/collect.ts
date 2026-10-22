/**
 * Lot 77C — génération d'un diagnostic technique (BO › Supervision ›
 * Diagnostics techniques). Serveur uniquement.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ASSEMBLAGE DE L'EXISTANT, LECTURE SEULE, BORNÉ
 *
 *   · périmètre résolu en base (bien, document, Opération → compte ;
 *     utilisateur → ses comptes) ; objet inexistant → `DiagTargetNotFoundError` ;
 *   · journaux et traitements : `admin_anomalies`, `ai_job_queue`,
 *     `ai_execution_reports` (+ lignes), `ai_usage_event`, `ai_operation`,
 *     `ai_call_diagnostics` (métadonnées), `scheduled_task_state`,
 *     `ai_config_versions` — colonnes LISTÉES (liste blanche), filtrées par
 *     période, compte(s), objets liés et traitement ;
 *   · données métier : dossiers d'entité « Données du compte »
 *     (`buildEntityDossier`, même masquage) ;
 *   · TCO : `readAssetTco` (moteur existant) et traçabilité de chaque ligne
 *     (`trace.ts`) ;
 *   · une transaction READ ONLY par lot de lectures (points de reprise : une
 *     section en erreur est signalée, les suivantes restent lues ; une
 *     tentative d'écriture est une erreur de programmation, jamais masquée) ;
 *   · masquage complet (`maskForExport`) avant sérialisation ; taille totale
 *     bornée (`DIAG_LIMITS.totalBytes`) ; générations simultanées bornées.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { randomUUID } from 'node:crypto';
import type { DiagQuery } from '@/services/business-operations/diagnostics/service';
import { getBuildIdentity } from '@/lib/runtime-identity';
import { RESTORE_AUDIT_ACTION, RESTORE_AUDIT_TARGET } from '@/services/business-operations/identity-restore.model';
import {
  DIAG_LIMITS, DIAG_SCHEMA, DIAG_SCOPE_LABELS, MASKING_NOTES, READ_ONLY_NOTE, buildReportText, leaksSecretOrEmail, maskForExport, maskText,
  periodBounds, toJsonFile, type AmountTrace, type DiagFileInfo, type DiagManifest, type DiagRequest, type DiagUnavailable,
} from './model';
import { REPORT_COLS, USAGE_COLS, jsonRows, loadTcoContext, tcoSummary, traceComponent, traceTcoLine, type TcoContext } from './trace';

type Row = Record<string, unknown>;

export class DiagTargetNotFoundError extends Error {
  constructor(what: string) { super(`${what} introuvable.`); this.name = 'DiagTargetNotFoundError'; }
}
export class DiagTooLargeError extends Error {
  constructor(public bytes: number) { super('Diagnostic trop volumineux.'); this.name = 'DiagTooLargeError'; }
}
export class DiagBusyError extends Error {
  constructor() { super('Génération déjà en cours.'); this.name = 'DiagBusyError'; }
}

export interface DiagBundle {
  manifest: DiagManifest;
  report: string;
  /** Fichiers de l'archive (contenu sérialisé, déjà masqué). */
  files: Array<{ path: string; content: string }>;
  totalBytes: number;
}

/** Session de lecture : requêtes + point de reprise (null : sans reprise). */
type Session = <T>(fn: (q: DiagQuery, savepoint: (<R>(f: (q: DiagQuery) => Promise<R>) => Promise<R>) | null) => Promise<T>) => Promise<T>;

export interface GenerateOptions {
  adminUserId: number;
  now?: () => Date;
  /** TCO : date du jour imposée (tests). */
  today?: string;
  session?: Session;
}

let running = 0;

const ids = (rows: Row[], k = 'id'): number[] => [...new Set(rows.map((r) => Number(r[k])).filter((n) => Number.isSafeInteger(n) && n > 0))];
const N = (v: unknown) => Number(v ?? 0);

interface Perimeter {
  label: string;
  accountIds: number[];
  assetIds: number[];
  equipmentIds: number[];
  fileIds: number[];
  operationIds: number[];
  userId: number | null;
}

// ── Résolution du périmètre ─────────────────────────────────────────────────

async function resolvePerimeter(q: DiagQuery, r: DiagRequest): Promise<Perimeter> {
  const p: Perimeter = { label: DIAG_SCOPE_LABELS.global, accountIds: [], assetIds: [], equipmentIds: [], fileIds: [], operationIds: [], userId: null };
  const id = r.id ?? 0;
  const B = 2000;
  if (r.scope === 'user') {
    const [u] = await q(`SELECT id FROM users WHERE id = $1`, [id]);
    if (!u) throw new DiagTargetNotFoundError('Utilisateur');
    p.userId = id;
    p.accountIds = ids(await q(`SELECT DISTINCT account_id AS id FROM account_memberships WHERE user_id = $1 ORDER BY 1 LIMIT ${DIAG_LIMITS.userAccounts}`, [id]));
    p.label = `Utilisateur #${id} — ${p.accountIds.length} compte(s)`;
  } else if (r.scope === 'asset') {
    const [a] = await q(`SELECT id, account_id FROM assets WHERE id = $1`, [id]);
    if (!a) throw new DiagTargetNotFoundError('Bien');
    const A = N(a.account_id);
    p.accountIds = [A];
    p.assetIds = [id];
    p.equipmentIds = ids(await q(`SELECT e.id FROM equipments e WHERE e.asset_id = $1 ORDER BY e.id LIMIT ${B}`, [id]));
    p.fileIds = ids(await q(`
      SELECT id FROM asset_files WHERE account_id = $1 AND (asset_id = $2 OR linked_asset_id = $2 OR equipment_id = ANY($3::int[]))
      UNION SELECT file_id FROM document_asset_links WHERE account_id = $1 AND (asset_id = $2 OR equipment_id = ANY($3::int[]))
      ORDER BY 1 LIMIT ${B}`, [A, id, p.equipmentIds]));
    p.operationIds = ids(await q(`
      SELECT operation_id AS id FROM business_operation_asset_links WHERE account_id = $1 AND asset_id = $2
      UNION SELECT operation_id FROM business_operation_equipment_links WHERE account_id = $1 AND (asset_id = $2 OR equipment_id = ANY($3::int[]))
      ORDER BY 1 LIMIT ${B}`, [A, id, p.equipmentIds]));
    p.label = `Bien #${id} (compte #${A}) — ${p.equipmentIds.length} équipement(s), ${p.fileIds.length} document(s), ${p.operationIds.length} Opération(s)`;
  } else if (r.scope === 'document') {
    const [f] = await q(`SELECT id, account_id, asset_id, linked_asset_id, equipment_id FROM asset_files WHERE id = $1`, [id]);
    if (!f) throw new DiagTargetNotFoundError('Document');
    const A = N(f.account_id);
    p.accountIds = [A];
    p.fileIds = [id];
    p.equipmentIds = ids(await q(`SELECT equipment_id AS id FROM asset_files WHERE id = $2 AND account_id = $1 AND equipment_id IS NOT NULL
                                  UNION SELECT equipment_id FROM document_asset_links WHERE account_id = $1 AND file_id = $2 AND equipment_id IS NOT NULL`, [A, id]));
    p.assetIds = ids(await q(`
      SELECT a.id FROM assets a WHERE a.account_id = $1 AND (a.id IN ($3::int, $4::int)
         OR a.id IN (SELECT asset_id FROM document_asset_links WHERE account_id = $1 AND file_id = $2)
         OR a.id IN (SELECT asset_id FROM equipments WHERE id = ANY($5::int[])))
      ORDER BY a.id LIMIT ${B}`, [A, id, num0(f.asset_id), num0(f.linked_asset_id), p.equipmentIds]));
    p.operationIds = ids(await q(`
      SELECT operation_id AS id FROM business_operation_sources WHERE account_id = $1 AND source_kind = 'DOCUMENT' AND source_entity_key = ($2::int)::text
      UNION SELECT t3_operation_id FROM document_operation_candidates WHERE account_id = $1 AND file_id = $2 AND t3_operation_id IS NOT NULL
      ORDER BY 1 LIMIT ${B}`, [A, id]));
    p.label = `Document #${id} (compte #${A}) — ${p.assetIds.length} bien(s), ${p.operationIds.length} Opération(s)`;
  } else if (r.scope === 'operation') {
    const [o] = await q(`SELECT id, account_id FROM business_operations WHERE id = $1`, [id]);
    if (!o) throw new DiagTargetNotFoundError('Opération');
    const A = N(o.account_id);
    p.accountIds = [A];
    p.operationIds = [id];
    p.equipmentIds = ids(await q(`
      SELECT equipment_id AS id FROM business_operation_equipment_links WHERE account_id = $1 AND operation_id = $2
      UNION SELECT target_equipment_id FROM business_operation_financial_components WHERE account_id = $1 AND operation_id = $2 AND target_equipment_id IS NOT NULL`, [A, id]));
    p.assetIds = ids(await q(`
      SELECT asset_id AS id FROM business_operation_asset_links WHERE account_id = $1 AND operation_id = $2
      UNION SELECT asset_id FROM business_operation_equipment_links WHERE account_id = $1 AND operation_id = $2
      UNION SELECT target_asset_id FROM business_operation_financial_components WHERE account_id = $1 AND operation_id = $2 AND target_asset_id IS NOT NULL
      ORDER BY 1`, [A, id]));
    p.fileIds = ids(await q(`
      SELECT (source_entity_key)::int AS id FROM business_operation_sources WHERE account_id = $1 AND operation_id = $2 AND source_kind = 'DOCUMENT' AND source_entity_key ~ '^[0-9]{1,9}$'
      UNION SELECT file_id FROM document_operation_candidates WHERE account_id = $1 AND t3_operation_id = $2
      ORDER BY 1 LIMIT ${B}`, [A, id]));
    p.label = `Opération #${id} (compte #${A}) — ${p.assetIds.length} bien(s), ${p.fileIds.length} document(s) source`;
  }
  return p;
}
const num0 = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

// ── Génération ──────────────────────────────────────────────────────────────

export async function generateDiagnostic(req: DiagRequest, opts: GenerateOptions): Promise<DiagBundle> {
  if (running >= DIAG_LIMITS.concurrent) throw new DiagBusyError();
  running++;
  try {
    return await generate(req, opts);
  } finally {
    running--;
  }
}

async function generate(req: DiagRequest, opts: GenerateOptions): Promise<DiagBundle> {
  const { isSensitiveCanonicalKey, readOnlyDossierExecutor, buildEntityDossier, EntityNotFoundError } = await import('@/services/admin/account-data/dossier');
  const session: Session = opts.session ?? (readOnlyDossierExecutor() as unknown as Session);
  const now = (opts.now ?? (() => new Date()))();
  const generationId = randomUUID();
  const { start, end } = periodBounds(req);
  const L = DIAG_LIMITS.listRows;
  const T = req.treatments.length ? req.treatments : null;

  const files = new Map<string, unknown>();
  const infos: DiagFileInfo[] = [];
  const warnings: string[] = [];
  const unavailable: DiagUnavailable[] = [];
  const add = (path: string, description: string, value: unknown, count?: number, complete = true) => {
    files.set(path, value);
    infos.push({ path, description, ...(count !== undefined ? { count } : {}), complete });
    if (!complete) warnings.push(`${path} : borne atteinte (${count ?? '?'} élément(s) exportés) — réduisez la période ou le périmètre.`);
  };
  const list = (path: string, description: string, rows: Row[], limit: number = L) => add(path, description, rows, rows.length, rows.length < limit);

  // 1. Périmètre (transaction de lecture dédiée).
  const per = await session((q) => resolvePerimeter(q, req));
  const accounts = per.accountIds.length ? per.accountIds : null;
  const entityScope = req.scope === 'asset' || req.scope === 'document' || req.scope === 'operation';

  // 2. Journaux, traitements, IA (une transaction READ ONLY, points de reprise).
  const collected = await session(async (q0, savepoint) => {
    let q = q0;
    const part = async <R>(nom: string, fn: (q: DiagQuery) => Promise<R>, fallback: R): Promise<R> => {
      const outer = q;
      try {
        return savepoint ? await savepoint(async (sq) => { q = sq; try { return await fn(sq); } finally { q = outer; } }) : await fn(q);
      } catch (e) {
        if ((e as { code?: string })?.code === '25006') throw e;
        const code = (e as { code?: string })?.code;
        console.error(`[admin/diagnostics] ${nom} :`, (e as Error)?.message ?? e);
        warnings.push(`${nom} : lecture impossible${code ? ` (${code})` : ''} — section absente de l’archive.`);
        return fallback;
      }
    };
    const accFilter = (col = 'account_id') => `($1::int[] IS NULL OR ${col} = ANY($1::int[]))`;

    const ctxTech = await part('contexte technique', async (sq) => {
      const [db] = await sq(`SELECT current_setting('server_version') AS version, now() AS maintenant`);
      const tasks = await jsonRows(sq, `SELECT code, next_run_at, last_trigger, last_started_at, last_finished_at, last_duration_ms, last_status,
                                               left(last_error, 300) AS last_error, last_success_at, consecutive_failures FROM scheduled_task_state ORDER BY code LIMIT 200`, []);
      const queue = await jsonRows(sq, `SELECT treatment, status, count(*)::int AS n, min(created_at) AS plus_ancien FROM ai_job_queue
                                         WHERE ${accFilter()} AND status IN ('PENDING', 'RUNNING', 'FAILED') GROUP BY 1, 2 ORDER BY 1, 2`, [accounts]);
      const configs = await jsonRows(sq, `SELECT id, uid, environment, status, visible_number, label, base_version_id, created_at FROM ai_config_versions
                                           WHERE status = 'ACTIVE' OR id IN (SELECT DISTINCT config_version_id FROM ai_job_queue WHERE ${accFilter()} AND created_at >= $2 AND created_at < $3)
                                           ORDER BY id DESC LIMIT 50`, [accounts, start, end]);
      return { baseDeDonnees: { version: db?.version ?? null, horloge: db?.maintenant ?? null }, tachesPlanifiees: tasks, fileEnAttente: queue, versionsConfigurationIA: configs };
    }, null);

    const anomalies = await part('anomalies de supervision', (sq) => jsonRows(sq, `
      SELECT id, domain, fingerprint, title, status, account_id, user_id, technical_detail, occurrence_count, first_seen_at, last_seen_at,
             resolved_at, resolution_source, auto_resolution_origin, auto_resolution_cause, previous_anomaly_id
        FROM admin_anomalies
       WHERE (${accFilter()} ${per.userId ? 'OR user_id = $4' : ''})
         AND last_seen_at >= $2 AND first_seen_at < $3
       ORDER BY last_seen_at DESC, id DESC LIMIT ${L}`, per.userId ? [accounts, start, end, per.userId] : [accounts, start, end]), [] as Row[]);

    // Objets liés (périmètres ciblés) : cibles des jobs, rapports, appels.
    const assetsT = per.assetIds.map(String);
    const equipT = per.equipmentIds.map(String);
    const filesT = per.fileIds.map(String);
    const jobTarget = entityScope ? `AND ((lower(target_type) = 'asset' AND target_id = ANY($5::text[]))
         OR (lower(target_type) = 'equipment' AND target_id = ANY($6::text[]))
         OR (lower(target_type) IN ('asset_file', 'document') AND target_id = ANY($7::text[]))
         OR lower(target_type) LIKE 'business_operations%')` : '';
    const jobs = await part('file des traitements', (sq) => jsonRows(sq, `
      SELECT id, treatment, account_id, target_type, target_id, status, origin, trigger_code, config_version_id, attempts, left(last_error, 500) AS last_error,
             business_result, execution_id, recovered_count, coalesce_requested, created_at, available_at, started_at, finished_at,
             payload -> 'events' -> -1 ->> 'correlationId' AS correlation_id
        FROM ai_job_queue
       WHERE ${accFilter()} AND created_at >= $2 AND created_at < $3 AND ($4::text[] IS NULL OR treatment = ANY($4::text[])) ${jobTarget}
       ORDER BY id DESC LIMIT ${L}`, entityScope ? [accounts, start, end, T, assetsT, equipT, filesT] : [accounts, start, end, T]), [] as Row[]);

    const reportTarget = entityScope ? `AND (asset_id = ANY($5::int[]) OR file_id = ANY($6::int[]) OR (upper(target_type) = 'EQUIPMENT' AND target_id = ANY($7::int[])))` : '';
    const reports = await part('rapports d’exécution T1 / T3', (sq) => jsonRows(sq, `
      SELECT ${REPORT_COLS} FROM ai_execution_reports
       WHERE ${accFilter()} AND created_at >= $2 AND created_at < $3 AND ($4::text[] IS NULL OR treatment = ANY($4::text[])) ${reportTarget}
       ORDER BY id DESC LIMIT ${L}`, entityScope ? [accounts, start, end, T, per.assetIds, per.fileIds, per.equipmentIds] : [accounts, start, end, T]), [] as Row[]);
    const reportEntries = entityScope && reports.length ? await part('lignes des rapports d’exécution', async (sq) => {
      const out: Row[] = [];
      for (const r of reports.slice(0, DIAG_LIMITS.reportsWithEntries)) {
        const rows = await jsonRows(sq, `
          SELECT $1::bigint AS report_id, seq, section, table_name, record_id, column_path, field_key, label, entity_type, entity_id,
                 old_value, value, value_type, value_chars, record_status, write_result, reason_code, reason, links
            FROM ai_execution_report_entries WHERE report_id = $2 AND account_id = $3 ORDER BY seq LIMIT ${DIAG_LIMITS.reportEntries}`,
        [N(r.id), N(r.entries_report_id ?? r.id), N(r.account_id ?? per.accountIds[0])]);
        out.push(...rows);
      }
      return out;
    }, [] as Row[]) : [];

    const extractions = per.fileIds.length ? await part('extractions T1 (modèle, version de prompt)', (sq) => jsonRows(sq, `
      SELECT id, file_id, analysis_run_id, engine, provider, model, prompt_version, operation_trace_id, amount_cents, currency, document_date, supplier_name,
             document_type_code, fact_count, full_text_chars, extracted_at
        FROM document_extractions WHERE account_id = ANY($1::int[]) AND file_id = ANY($2::int[]) ORDER BY file_id LIMIT ${L}`, [per.accountIds, per.fileIds]), [] as Row[]) : [];
    const traceIds = [...new Set([
      ...extractions.map((e) => e.operation_trace_id),
      ...reports.flatMap((r) => (Array.isArray(r.trace_ids) ? r.trace_ids : [])),
    ].filter((t): t is string => typeof t === 'string' && t.length > 0))];
    const jobIds = ids(jobs);

    const usageTarget = entityScope ? `AND (asset_file_id = ANY($4::int[]) OR metadata->>'traceId' = ANY($5::text[]) OR job_id = ANY($6::int[]))` : '';
    const calls = await part('appels IA (ai_usage_event)', (sq) => jsonRows(sq, `
      SELECT ${USAGE_COLS} FROM ai_usage_event
       WHERE ${accFilter()} AND created_at >= $2 AND created_at < $3 ${usageTarget}
       ORDER BY id DESC LIMIT ${L}`, entityScope ? [accounts, start, end, per.fileIds, traceIds, jobIds] : [accounts, start, end]), [] as Row[]);
    const callsAgg = !entityScope ? await part('agrégats des appels IA', (sq) => jsonRows(sq, `
      SELECT provider, model, operation_code, status, count(*)::int AS appels, sum(coalesce(cost_micros, 0))::bigint AS cout_micros, max(created_at) AS dernier
        FROM ai_usage_event WHERE ${accFilter()} AND created_at >= $2 AND created_at < $3
       GROUP BY 1, 2, 3, 4 ORDER BY appels DESC LIMIT ${L}`, [accounts, start, end]), [] as Row[]) : [];
    const aiOps = await part('opérations IA (ai_operation)', (sq) => jsonRows(sq, `
      SELECT id, public_id, account_id, user_id, asset_file_id, operation_category, pipeline_version, started_at, completed_at, duration_ms, business_result,
             provider_primary, provider_fallback, used_fallback, is_reanalysis, reanalysis_reason, origin, environment, error_code, left(warning_message, 300) AS warning_message
        FROM ai_operation
       WHERE ${accFilter()} AND created_at >= $2 AND created_at < $3 ${entityScope ? 'AND asset_file_id = ANY($4::int[])' : ''}
       ORDER BY id DESC LIMIT ${L}`, entityScope ? [accounts, start, end, per.fileIds] : [accounts, start, end]), [] as Row[]);
    const callDiags = await part('diagnostics d’appels IA (sans sortie)', (sq) => jsonRows(sq, `
      SELECT id, created_at, trace_id, usage_event_id, call_index, call_kind, account_id, use_case_code, operation_code, task, model, model_rank, outcome,
             failure_family, failure_subtype, failure_stage, signature, source_ids, schema_name, schema_version, schema_hash, contract_id, contract_version,
             output_chars, (raw_output IS NOT NULL OR extracted_output IS NOT NULL OR parsed_output IS NOT NULL) AS sortie_conservee
        FROM ai_call_diagnostics
       WHERE ${accFilter()} AND created_at >= $2 AND created_at < $3 ${entityScope ? 'AND (trace_id = ANY($4::text[]) OR source_ids && $5::int[])' : ''}
       ORDER BY id DESC LIMIT ${L}`, entityScope ? [accounts, start, end, traceIds, per.fileIds] : [accounts, start, end]), [] as Row[]);
    const history = per.operationIds.length ? await part('historique des Opérations', (sq) => jsonRows(sq, `
      SELECT id, operation_id, event_type, reason_code, source_id, actor_user_id, before_json, after_json, correlation_id, created_at
        FROM business_operation_history WHERE account_id = ANY($1::int[]) AND operation_id = ANY($2::bigint[]) AND created_at >= $3 AND created_at < $4
       ORDER BY created_at DESC, id DESC LIMIT ${L}`, [per.accountIds, per.operationIds, start, end]), [] as Row[]) : [];

    // Lot 78A (§6) : identité économique — candidats T1 (origine, décision et
    // contrôles d'identité, nature déterministe / IA), sources rattachées,
    // provenance des valeurs, journal des séparations / doutes / doublons.
    const identite = per.operationIds.length || per.fileIds.length ? await part('identité économique des Opérations', async (sq) => {
      const [j] = await sq(`SELECT to_regclass('business_operation_identity_reviews') IS NOT NULL AS ok`);
      const journal = j?.ok ? await jsonRows(sq, `
        SELECT id, operation_id, target_operation_id, kind, status, file_id, candidate_key, source_id, basis, signals, against_source_ids,
               review_version, correlation_id, resolved_by_admin_id, created_at, updated_at, resolved_at
          FROM business_operation_identity_reviews
         WHERE account_id = ANY($1::int[]) AND (operation_id = ANY($2::bigint[]) OR target_operation_id = ANY($2::bigint[]) OR file_id = ANY($3::int[]))
         ORDER BY id DESC LIMIT ${L}`, [per.accountIds, per.operationIds, per.fileIds]) : [];
      const provenance = await jsonRows(sq, `
        SELECT o.id AS operation_id, o.type_code, o.provider, o.technical_label, o.planned_date, o.start_date, o.realized_date, o.end_date,
               to_jsonb(o) -> 'attribute_provenance' AS provenance
          FROM business_operations o WHERE o.account_id = ANY($1::int[]) AND o.id = ANY($2::bigint[]) ORDER BY o.id LIMIT ${L}`, [per.accountIds, per.operationIds]);
      const sources = await jsonRows(sq, `
        SELECT s.id, s.operation_id, s.source_kind, s.source_entity_key, s.locator->>'candidateKey' AS candidate_key, s.source_role, s.authority, s.confidence,
               s.match_method, s.match_reason, s.active, s.superseded_at, s.created_at,
               CASE WHEN s.match_method = 'M3' THEN 'IA' WHEN s.match_method = 'M0' THEN 'UTILISATEUR' WHEN s.match_method IN ('M1', 'M2') THEN 'DETERMINISTE'
                    WHEN s.match_method IS NULL AND s.source_kind = 'DOCUMENT' THEN 'CREATION' ELSE 'AUTRE' END AS nature_decision,
               (SELECT h.reason_code FROM business_operation_history h WHERE h.source_id = s.id AND h.event_type = 'SOURCE_REMOVED' ORDER BY h.id DESC LIMIT 1) AS motif_retrait
          FROM business_operation_sources s WHERE s.account_id = ANY($1::int[]) AND s.operation_id = ANY($2::bigint[]) ORDER BY s.operation_id, s.id LIMIT ${L}`,
      [per.accountIds, per.operationIds]);
      const candidats = await jsonRows(sq, `
        SELECT c.id, c.file_id, c.candidate_key, c.extraction_id, c.analysis_run_id, c.status, c.established, c.confidence, c.type_hint, c.status_hint,
               c.payload->'origin' AS origine_t1, c.payload->'evidenceFactIds' AS faits_preuve, c.payload->'adjustments' AS corrections_barriere,
               c.t3_outcome, c.t3_reason, c.t3_operation_id, c.t3_detail->'matchMethod' AS methode, c.t3_detail->'certain' AS certains,
               c.t3_detail->'identity' AS controles_identite, c.t3_detail->'excluded' AS exclus, c.t3_detail->'plausible' AS plausibles,
               c.t3_detail->'m3' AS verdict_ia, c.t3_detail->>'identityReview' AS version_controle, c.t3_processed_at, c.created_at, c.superseded_at
          FROM document_operation_candidates c
         WHERE c.account_id = ANY($1::int[]) AND (c.file_id = ANY($2::int[]) OR c.t3_operation_id = ANY($3::bigint[]))
         ORDER BY c.file_id, c.id DESC LIMIT ${L}`, [per.accountIds, per.fileIds, per.operationIds]);
      // Lot 79A : rétablissements BO des séparations (journal d'audit admin) — administrateur (identifiant), motif, avant / après.
      const ids = journal.map((x) => Number(x.id)).filter((x) => Number.isSafeInteger(x));
      const retablissements = ids.length ? (await jsonRows(sq, `
        SELECT id, "timestamp" AS horodatage, admin_user_id, target_id AS separation_id, result AS resultat, details, old_value AS avant, new_value AS apres
          FROM admin_audit_log
         WHERE action_type = '${RESTORE_AUDIT_ACTION}' AND target_type = '${RESTORE_AUDIT_TARGET}' AND target_id = ANY($1::int[])
         ORDER BY id DESC LIMIT ${L}`, [ids])).map(({ details, ...x }) => {
        let d: Record<string, unknown> = {};
        try { d = typeof details === 'string' ? JSON.parse(details) as Record<string, unknown> : {}; } catch { d = {}; }
        return { ...x, motif: d.reason ?? null, code: d.code ?? null, operation_affichee: d.viewedOperationId ?? d.operationId ?? null };
      }) : [];
      return { journal, provenance, sources, candidats, retablissements };
    }, null) : null;

    // Données métier hors dossiers (utilisateur, global).
    let metier: Row | null = null;
    if (req.scope === 'user' && per.userId) {
      metier = await part('utilisateur et comptes', async (sq) => {
        const user = (await jsonRows(sq, `SELECT id, email, role, status, is_active, plan_type, locale, created_at, last_login_at FROM users WHERE id = $1`, [per.userId]))[0] ?? null;
        const memberships = await jsonRows(sq, `SELECT id, account_id, role, status, joined_at, removed_at FROM account_memberships WHERE user_id = $1 ORDER BY id LIMIT 50`, [per.userId]);
        const comptes = await jsonRows(sq, `
          SELECT a.id, a.owner_user_id, a.created_at,
                 (SELECT count(*)::int FROM assets x WHERE x.account_id = a.id) AS biens,
                 (SELECT count(*)::int FROM equipments e JOIN assets x ON x.id = e.asset_id WHERE x.account_id = a.id) AS equipements,
                 (SELECT count(*)::int FROM asset_files f WHERE f.account_id = a.id) AS documents,
                 (SELECT count(*)::int FROM business_operations o WHERE o.account_id = a.id) AS operations,
                 (SELECT count(*)::int FROM agenda_items i WHERE i.account_id = a.id) AS echeances
            FROM accounts a WHERE a.id = ANY($1::int[]) ORDER BY a.id`, [per.accountIds]);
        const biens = await jsonRows(sq, `SELECT id, account_id, name, category, status, created_at, deleted_at FROM assets WHERE account_id = ANY($1::int[]) ORDER BY id LIMIT ${L}`, [per.accountIds]);
        return { utilisateur: user, adhesions: memberships, comptes, biens };
      }, null);
    } else if (req.scope === 'global') {
      metier = await part('volumétrie globale', async (sq) => {
        const [c] = await sq(`SELECT (SELECT count(*)::int FROM accounts) AS comptes, (SELECT count(*)::int FROM users) AS utilisateurs,
                                     (SELECT count(*)::int FROM assets WHERE deleted_at IS NULL) AS biens, (SELECT count(*)::int FROM asset_files WHERE deleted_at IS NULL) AS documents,
                                     (SELECT count(*)::int FROM business_operations WHERE invalidated_at IS NULL AND merged_into_operation_id IS NULL) AS operations_actives`);
        const parTraitement = await jsonRows(sq, `SELECT treatment, status, count(*)::int AS n FROM ai_job_queue WHERE created_at >= $1 AND created_at < $2 AND ($3::text[] IS NULL OR treatment = ANY($3::text[])) GROUP BY 1, 2 ORDER BY 1, 2`, [start, end, T]);
        const rapports = await jsonRows(sq, `SELECT treatment, status, count(*)::int AS n FROM ai_execution_reports WHERE created_at >= $1 AND created_at < $2 AND ($3::text[] IS NULL OR treatment = ANY($3::text[])) GROUP BY 1, 2 ORDER BY 1, 2`, [start, end, T]);
        const anomaliesOuvertes = await jsonRows(sq, `SELECT domain, count(*)::int AS n FROM admin_anomalies WHERE status = 'open' GROUP BY 1 ORDER BY 1`, []);
        return { volumetrie: c, traitementsSurLaPeriode: parTraitement, rapportsSurLaPeriode: rapports, anomaliesOuvertesParDomaine: anomaliesOuvertes };
      }, null);
    }
    // Lot 78C : état réel des évaluations T6 (en cours, en échec, terminées sur la période) et pré-génération associée.
    const t6 = await part('évaluations T6 (état réel)', async (sq) => ({
      evaluations: await jsonRows(sq, `
        SELECT agenda_item_id, account_id, status, left(context_fingerprint, 16) AS empreinte, left(evaluation_signature, 16) AS signature,
               attempts, run_id, mode, requested_at, started_at, finished_at, lease_until, next_attempt_at, last_error_kind,
               left(last_error, 300) AS last_error, last_outcome, trace_id, interrupted_count, updated_at
          FROM t6_evaluation_runs
         WHERE ${accFilter()} AND (status <> 'COMPLETED' OR updated_at >= $2)
         ORDER BY account_id, agenda_item_id LIMIT ${L}`, [accounts, start]),
      preGeneration: await jsonRows(sq, `
        SELECT account_id, reason, requested_at, processed_at, last_status, attempts, claimed_until,
               (processed_at IS NULL OR requested_at > processed_at) AS en_attente
          FROM home_mascot_pregen_requests WHERE ${accFilter()} ORDER BY requested_at DESC LIMIT ${L}`, [accounts]),
    }), null);
    return { ctxTech, anomalies, jobs, reports, reportEntries, extractions, calls, callsAgg, aiOps, callDiags, history, metier, traceIds, identite, t6 };
  });

  // 3. Dossiers d'entité (« Données du compte » : même moteur, même masquage).
  const dossier = async (path: string, type: 'asset' | 'equipment' | 'document' | 'operation', id: number) => {
    try {
      const d = await buildEntityDossier(per.accountIds[0], type, id, { limit: DIAG_LIMITS.dossierSectionRows });
      add(path, `Dossier ${type} #${id} (BO › Données du compte : synthèse, données BDD, relations, preuves)`, d, d.sections.length, d.complete);
      for (const w of d.warnings) warnings.push(`${path} : ${w}`);
    } catch (e) {
      if (e instanceof EntityNotFoundError) unavailable.push({ element: `${type} #${id}`, motif: 'introuvable dans le compte' });
      else { warnings.push(`${path} : dossier non généré (${(e as { code?: string })?.code ?? 'erreur de lecture'}).`); console.error('[admin/diagnostics] dossier :', (e as Error)?.message); }
    }
  };
  if (req.scope === 'asset' && req.id) {
    await dossier(`metier/bien-${req.id}.json`, 'asset', req.id);
    for (const e of per.equipmentIds.slice(0, DIAG_LIMITS.equipmentDossiers)) await dossier(`metier/equipements/equipement-${e}.json`, 'equipment', e);
    if (per.equipmentIds.length > DIAG_LIMITS.equipmentDossiers) warnings.push(`Équipements : ${DIAG_LIMITS.equipmentDossiers} dossiers joints sur ${per.equipmentIds.length} (borne).`);
  } else if (req.scope === 'document' && req.id) {
    await dossier(`metier/document-${req.id}.json`, 'document', req.id);
  } else if (req.scope === 'operation' && req.id) {
    await dossier(`metier/operation-${req.id}.json`, 'operation', req.id);
    for (const f of per.fileIds.slice(0, DIAG_LIMITS.documentDossiers)) await dossier(`metier/documents/document-${f}.json`, 'document', f);
    if (per.fileIds.length > DIAG_LIMITS.documentDossiers) warnings.push(`Documents sources : ${DIAG_LIMITS.documentDossiers} dossiers joints sur ${per.fileIds.length} (borne).`);
  }

  // 4. TCO et traçabilité des montants.
  const traces: AmountTrace[] = [];
  if (entityScope && per.accountIds.length) {
    const A = per.accountIds[0];
    const assets = per.assetIds.slice(0, req.scope === 'asset' ? 1 : DIAG_LIMITS.tcoAssets);
    if (per.assetIds.length > assets.length) warnings.push(`TCO : ${assets.length} bien(s) recalculé(s) sur ${per.assetIds.length} (borne).`);
    const ctxs: TcoContext[] = [];
    for (const a of assets) ctxs.push(await loadTcoContext(A, a, opts.today));
    for (const c of ctxs) if (c.unavailable) unavailable.push({ element: `TCO du bien #${c.assetId}`, motif: c.unavailable });
    if (!assets.length) unavailable.push({ element: 'TCO', motif: 'aucun bien rattaché à l’objet : aucun montant TCO à tracer' });
    await session(async (q0, savepoint) => {
      const run = <R>(fn: (q: DiagQuery) => Promise<R>): Promise<R> => (savepoint ? savepoint(fn) : fn(q0));
      const safe = async (what: string, fn: (q: DiagQuery) => Promise<AmountTrace[]>) => {
        try { traces.push(...(await run(fn))); } catch (e) {
          if ((e as { code?: string })?.code === '25006') throw e;
          warnings.push(`Traçabilité ${what} : lecture impossible (${(e as { code?: string })?.code ?? 'erreur'}).`);
          console.error('[admin/diagnostics] trace :', (e as Error)?.message);
        }
      };
      if (req.scope === 'operation' && req.id) {
        const comps = ids(await q0(`SELECT id FROM business_operation_financial_components WHERE account_id = $1 AND operation_id = $2 ORDER BY active DESC, id LIMIT 200`, [A, req.id]));
        if (!comps.length) unavailable.push({ element: `Composantes financières de l’Opération #${req.id}`, motif: 'aucune composante enregistrée : aucun montant de cette Opération ne peut entrer dans le TCO' });
        for (const c of comps) await safe(`composante #${c}`, (q) => traceComponent(q, A, c, ctxs));
      } else {
        for (const ctx of ctxs) {
          let lines = ctx.result?.lines ?? [];
          if (req.scope === 'document' && req.id) {
            const opIds = new Set(per.operationIds);
            lines = lines.filter((l) => l.fileId === req.id || l.relatedFileId === req.id || (l.operationId != null && opIds.has(l.operationId)));
          }
          if (lines.length > DIAG_LIMITS.tcoTracedLines) warnings.push(`TCO du bien #${ctx.assetId} : ${DIAG_LIMITS.tcoTracedLines} lignes tracées sur ${lines.length} (borne).`);
          for (const l of lines.slice(0, DIAG_LIMITS.tcoTracedLines)) await safe(`ligne ${l.id}`, async (q) => [await traceTcoLine(q, A, ctx, l)]);
        }
      }
    });
    add('tracabilite/tco.json', 'TCO recalculé (moteur existant) des biens concernés : synthèse, postes, fiabilité', ctxs.map(tcoSummary), ctxs.length);
    add('tracabilite/montants.json', 'Traçabilité de chaque montant : Document → Extraction IA → Décision → Enregistrement → Rapprochement → Calcul → Affichage ; valeurs source / proposée IA / enregistrée / calculée / affichée', traces, traces.length);
    const ruptures = traces.filter((t) => t.rupture);
    if (ruptures.length) unavailable.push({ element: `Traçabilité de ${ruptures.length} montant(s) sur ${traces.length}`, motif: 'au moins une étape non disponible (voir « rupture » de chaque ligne dans tracabilite/montants.json)' });
  }

  // 5. Diagnostic renforcé : sorties modèle conservées (accès existant, journalisé).
  if (req.reinforced) {
    const traceIds = collected.traceIds.slice(0, DIAG_LIMITS.modelOutputTraces);
    const callsByTrace = new Map<string, number>();
    for (const c of collected.calls) if (typeof c.trace_id === 'string' && !callsByTrace.has(c.trace_id)) callsByTrace.set(c.trace_id, N(c.id));
    const { readModelOutputsForAdmin } = await import('@/services/ai/telemetry/model-output-access');
    const sorties: Row[] = [];
    let refus = false;
    for (const t of traceIds) {
      const callId = callsByTrace.get(t);
      if (!callId) { unavailable.push({ element: `Sorties modèle de la trace ${t}`, motif: 'aucun appel IA corrélé conservé' }); continue; }
      const r = await readModelOutputsForAdmin({ adminUserId: opts.adminUserId, callId, purpose: 'export' });
      if (!r.ok) { if (r.code === 'FORBIDDEN') { refus = true; break; } unavailable.push({ element: `Sorties modèle de la trace ${t}`, motif: r.message }); continue; }
      const cut = (s: string | null) => (s === null ? null : s.length > DIAG_LIMITS.modelOutputChars ? `${s.slice(0, DIAG_LIMITS.modelOutputChars)}… [tronqué : ${s.length} caractères]` : s);
      for (const o of r.outputs) sorties.push({ trace: t, appel: callId, diagnostic: o.diagnosticId, modele: o.model, rang: o.callIndex, sortieBrute: cut(o.raw), sortieExtraite: cut(o.extracted), sortieStructuree: o.parsed });
    }
    if (refus) unavailable.push({ element: 'Diagnostic renforcé', motif: 'refusé : consultation des sorties modèle réservée (AI_MODEL_OUTPUT_ADMIN_IDS) — refus journalisé' });
    else if (!traceIds.length) unavailable.push({ element: 'Diagnostic renforcé', motif: 'aucune trace IA dans le périmètre et la période' });
    else if (!sorties.length) unavailable.push({ element: 'Diagnostic renforcé', motif: 'aucune sortie modèle conservée (rétention ai-call-diagnostics-purge, ou appels sans sortie)' });
    add('ia/sorties-modele.json', 'DIAGNOSTIC RENFORCÉ — sorties modèle conservées des traces du périmètre (accès AI_MODEL_OUTPUT_READ journalisé)', sorties, sorties.length, true);
  }

  // 6. Fichiers communs.
  const c = collected;
  if (c.metier) add(req.scope === 'user' ? 'metier/utilisateur.json' : 'metier/volumetrie.json', req.scope === 'user' ? 'Utilisateur (pseudonymisé), adhésions, comptes et biens' : 'Volumétrie globale et traitements de la période', c.metier);
  if (c.ctxTech) add('contexte-technique.json', 'Base de données, tâches planifiées, file en attente, versions de configuration IA actives ou utilisées', c.ctxTech);
  list('logs/anomalies-supervision.json', 'Anomalies de supervision (Dashboard › Supervision) de la période', c.anomalies);
  list('logs/traitements-file.json', 'File des traitements T1 / T3 / T4 (ai_job_queue) : statut, tentatives, erreur, corrélation', c.jobs);
  if (c.t6) add('ia/t6-evaluations.json', 'Évaluations T6 EVALUATE : état réel par échéance (PENDING, RUNNING, RETRY_WAIT, FAILED, COMPLETED, UNAVAILABLE), tentatives, erreurs, prochain essai ; pré-génération de l’accueil', c.t6, c.t6.evaluations.length, c.t6.evaluations.length < L);
  if (c.history.length || per.operationIds.length) list('logs/historique-operations.json', 'Historique des Opérations (business_operation_history) de la période', c.history);
  if (c.identite) {
    add('tracabilite/identite-economique.json',
      'Identité économique (lot 78A) : candidats T1 (origine, faits, décision T3, contrôles d’identité, nature déterministe / IA), sources rattachées et motifs de retrait, provenance des valeurs (dates, prestataire, libellé) et contradictions, journal des séparations / doutes / doublons et de leur traitement, rétablissements BO (lot 79A : administrateur, motif, avant / après)',
      c.identite, c.identite.journal.length + c.identite.sources.length + c.identite.candidats.length,
      c.identite.journal.length < L && c.identite.sources.length < L && c.identite.candidats.length < L);
  }
  list('ia/rapports-execution.json', 'Rapports d’exécution T1 / T3 (ai_execution_reports) — synthèse', c.reports);
  if (entityScope) add('ia/rapports-execution-lignes.json', `Lignes des rapports d’exécution (${DIAG_LIMITS.reportEntries} par rapport, ${DIAG_LIMITS.reportsWithEntries} rapports au plus)`, c.reportEntries, c.reportEntries.length,
    c.reports.length <= DIAG_LIMITS.reportsWithEntries);
  if (c.extractions.length) list('ia/extractions.json', 'Extractions T1 : fournisseur, modèle, version de prompt, trace, montant documentaire', c.extractions);
  list('ia/appels.json', 'Appels IA (ai_usage_event) : modèle, rang, prompt maître et version, trace, job, statut', c.calls);
  if (!entityScope) list('ia/appels-agreges.json', 'Appels IA agrégés par fournisseur, modèle, opération et statut', c.callsAgg);
  list('ia/operations-ia.json', 'Opérations IA (ai_operation) : pipeline, résultat métier, repli', c.aiOps);
  list('ia/diagnostics-appels.json', 'Diagnostics d’appels IA (ai_call_diagnostics) : contrat, schéma, échec — sans la sortie du modèle', c.callDiags);
  list('logs/chronologie.json', 'Chronologie corrélée (horodatage, table, identifiant, corrélations job / trace / document / Opération)', timeline(c), L * 6);

  // Limites connues (signalées, jamais comblées).
  if (!c.reports.length) unavailable.push({ element: 'Rapports d’exécution T1 / T3', motif: 'aucun rapport conservé sur la période (rétention ai-call-diagnostics-purge ou traitements antérieurs au lot 58C)' });
  // Lot 78A : le lien composante → indice T1 → fait est désormais persisté par T3 ; seules les
  // composantes non encore reconsolidées depuis (antérieures au lot 78A) restent sans lien.
  const sansLien = traces.filter((t) => {
    if (!String(t.ligne.id ?? '').startsWith('c:')) return false;
    const ext = t.chaine.find((x) => x.etape === 'EXTRACTION_IA');
    return !!ext && ext.statut !== 'sans_objet' && !(ext.donnees as { lienPersiste?: unknown } | undefined)?.lienPersiste;
  }).length;
  if (entityScope && sansLien) unavailable.push({ element: `Lien composante → indice T1 (${sansLien} montant(s))`, motif: 'non encore persisté (composante antérieure au lot 78A, pas encore reconsolidée) : indices du candidat exportés, correspondance de valeur signalée comme telle' });
  unavailable.push({ element: 'Documents originaux et texte intégral', motif: 'exclus par principe (sécurité) : seules les données structurées et extraits de preuve sont exportés' });

  // 7. Masquage, sérialisation, bornes.
  const env = (process.env.NEXT_PUBLIC_APP_ENV || process.env.NODE_ENV || 'inconnu').trim();
  const build = getBuildIdentity();
  const manifest: DiagManifest = {
    schema: DIAG_SCHEMA, generationId, generatedAt: now.toISOString(), environment: env,
    build: { version: build.version, commit: build.commit, commitSource: build.commitSource, container: build.container },
    request: { ...req, scopeLabel: DIAG_SCOPE_LABELS[req.scope] },
    target: { label: per.label, accountIds: per.accountIds },
    limits: DIAG_LIMITS, files: [], warnings, unavailable, masking: [...MASKING_NOTES], readOnly: READ_ONLY_NOTE,
  };
  const maskOpts = { isSensitiveKey: isSensitiveCanonicalKey };
  const out: Array<{ path: string; content: string }> = [];
  let total = 0;
  for (const info of infos) {
    const content = toJsonFile(maskForExport(files.get(info.path), maskOpts));
    total += Buffer.byteLength(content);
    if (total > DIAG_LIMITS.totalBytes) throw new DiagTooLargeError(total);
    out.push({ path: info.path, content });
  }
  manifest.files = [
    { path: 'rapport.txt', description: 'Rapport synthétique lisible (copiable)', complete: true },
    { path: 'manifeste.json', description: 'Contexte, filtres, bornes, fichiers, limites et masquage', complete: true },
    ...infos,
  ];
  const summary: Array<[string, string | number]> = [
    ['Objet', per.label],
    ['Anomalies de supervision', c.anomalies.length],
    ['Traitements (file)', c.jobs.length],
    ['Rapports d’exécution', c.reports.length],
    ['Appels IA', c.calls.length],
    ['Montants tracés', traces.length],
    ['Montants à trace interrompue', traces.filter((t) => t.rupture).length],
    ['Avertissements', warnings.length],
  ];
  const maskedTraces = maskForExport(traces, maskOpts) as AmountTrace[];
  const report = maskForExport(buildReportText(manifest, summary, maskedTraces), maskOpts) as string;
  const manifestJson = toJsonFile(maskForExport(manifest, maskOpts));
  out.unshift({ path: 'rapport.txt', content: report }, { path: 'manifeste.json', content: manifestJson });
  total += Buffer.byteLength(report) + Buffer.byteLength(manifestJson);
  if (total > DIAG_LIMITS.totalBytes) throw new DiagTooLargeError(total);
  // Contrôle de sortie : aucun secret ni e-mail en clair (le masquage est total ; ceci est une assertion).
  // Un motif résiduel (clé JSON portant un e-mail…) est masqué au niveau du texte ; le JSON doit rester valide.
  for (const f of out) {
    if (!leaksSecretOrEmail(f.content)) continue;
    f.content = maskText(f.content);
    if (f.path.endsWith('.json')) JSON.parse(f.content);
  }
  return { manifest, report, files: out, totalBytes: total };
}

/** Chronologie corrélée dérivée des lignes exportées (aucune donnée supplémentaire). */
function timeline(c: { anomalies: Row[]; jobs: Row[]; reports: Row[]; calls: Row[]; aiOps: Row[]; history: Row[] }): Row[] {
  const ev: Row[] = [];
  for (const a of c.anomalies) ev.push({ horodatage: a.last_seen_at, type: 'ANOMALIE', table: 'admin_anomalies', id: a.id, statut: a.status, compte: a.account_id, libelle: a.title });
  for (const j of c.jobs) {
    ev.push({ horodatage: j.created_at, type: `JOB_${j.treatment}_CREE`, table: 'ai_job_queue', id: j.id, statut: j.status, compte: j.account_id, correlation: { job: j.id, execution: j.execution_id, correlationId: j.correlation_id, cible: `${j.target_type}:${j.target_id}` } });
    if (j.finished_at) ev.push({ horodatage: j.finished_at, type: `JOB_${j.treatment}_TERMINE`, table: 'ai_job_queue', id: j.id, statut: j.status, resultat: j.business_result, erreur: j.last_error, correlation: { job: j.id } });
  }
  for (const r of c.reports) ev.push({ horodatage: r.created_at, type: `RAPPORT_${r.treatment}`, table: 'ai_execution_reports', id: r.id, statut: r.status, correlation: { job: r.job_id, traces: r.trace_ids, document: r.file_id, bien: r.asset_id, rapportT1Origine: r.origin_t1_report_id } });
  for (const u of c.calls) ev.push({ horodatage: u.created_at, type: 'APPEL_IA', table: 'ai_usage_event', id: u.id, statut: u.status, modele: u.model, correlation: { job: u.job_id, trace: u.trace_id, document: u.asset_file_id } });
  for (const o of c.aiOps) ev.push({ horodatage: o.started_at, type: 'OPERATION_IA', table: 'ai_operation', id: o.id, statut: o.business_result, correlation: { document: o.asset_file_id } });
  for (const h of c.history) ev.push({ horodatage: h.created_at, type: `OPERATION_${h.event_type}`, table: 'business_operation_history', id: h.id, motif: h.reason_code, correlation: { operation: h.operation_id, source: h.source_id, correlationId: h.correlation_id } });
  return ev.filter((e) => e.horodatage).sort((a, b) => String(a.horodatage).localeCompare(String(b.horodatage)));
}
