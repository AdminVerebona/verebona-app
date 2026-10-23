/**
 * Lots 77C, 81C — génération d'un diagnostic technique (BO › Supervision ›
 * Diagnostics techniques). Serveur uniquement.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ASSEMBLAGE DE L'EXISTANT, LECTURE SEULE, EXHAUSTIF (lot 81C)
 *
 *   · périmètre résolu en base, SANS borne (tous les équipements, documents
 *     et Opérations liés, dépendances indirectes : documents sources des
 *     Opérations, Opérations ciblant le bien par leurs composantes) ;
 *   · journaux et traitements : `admin_anomalies`, `ai_job_queue`,
 *     `ai_execution_reports` (+ lignes), `ai_usage_event`, `ai_operation`,
 *     `ai_call_diagnostics` (métadonnées), `scheduled_task_state`,
 *     `ai_config_versions` — colonnes LISTÉES (liste blanche), filtrées par
 *     période (ou tout l'historique), compte(s), objets liés et traitement ;
 *   · données métier : dossiers d'entité « Données du compte » (même moteur,
 *     même masquage, sections intégrales) ;
 *   · TCO : `readAssetTco` (moteur existant) et traçabilité de CHAQUE ligne ;
 *   · UNE session REPEATABLE READ READ ONLY (`openReadSession`) : un seul
 *     instantané pour tout le diagnostic ; points de reprise par fichier ;
 *   · PLAN puis PRODUCTION EN FLUX : le plan (périmètre, décomptes attendus,
 *     liste des fichiers et de leurs parties) est établi d'abord ; chaque
 *     fichier est ensuite produit à la demande, lot par lot, directement
 *     dans l'archive (`zip.ts`) — aucune construction intégrale en mémoire ;
 *   · par fichier : attendu, exporté, lots, statut COMPLETE / PARTIAL /
 *     FAILED, erreur, octets, SHA-256 ; manifeste et rapport en DERNIER ;
 *   · masquage complet (`maskForExport`) ligne par ligne, contrôle de sortie
 *     (aucun secret ni e-mail en clair).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash, randomUUID } from 'node:crypto';
import type { DiagQuery } from '@/services/business-operations/diagnostics/service';
import { getBuildIdentity } from '@/lib/runtime-identity';
import { RESTORE_AUDIT_ACTION, RESTORE_AUDIT_TARGET } from '@/services/business-operations/identity-restore.model';
import { globalStatus, sectionStatus, type ExtractionStatus } from '@/services/admin/account-data/model';
import { countRows, decodeJsonRow, jsonBatches, named, openReadSession, type ReadSession } from '@/services/admin/account-data/session';
import type { TextSink } from '@/services/admin/account-data/export';
import {
  DIAG_LIMITS, DIAG_REMOVED_CAPS, DIAG_SCHEMA, DIAG_SCOPE_LABELS, MASKING_NOTES, READ_ONLY_NOTE, buildReportTextFromLines, leaksSecretOrEmail, maskForExport, maskText,
  periodBounds, traceReportLines, type AmountTrace, type DiagFileInfo, type DiagManifest, type DiagRequest, type DiagUnavailable,
} from './model';
import { REPORT_COLS, USAGE_COLS, loadTcoContext, tcoSummary, traceComponent, traceTcoLine, type TcoContext } from './trace';

type Row = Record<string, unknown>;

export class DiagTargetNotFoundError extends Error {
  constructor(what: string) { super(`${what} introuvable.`); this.name = 'DiagTargetNotFoundError'; }
}
export class DiagBusyError extends Error {
  constructor() { super('Génération déjà en cours.'); this.name = 'DiagBusyError'; }
}

export interface DiagBundle {
  manifest: DiagManifest;
  report: string;
  /** Fichiers de l'archive (contenu sérialisé, déjà masqué) — génération EN MÉMOIRE (tests, petits volumes). */
  files: Array<{ path: string; content: string }>;
  totalBytes: number;
}

export interface GenerateOptions {
  adminUserId: number;
  now?: () => Date;
  /** TCO : date du jour imposée (tests). */
  today?: string;
  /** Session de lecture fournie (tests de panne) ; sinon une session est ouverte. */
  session?: ReadSession;
  /** Lignes par partie de fichier (tests du découpage). */
  partRows?: number;
  /** Lignes par lot (tests). */
  batchRows?: number;
}

const ids = (rows: Row[], k = 'id'): number[] => [...new Set(rows.map((r) => Number(r[k])).filter((n) => Number.isSafeInteger(n) && n > 0))];
const N = (v: unknown) => Number(v ?? 0);
const errCode = (e: unknown): string | undefined => (e as { code?: string })?.code;
const describe = (e: unknown): string => `${errCode(e) ? `${errCode(e)} — ` : ''}${(e as Error)?.message ?? String(e)}`.slice(0, 500);

export interface Perimeter {
  label: string;
  accountIds: number[];
  assetIds: number[];
  equipmentIds: number[];
  fileIds: number[];
  operationIds: number[];
  userId: number | null;
  /** Objets référencés mais absents du compte (signalés, jamais reconstruits). */
  missing: DiagUnavailable[];
}

// ── Résolution du périmètre (exhaustive) ────────────────────────────────────

export async function resolvePerimeter(q: DiagQuery, r: Pick<DiagRequest, 'scope' | 'id'>): Promise<Perimeter> {
  const p: Perimeter = { label: DIAG_SCOPE_LABELS.global, accountIds: [], assetIds: [], equipmentIds: [], fileIds: [], operationIds: [], userId: null, missing: [] };
  const id = r.id ?? 0;
  if (r.scope === 'user') {
    const [u] = await q(`SELECT id FROM users WHERE id = $1`, [id]);
    if (!u) throw new DiagTargetNotFoundError('Utilisateur');
    p.userId = id;
    p.accountIds = ids(await q(`SELECT DISTINCT account_id AS id FROM account_memberships WHERE user_id = $1 ORDER BY 1`, [id]));
    p.label = `Utilisateur #${id} — ${p.accountIds.length} compte(s)`;
  } else if (r.scope === 'asset') {
    const [a] = await q(`SELECT id, account_id FROM assets WHERE id = $1`, [id]);
    if (!a) throw new DiagTargetNotFoundError('Bien');
    const A = N(a.account_id);
    p.accountIds = [A];
    p.assetIds = [id];
    p.equipmentIds = ids(await q(`SELECT e.id FROM equipments e WHERE e.asset_id = $1 ORDER BY e.id`, [id]));
    // Opérations : liens bien / équipement, et composantes qui ciblent le bien ou ses équipements (TCO).
    p.operationIds = ids(await q(`
      SELECT operation_id AS id FROM business_operation_asset_links WHERE account_id = $1 AND asset_id = $2
      UNION SELECT operation_id FROM business_operation_equipment_links WHERE account_id = $1 AND (asset_id = $2 OR equipment_id = ANY($3::int[]))
      UNION SELECT operation_id FROM business_operation_financial_components WHERE account_id = $1 AND (target_asset_id = $2 OR target_equipment_id = ANY($3::int[]))
      ORDER BY 1`, [A, id, p.equipmentIds]));
    // Documents : rattachés au bien, à ses équipements ou pièces, liés, et sources documentaires de ses Opérations.
    p.fileIds = ids(await q(`
      SELECT id FROM asset_files WHERE account_id = $1 AND (asset_id = $2 OR linked_asset_id = $2 OR equipment_id = ANY($3::int[])
                                                       OR substructure_id IN (SELECT s.id FROM substructures s WHERE s.asset_id = $2))
      UNION SELECT file_id FROM document_asset_links WHERE account_id = $1 AND (asset_id = $2 OR equipment_id = ANY($3::int[])
                                                       OR substructure_id IN (SELECT s.id FROM substructures s WHERE s.asset_id = $2))
      UNION SELECT f.id FROM business_operation_sources s JOIN asset_files f ON f.account_id = s.account_id AND f.id = (CASE WHEN s.source_entity_key ~ '^[0-9]{1,9}$' THEN s.source_entity_key::int END)
             WHERE s.account_id = $1 AND s.source_kind = 'DOCUMENT' AND s.operation_id = ANY($4::bigint[])
      ORDER BY 1`, [A, id, p.equipmentIds, p.operationIds]));
    p.label = `Bien #${id} (compte #${A}) — ${p.equipmentIds.length} équipement(s), ${p.fileIds.length} document(s), ${p.operationIds.length} Opération(s)`;
  } else if (r.scope === 'document') {
    const [f] = await q(`SELECT id, account_id, asset_id, linked_asset_id, equipment_id FROM asset_files WHERE id = $1`, [id]);
    if (!f) throw new DiagTargetNotFoundError('Document');
    const A = N(f.account_id);
    p.accountIds = [A];
    p.fileIds = [id];
    p.equipmentIds = ids(await q(`SELECT equipment_id AS id FROM asset_files WHERE id = $2 AND account_id = $1 AND equipment_id IS NOT NULL
                                  UNION SELECT equipment_id FROM document_asset_links WHERE account_id = $1 AND file_id = $2 AND equipment_id IS NOT NULL ORDER BY 1`, [A, id]));
    p.assetIds = ids(await q(`
      SELECT a.id FROM assets a WHERE a.account_id = $1 AND (a.id IN ($3::int, $4::int)
         OR a.id IN (SELECT asset_id FROM document_asset_links WHERE account_id = $1 AND file_id = $2)
         OR a.id IN (SELECT asset_id FROM equipments WHERE id = ANY($5::int[])))
      ORDER BY a.id`, [A, id, num0(f.asset_id), num0(f.linked_asset_id), p.equipmentIds]));
    p.operationIds = ids(await q(`
      SELECT operation_id AS id FROM business_operation_sources WHERE account_id = $1 AND source_kind = 'DOCUMENT' AND source_entity_key = ($2::int)::text
      UNION SELECT t3_operation_id FROM document_operation_candidates WHERE account_id = $1 AND file_id = $2 AND t3_operation_id IS NOT NULL
      ORDER BY 1`, [A, id]));
    p.label = `Document #${id} (compte #${A}) — ${p.assetIds.length} bien(s), ${p.operationIds.length} Opération(s)`;
  } else if (r.scope === 'operation') {
    const [o] = await q(`SELECT id, account_id FROM business_operations WHERE id = $1`, [id]);
    if (!o) throw new DiagTargetNotFoundError('Opération');
    const A = N(o.account_id);
    p.accountIds = [A];
    p.operationIds = [id];
    p.equipmentIds = ids(await q(`
      SELECT equipment_id AS id FROM business_operation_equipment_links WHERE account_id = $1 AND operation_id = $2
      UNION SELECT target_equipment_id FROM business_operation_financial_components WHERE account_id = $1 AND operation_id = $2 AND target_equipment_id IS NOT NULL
      ORDER BY 1`, [A, id]));
    p.assetIds = ids(await q(`
      SELECT asset_id AS id FROM business_operation_asset_links WHERE account_id = $1 AND operation_id = $2
      UNION SELECT asset_id FROM business_operation_equipment_links WHERE account_id = $1 AND operation_id = $2
      UNION SELECT target_asset_id FROM business_operation_financial_components WHERE account_id = $1 AND operation_id = $2 AND target_asset_id IS NOT NULL
      ORDER BY 1`, [A, id]));
    const refs = ids(await q(`
      SELECT (source_entity_key)::int AS id FROM business_operation_sources WHERE account_id = $1 AND operation_id = $2 AND source_kind = 'DOCUMENT' AND source_entity_key ~ '^[0-9]{1,9}$'
      UNION SELECT file_id FROM document_operation_candidates WHERE account_id = $1 AND t3_operation_id = $2
      ORDER BY 1`, [A, id]));
    p.fileIds = refs.length ? ids(await q(`SELECT id FROM asset_files WHERE account_id = $1 AND id = ANY($2::int[]) ORDER BY id`, [A, refs])) : [];
    for (const f of refs.filter((x) => !p.fileIds.includes(x))) p.missing.push({ element: `document #${f}`, motif: 'introuvable dans le compte (supprimé définitivement ?) : source citée, dossier non disponible' });
    p.label = `Opération #${id} (compte #${A}) — ${p.assetIds.length} bien(s), ${p.fileIds.length} document(s) source`;
  }
  return p;
}
const num0 = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

// ── Production d'un fichier : statut, intégrité ─────────────────────────────

/** Fichier planifié de l'archive : produit À LA DEMANDE, dans l'ordre. */
export interface PlannedEntry {
  path: string;
  produce: (sink: TextSink) => Promise<void>;
}

interface EntryResult { expected: number | null; count?: number; batches: number; error: string | null; status?: ExtractionStatus }

/** Sérialisation sûre d'une ligne masquée : contrôle de sortie (aucun secret ni e-mail en clair), JSON toujours valide. */
function safeJson(v: unknown): string {
  const s = JSON.stringify(v);
  if (!leaksSecretOrEmail(s)) return s;
  const m = maskText(s);
  try { JSON.parse(m); return m; } catch { return JSON.stringify({ $etat: 'masque', motif: 'ligne masquée (motif de secret résiduel)' }); }
}

// ── Plan du diagnostic ──────────────────────────────────────────────────────

export interface DiagPlan {
  generationId: string;
  perimeter: Perimeter;
  /** Fichiers, dans l'ordre de production (rapport et manifeste en dernier). */
  entries: PlannedEntry[];
  /** Après production : manifeste et rapport. */
  result(): { manifest: DiagManifest; report: string };
  /** Une erreur fatale (écriture tentée, archive) : manifeste FAILED. */
  fail(e: unknown): void;
}

/**
 * Établit le plan d'un diagnostic DANS la session : périmètre, décomptes
 * attendus (même instantané), fichiers et parties. Aucun contenu n'est lu ici.
 */
export async function planDiagnostic(req: DiagRequest, s: ReadSession, opts: GenerateOptions): Promise<DiagPlan> {
  const now = (opts.now ?? (() => new Date()))();
  const generationId = randomUUID();
  const { start, end } = periodBounds(req);
  const partRows = Math.max(1, opts.partRows ?? DIAG_LIMITS.partRows);
  const batchRows = Math.max(1, opts.batchRows ?? DIAG_LIMITS.batchRows);
  const { isSensitiveCanonicalKey, planEntityDossier, EntityNotFoundError } = await import('@/services/admin/account-data/dossier');
  const { writeDossierExport } = await import('@/services/admin/account-data/export');
  const maskOpts = { isSensitiveKey: isSensitiveCanonicalKey };
  const M = (v: unknown) => maskForExport(v, maskOpts);
  const row = (v: unknown) => safeJson(M(v));

  const per = await s.savepoint(() => resolvePerimeter(s.q, req));
  const accounts = per.accountIds.length ? per.accountIds : null;
  const entityScope = req.scope === 'asset' || req.scope === 'document' || req.scope === 'operation';
  const T = req.treatments.length ? req.treatments : null;
  const V: Record<string, unknown> = {
    accounts, accountIds: per.accountIds, start, end, treatments: T, userId: per.userId,
    assetsT: per.assetIds.map(String), equipT: per.equipmentIds.map(String), filesT: per.fileIds.map(String),
    assetIds: per.assetIds, fileIds: per.fileIds, equipmentIds: per.equipmentIds, operationIds: per.operationIds,
  };
  const ACC = (col = 'account_id') => `({{accounts}}::int[] IS NULL OR ${col} = ANY({{accounts}}::int[]))`;
  const PERIOD = (col: string) => `${col} >= {{start}}::timestamptz AND ${col} < {{end}}::timestamptz`;

  const infos: DiagFileInfo[] = [];
  const warnings: string[] = [];
  const unavailable: DiagUnavailable[] = [...per.missing];
  const traceLines: string[] = [];
  const counts: Record<string, number> = {};
  let fatal: string | null = null;

  /** Fichier : écrit dans `sink`, statut et intégrité consignés ; erreur non fatale → FAILED / PARTIAL, fichier refermé valide. */
  const entries: PlannedEntry[] = [];
  const entry = (path: string, description: string, body: (w: (c: string) => Promise<void>) => Promise<EntryResult>, part?: DiagFileInfo['part']) => {
    entries.push({
      path,
      produce: async (sink) => {
        const hash = createHash('sha256');
        let bytes = 0;
        const w = async (c: string) => { hash.update(c); bytes += Buffer.byteLength(c); await sink.write(c); };
        let r: EntryResult;
        try {
          r = await body(w);
        } catch (e) {
          if ((e as Error)?.name === 'SinkError' || errCode(e) === '25006') throw e;
          console.error(`[admin/diagnostics] ${path} :`, (e as Error)?.message ?? e);
          // Échec avant toute écriture : fichier JSON valide (null), statut FAILED, erreur exploitable.
          if (!bytes && path.endsWith('.json')) await w('null\n');
          r = { expected: null, batches: 0, error: describe(e) };
        }
        const status = r.status ?? sectionStatus(r.expected, r.count ?? 0, r.error);
        infos.push({
          path, description, ...(r.count !== undefined ? { count: r.count } : {}), complete: status === 'COMPLETE',
          expected: r.expected, batches: r.batches, status, error: r.error, bytes, sha256: hash.digest('hex'), ...(part ? { part } : {}),
        });
        if (status !== 'COMPLETE') warnings.push(`${path} : ${status}${r.error ? ` — ${r.error}` : ` — ${r.count ?? 0} élément(s) exporté(s) sur ${r.expected ?? '?'} attendu(s)`}.`);
      },
    });
  };

  /** Liste JSON lue par curseur (lots), masquée ligne par ligne ; toujours refermée (JSON valide), même en erreur. */
  const streamList = async (w: (c: string) => Promise<void>, sql: string, params: unknown[], expected: number | null, transform?: (r: Row) => Row, pad = ''): Promise<EntryResult> => {
    let n = 0;
    let batches = 0;
    let error: string | null = null;
    await w('[');
    try {
      await s.savepoint(async () => {
        for await (const lot of jsonBatches(s, sql, params, batchRows)) {
          let chunk = '';
          for (const r of lot) chunk += `${n++ ? ',' : ''}\n${pad}  ${row(transform ? transform(r) : r)}`;
          batches++;
          await w(chunk);
        }
      });
    } catch (e) {
      if ((e as Error)?.name === 'SinkError' || errCode(e) === '25006') throw e;
      console.error('[admin/diagnostics] liste :', (e as Error)?.message ?? e);
      error = describe(e);
    }
    await w(`${n ? `\n${pad}` : ''}]`);
    return { expected, count: n, batches, error };
  };

  /** Décompte attendu (même instantané) ; une erreur est rendue (fichier FAILED). */
  const countOf = async (sql: string, params: unknown[]): Promise<{ n: number | null; error: string | null }> => {
    try { return { n: await s.savepoint(() => countRows(s.q, sql, params)), error: null }; } catch (e) {
      if (errCode(e) === '25006') throw e;
      return { n: null, error: describe(e) };
    }
  };

  /** Fichier de liste (découpé en parties de `partRows` lignes si nécessaire, toutes dans l'archive). */
  const list = async (path: string, description: string, text: string, transform?: (r: Row) => Row, opt: { onlyIfRows?: boolean } = {}) => {
    const { sql, params } = named(text, V);
    const exp = await countOf(sql, params);
    if (opt.onlyIfRows && exp.n === 0) return 0;
    counts[path] = exp.n ?? 0;
    const parts = exp.n !== null && exp.n > partRows ? Math.ceil(exp.n / partRows) : 1;
    for (let k = 0; k < parts; k++) {
      const p = parts > 1 ? path.replace(/\.json$/, `.part-${String(k + 1).padStart(4, '0')}.json`) : path;
      const expected = exp.n === null ? null : parts > 1 ? Math.min(partRows, exp.n - k * partRows) : exp.n;
      const pSql = parts > 1 ? `SELECT * FROM (${sql}) x LIMIT ${partRows} OFFSET ${k * partRows}` : sql;
      entry(p, parts > 1 ? `${description} — partie ${k + 1}/${parts}` : description, async (w) => {
        if (exp.error) { await w('[]\n'); return { expected: null, count: 0, batches: 0, error: exp.error }; }
        const r = await streamList(w, pSql, params, expected, transform);
        await w('\n');
        return r;
      }, parts > 1 ? { index: k + 1, of: parts, group: path } : undefined);
    }
    return exp.n ?? 0;
  };

  /** Objet JSON dont certaines clés sont des listes lues en flux. */
  type Part = { value: () => Promise<unknown> } | { list: string; transform?: (r: Row) => Row };
  const object = async (path: string, description: string, parts: Record<string, Part>, countKey?: string) => {
    const compiled: Record<string, { sql: string; params: unknown[]; n: number | null; error: string | null; transform?: (r: Row) => Row } | null> = {};
    for (const [k, p] of Object.entries(parts)) {
      if ('list' in p) {
        const c = named(p.list, V);
        const e = await countOf(c.sql, c.params);
        compiled[k] = { ...c, ...e, transform: p.transform };
      } else compiled[k] = null;
    }
    entry(path, description, async (w) => {
      await w('{');
      let first = true;
      let expected = 0;
      let count = 0;
      let batches = 0;
      const errors: string[] = [];
      for (const [k, p] of Object.entries(parts)) {
        await w(`${first ? '' : ','}\n  ${JSON.stringify(k)}: `);
        first = false;
        const c = compiled[k];
        if (c) {
          if (c.error) { errors.push(`${k} : ${c.error}`); await w('[]'); continue; }
          const r = await streamList(w, c.sql, c.params, c.n, c.transform, '  ');
          expected += c.n ?? 0;
          count += r.count ?? 0;
          batches += r.batches;
          if (r.error) errors.push(`${k} : ${r.error}`);
          if (countKey && k === countKey) counts[path] = r.count ?? 0;
        } else {
          try {
            const v = await s.savepoint(() => (p as { value: () => Promise<unknown> }).value());
            await w(JSON.stringify(M(v), null, 2).replace(/\n/g, '\n  '));
          } catch (e) {
            if (errCode(e) === '25006') throw e;
            errors.push(`${k} : ${describe(e)}`);
            await w('null');
          }
        }
      }
      await w('\n}\n');
      return { expected, count, batches, error: errors.length ? errors.join(' ; ') : null };
    });
  };

  // ── Requêtes (paramètres nommés, aucune borne) ──────────────────────────
  const jobTarget = entityScope ? `AND ((lower(target_type) = 'asset' AND target_id = ANY({{assetsT}}::text[]))
       OR (lower(target_type) = 'equipment' AND target_id = ANY({{equipT}}::text[]))
       OR (lower(target_type) IN ('asset_file', 'document') AND target_id = ANY({{filesT}}::text[]))
       OR lower(target_type) LIKE 'business_operations%')` : '';
  const JOBS = `SELECT id, treatment, account_id, target_type, target_id, status, origin, trigger_code, config_version_id, attempts, left(last_error, 500) AS last_error,
           business_result, execution_id, recovered_count, coalesce_requested, created_at, available_at, started_at, finished_at,
           payload -> 'events' -> -1 ->> 'correlationId' AS correlation_id
      FROM ai_job_queue
     WHERE ${ACC()} AND ${PERIOD('created_at')} AND ({{treatments}}::text[] IS NULL OR treatment = ANY({{treatments}}::text[])) ${jobTarget}
     ORDER BY id DESC`;
  const REPORTS = `SELECT ${REPORT_COLS} FROM ai_execution_reports
     WHERE ${ACC()} AND ${PERIOD('created_at')} AND ({{treatments}}::text[] IS NULL OR treatment = ANY({{treatments}}::text[]))
       ${entityScope ? `AND (asset_id = ANY({{assetIds}}::int[]) OR file_id = ANY({{fileIds}}::int[]) OR (upper(target_type) = 'EQUIPMENT' AND target_id = ANY({{equipmentIds}}::int[])))` : ''}
     ORDER BY id DESC`;
  const EXTRACTIONS = `SELECT id, file_id, analysis_run_id, engine, provider, model, prompt_version, operation_trace_id, amount_cents, currency, document_date, supplier_name,
           document_type_code, fact_count, full_text_chars, extracted_at
      FROM document_extractions WHERE account_id = ANY({{accountIds}}::int[]) AND file_id = ANY({{fileIds}}::int[]) ORDER BY file_id, id`;
  const TRACES = `(SELECT e.operation_trace_id FROM (${EXTRACTIONS}) e WHERE e.operation_trace_id IS NOT NULL
                   UNION SELECT unnest(r.trace_ids) FROM (${REPORTS}) r)`;
  const CALLS = `SELECT ${USAGE_COLS} FROM ai_usage_event
     WHERE ${ACC()} AND ${PERIOD('created_at')}
       ${entityScope ? `AND (asset_file_id = ANY({{fileIds}}::int[]) OR metadata->>'traceId' IN ${TRACES} OR job_id IN (SELECT j.id FROM (${JOBS}) j))` : ''}
     ORDER BY id DESC`;
  const AI_OPS = `SELECT id, public_id, account_id, user_id, asset_file_id, operation_category, pipeline_version, started_at, completed_at, duration_ms, business_result,
           provider_primary, provider_fallback, used_fallback, is_reanalysis, reanalysis_reason, origin, environment, error_code, left(warning_message, 300) AS warning_message
      FROM ai_operation WHERE ${ACC()} AND ${PERIOD('created_at')} ${entityScope ? 'AND asset_file_id = ANY({{fileIds}}::int[])' : ''}
     ORDER BY id DESC`;
  const ANOMALIES = `SELECT id, domain, fingerprint, title, status, account_id, user_id, technical_detail, occurrence_count, first_seen_at, last_seen_at,
           resolved_at, resolution_source, auto_resolution_origin, auto_resolution_cause, previous_anomaly_id
      FROM admin_anomalies
     WHERE (${ACC()} ${per.userId ? 'OR user_id = {{userId}}::int' : ''}) AND last_seen_at >= {{start}}::timestamptz AND first_seen_at < {{end}}::timestamptz
     ORDER BY last_seen_at DESC, id DESC`;
  const HISTORY = `SELECT id, operation_id, event_type, reason_code, source_id, actor_user_id, before_json, after_json, correlation_id, created_at
      FROM business_operation_history WHERE account_id = ANY({{accountIds}}::int[]) AND operation_id = ANY({{operationIds}}::bigint[]) AND ${PERIOD('created_at')}
     ORDER BY created_at DESC, id DESC`;

  // ── Fichiers (ordre de l'archive) ───────────────────────────────────────
  await object('contexte-technique.json', 'Base de données, tâches planifiées, file en attente, versions de configuration IA actives ou utilisées', {
    baseDeDonnees: { value: async () => { const [db] = await s.q(`SELECT current_setting('server_version') AS version, now() AS maintenant`); return { version: db?.version ?? null, horloge: db?.maintenant ?? null }; } },
    tachesPlanifiees: { list: `SELECT code, next_run_at, last_trigger, last_started_at, last_finished_at, last_duration_ms, last_status,
                                      left(last_error, 300) AS last_error, last_success_at, consecutive_failures FROM scheduled_task_state ORDER BY code` },
    fileEnAttente: { list: `SELECT treatment, status, count(*)::int AS n, min(created_at) AS plus_ancien FROM ai_job_queue
                             WHERE ${ACC()} AND status IN ('PENDING', 'RUNNING', 'FAILED') GROUP BY 1, 2 ORDER BY 1, 2` },
    versionsConfigurationIA: { list: `SELECT id, uid, environment, status, visible_number, label, base_version_id, created_at FROM ai_config_versions
                                       WHERE status = 'ACTIVE' OR id IN (SELECT DISTINCT config_version_id FROM ai_job_queue WHERE ${ACC()} AND ${PERIOD('created_at')})
                                       ORDER BY id DESC` },
  });
  if (req.scope === 'user' && per.userId) {
    await object('metier/utilisateur.json', 'Utilisateur (pseudonymisé), adhésions, comptes et biens', {
      utilisateur: { value: async () => (await s.q(`SELECT row_to_json(t) AS r FROM (SELECT id, email, role, status, is_active, plan_type, locale, created_at, last_login_at FROM users WHERE id = $1) t`, [per.userId]).then((r) => r.map((x) => decodeJsonRow(x.r))))[0] ?? null },
      adhesions: { list: `SELECT id, account_id, role, status, joined_at, removed_at FROM account_memberships WHERE user_id = {{userId}}::int ORDER BY id` },
      comptes: { list: `SELECT a.id, a.owner_user_id, a.created_at,
               (SELECT count(*)::int FROM assets x WHERE x.account_id = a.id) AS biens,
               (SELECT count(*)::int FROM equipments e JOIN assets x ON x.id = e.asset_id WHERE x.account_id = a.id) AS equipements,
               (SELECT count(*)::int FROM asset_files f WHERE f.account_id = a.id) AS documents,
               (SELECT count(*)::int FROM business_operations o WHERE o.account_id = a.id) AS operations,
               (SELECT count(*)::int FROM agenda_items i WHERE i.account_id = a.id) AS echeances
          FROM accounts a WHERE a.id = ANY({{accountIds}}::int[]) ORDER BY a.id` },
      biens: { list: `SELECT id, account_id, name, category, status, created_at, deleted_at FROM assets WHERE account_id = ANY({{accountIds}}::int[]) ORDER BY id` },
    });
  } else if (req.scope === 'global') {
    await object('metier/volumetrie.json', 'Volumétrie globale et traitements de la période', {
      volumetrie: { value: async () => (await s.q(`SELECT (SELECT count(*)::int FROM accounts) AS comptes, (SELECT count(*)::int FROM users) AS utilisateurs,
                                     (SELECT count(*)::int FROM assets WHERE deleted_at IS NULL) AS biens, (SELECT count(*)::int FROM asset_files WHERE deleted_at IS NULL) AS documents,
                                     (SELECT count(*)::int FROM business_operations WHERE invalidated_at IS NULL AND merged_into_operation_id IS NULL) AS operations_actives`))[0] ?? null },
      traitementsSurLaPeriode: { list: `SELECT treatment, status, count(*)::int AS n FROM ai_job_queue WHERE ${PERIOD('created_at')} AND ({{treatments}}::text[] IS NULL OR treatment = ANY({{treatments}}::text[])) GROUP BY 1, 2 ORDER BY 1, 2` },
      rapportsSurLaPeriode: { list: `SELECT treatment, status, count(*)::int AS n FROM ai_execution_reports WHERE ${PERIOD('created_at')} AND ({{treatments}}::text[] IS NULL OR treatment = ANY({{treatments}}::text[])) GROUP BY 1, 2 ORDER BY 1, 2` },
      anomaliesOuvertesParDomaine: { list: `SELECT domain, count(*)::int AS n FROM admin_anomalies WHERE status = 'open' GROUP BY 1 ORDER BY 1` },
    });
  }
  const nAnomalies = await list('logs/anomalies-supervision.json', 'Anomalies de supervision (Dashboard › Supervision) de la période', ANOMALIES);
  const nJobs = await list('logs/traitements-file.json', 'File des traitements T1 / T3 / T4 (ai_job_queue) : statut, tentatives, erreur, corrélation', JOBS);
  await object('ia/t6-evaluations.json', 'Évaluations T6 EVALUATE : état réel par échéance (PENDING, RUNNING, RETRY_WAIT, FAILED, COMPLETED, UNAVAILABLE), tentatives, erreurs, prochain essai ; pré-génération de l’accueil', {
    evaluations: { list: `SELECT agenda_item_id, account_id, status, left(context_fingerprint, 16) AS empreinte, left(evaluation_signature, 16) AS signature,
             attempts, run_id, mode, requested_at, started_at, finished_at, lease_until, next_attempt_at, last_error_kind,
             left(last_error, 300) AS last_error, last_outcome, trace_id, interrupted_count, updated_at
        FROM t6_evaluation_runs WHERE ${ACC()} AND (status <> 'COMPLETED' OR updated_at >= {{start}}::timestamptz)
       ORDER BY account_id, agenda_item_id` },
    preGeneration: { list: `SELECT account_id, reason, requested_at, processed_at, last_status, attempts, claimed_until,
             (processed_at IS NULL OR requested_at > processed_at) AS en_attente
        FROM home_mascot_pregen_requests WHERE ${ACC()} ORDER BY requested_at DESC, account_id` },
  }, 'evaluations');
  if (per.operationIds.length) await list('logs/historique-operations.json', 'Historique des Opérations (business_operation_history) de la période', HISTORY);
  if (per.operationIds.length || per.fileIds.length) {
    const [j] = await s.savepoint(() => s.q(`SELECT to_regclass('business_operation_identity_reviews') IS NOT NULL AS ok`));
    const JOURNAL = `SELECT id, operation_id, target_operation_id, kind, status, file_id, candidate_key, source_id, basis, signals, against_source_ids,
             review_version, correlation_id, resolved_by_admin_id, created_at, updated_at, resolved_at
        FROM business_operation_identity_reviews
       WHERE account_id = ANY({{accountIds}}::int[]) AND (operation_id = ANY({{operationIds}}::bigint[]) OR target_operation_id = ANY({{operationIds}}::bigint[]) OR file_id = ANY({{fileIds}}::int[]))
       ORDER BY id DESC`;
    const parts: Record<string, Part> = {};
    if (j?.ok) parts.journal = { list: JOURNAL };
    else parts.journal = { value: async () => [] };
    parts.provenance = { list: `SELECT o.id AS operation_id, o.type_code, o.provider, o.technical_label, o.planned_date, o.start_date, o.realized_date, o.end_date,
             to_jsonb(o) -> 'attribute_provenance' AS provenance
        FROM business_operations o WHERE o.account_id = ANY({{accountIds}}::int[]) AND o.id = ANY({{operationIds}}::bigint[]) ORDER BY o.id` };
    parts.sources = { list: `SELECT s.id, s.operation_id, s.source_kind, s.source_entity_key, s.locator->>'candidateKey' AS candidate_key, s.source_role, s.authority, s.confidence,
             s.match_method, s.match_reason, s.active, s.superseded_at, s.created_at,
             CASE WHEN s.match_method = 'M3' THEN 'IA' WHEN s.match_method = 'M0' THEN 'UTILISATEUR' WHEN s.match_method IN ('M1', 'M2') THEN 'DETERMINISTE'
                  WHEN s.match_method IS NULL AND s.source_kind = 'DOCUMENT' THEN 'CREATION' ELSE 'AUTRE' END AS nature_decision,
             (SELECT h.reason_code FROM business_operation_history h WHERE h.source_id = s.id AND h.event_type = 'SOURCE_REMOVED' ORDER BY h.id DESC LIMIT 1) AS motif_retrait
        FROM business_operation_sources s WHERE s.account_id = ANY({{accountIds}}::int[]) AND s.operation_id = ANY({{operationIds}}::bigint[]) ORDER BY s.operation_id, s.id` };
    parts.candidats = { list: `SELECT c.id, c.file_id, c.candidate_key, c.extraction_id, c.analysis_run_id, c.status, c.established, c.confidence, c.type_hint, c.status_hint,
             c.payload->'origin' AS origine_t1, c.payload->'evidenceFactIds' AS faits_preuve, c.payload->'adjustments' AS corrections_barriere,
             c.t3_outcome, c.t3_reason, c.t3_operation_id, c.t3_detail->'matchMethod' AS methode, c.t3_detail->'certain' AS certains,
             c.t3_detail->'identity' AS controles_identite, c.t3_detail->'excluded' AS exclus, c.t3_detail->'plausible' AS plausibles,
             c.t3_detail->'m3' AS verdict_ia, c.t3_detail->>'identityReview' AS version_controle, c.t3_processed_at, c.created_at, c.superseded_at
        FROM document_operation_candidates c
       WHERE c.account_id = ANY({{accountIds}}::int[]) AND (c.file_id = ANY({{fileIds}}::int[]) OR c.t3_operation_id = ANY({{operationIds}}::bigint[]))
       ORDER BY c.file_id, c.id DESC` };
    // Lot 79A : rétablissements BO des séparations (journal d'audit admin) — administrateur (identifiant), motif, avant / après.
    parts.retablissements = j?.ok ? {
      list: `SELECT id, "timestamp" AS horodatage, admin_user_id, target_id AS separation_id, result AS resultat, details, old_value AS avant, new_value AS apres
        FROM admin_audit_log
       WHERE action_type = '${RESTORE_AUDIT_ACTION}' AND target_type = '${RESTORE_AUDIT_TARGET}' AND target_id IN (SELECT jr.id FROM (${JOURNAL}) jr)
       ORDER BY id DESC`,
      transform: ({ details, ...x }) => {
        let d: Record<string, unknown> = {};
        try { d = typeof details === 'string' ? JSON.parse(details) as Record<string, unknown> : (details && typeof details === 'object' ? details as Record<string, unknown> : {}); } catch { d = {}; }
        return { ...x, motif: d.reason ?? null, code: d.code ?? null, operation_affichee: d.viewedOperationId ?? d.operationId ?? null };
      },
    } : { value: async () => [] };
    await object('tracabilite/identite-economique.json',
      'Identité économique (lot 78A) : candidats T1 (origine, faits, décision T3, contrôles d’identité, nature déterministe / IA), sources rattachées et motifs de retrait, provenance des valeurs (dates, prestataire, libellé) et contradictions, journal des séparations / doutes / doublons et de leur traitement, rétablissements BO (lot 79A : administrateur, motif, avant / après)',
      parts);
  }
  const nReports = await list('ia/rapports-execution.json', 'Rapports d’exécution T1 / T3 (ai_execution_reports) — synthèse', REPORTS);
  if (entityScope) {
    await list('ia/rapports-execution-lignes.json', 'Lignes des rapports d’exécution du périmètre (toutes)', `
      SELECT r.id AS report_id, e.seq, e.section, e.table_name, e.record_id, e.column_path, e.field_key, e.label, e.entity_type, e.entity_id,
             e.old_value, e.value, e.value_type, e.value_chars, e.record_status, e.write_result, e.reason_code, e.reason, e.links
        FROM (${REPORTS}) r JOIN ai_execution_report_entries e ON e.report_id = coalesce(r.entries_report_id, r.id) AND e.account_id = ANY({{accountIds}}::int[])
       ORDER BY r.id DESC, e.seq`);
  }
  if (per.fileIds.length) await list('ia/extractions.json', 'Extractions T1 : fournisseur, modèle, version de prompt, trace, montant documentaire', EXTRACTIONS, undefined, { onlyIfRows: true });
  const nCalls = await list('ia/appels.json', 'Appels IA (ai_usage_event) : modèle, rang, prompt maître et version, trace, job, statut', CALLS);
  if (!entityScope) {
    await list('ia/appels-agreges.json', 'Appels IA agrégés par fournisseur, modèle, opération et statut', `
      SELECT provider, model, operation_code, status, count(*)::int AS appels, sum(coalesce(cost_micros, 0))::bigint AS cout_micros, max(created_at) AS dernier
        FROM ai_usage_event WHERE ${ACC()} AND ${PERIOD('created_at')}
       GROUP BY 1, 2, 3, 4 ORDER BY appels DESC, 1, 2, 3, 4`);
  }
  await list('ia/operations-ia.json', 'Opérations IA (ai_operation) : pipeline, résultat métier, repli', AI_OPS);
  await list('ia/diagnostics-appels.json', 'Diagnostics d’appels IA (ai_call_diagnostics) : contrat, schéma, échec — sans la sortie du modèle', `
    SELECT id, created_at, trace_id, usage_event_id, call_index, call_kind, account_id, use_case_code, operation_code, task, model, model_rank, outcome,
           failure_family, failure_subtype, failure_stage, signature, source_ids, schema_name, schema_version, schema_hash, contract_id, contract_version,
           output_chars, (raw_output IS NOT NULL OR extracted_output IS NOT NULL OR parsed_output IS NOT NULL) AS sortie_conservee
      FROM ai_call_diagnostics
     WHERE ${ACC()} AND ${PERIOD('created_at')} ${entityScope ? `AND (trace_id IN ${TRACES} OR source_ids && {{fileIds}}::int[])` : ''}
     ORDER BY id DESC`);
  // Chronologie corrélée : mêmes lignes que les fichiers ci-dessus, ordonnées par horodatage (SQL, en flux).
  const tl: string[] = [
    `SELECT a.last_seen_at AS h, 1 AS k, a.id AS i, json_build_object('horodatage', a.last_seen_at, 'type', 'ANOMALIE', 'table', 'admin_anomalies', 'id', a.id, 'statut', a.status, 'compte', a.account_id, 'libelle', a.title) AS ev FROM (${ANOMALIES}) a`,
    `SELECT j.created_at, 2, j.id, json_build_object('horodatage', j.created_at, 'type', 'JOB_' || j.treatment || '_CREE', 'table', 'ai_job_queue', 'id', j.id, 'statut', j.status, 'compte', j.account_id,
            'correlation', json_build_object('job', j.id, 'execution', j.execution_id, 'correlationId', j.correlation_id, 'cible', j.target_type || ':' || j.target_id)) FROM (${JOBS}) j`,
    `SELECT j.finished_at, 3, j.id, json_build_object('horodatage', j.finished_at, 'type', 'JOB_' || j.treatment || '_TERMINE', 'table', 'ai_job_queue', 'id', j.id, 'statut', j.status, 'resultat', j.business_result,
            'erreur', j.last_error, 'correlation', json_build_object('job', j.id)) FROM (${JOBS}) j WHERE j.finished_at IS NOT NULL`,
    `SELECT r.created_at, 4, r.id, json_build_object('horodatage', r.created_at, 'type', 'RAPPORT_' || r.treatment, 'table', 'ai_execution_reports', 'id', r.id, 'statut', r.status,
            'correlation', json_build_object('job', r.job_id, 'traces', r.trace_ids, 'document', r.file_id, 'bien', r.asset_id, 'rapportT1Origine', r.origin_t1_report_id)) FROM (${REPORTS}) r`,
    `SELECT u.created_at, 5, u.id, json_build_object('horodatage', u.created_at, 'type', 'APPEL_IA', 'table', 'ai_usage_event', 'id', u.id, 'statut', u.status, 'modele', u.model,
            'correlation', json_build_object('job', u.job_id, 'trace', u.trace_id, 'document', u.asset_file_id)) FROM (${CALLS}) u`,
    `SELECT o.started_at, 6, o.id, json_build_object('horodatage', o.started_at, 'type', 'OPERATION_IA', 'table', 'ai_operation', 'id', o.id, 'statut', o.business_result,
            'correlation', json_build_object('document', o.asset_file_id)) FROM (${AI_OPS}) o`,
  ];
  if (per.operationIds.length) {
    tl.push(`SELECT h.created_at, 7, h.id, json_build_object('horodatage', h.created_at, 'type', 'OPERATION_' || h.event_type, 'table', 'business_operation_history', 'id', h.id, 'motif', h.reason_code,
            'correlation', json_build_object('operation', h.operation_id, 'source', h.source_id, 'correlationId', h.correlation_id)) FROM (${HISTORY}) h`);
  }
  await list('logs/chronologie.json', 'Chronologie corrélée (horodatage, table, identifiant, corrélations job / trace / document / Opération)',
    `SELECT x.ev FROM (${tl.join('\n UNION ALL ')}) x(h, k, i, ev) WHERE x.h IS NOT NULL ORDER BY x.h, x.k, x.i`, (r) => (r.ev ?? r) as Row);

  // Dossiers d'entité (« Données du compte » : même moteur, sections intégrales, même instantané).
  const dossier = (path: string, type: 'asset' | 'equipment' | 'document' | 'operation', id: number) => {
    entry(path, `Dossier ${type} #${id} (BO › Données du compte : synthèse, données BDD, relations, preuves — sections intégrales)`, async (w) => {
      let plan;
      try {
        plan = await planEntityDossier(s, per.accountIds[0], type, id, { mode: 'export' });
      } catch (e) {
        if (e instanceof EntityNotFoundError) {
          unavailable.push({ element: `${type} #${id}`, motif: 'introuvable dans le compte' });
          await w('null\n');
          return { expected: null, count: 0, batches: 0, error: null, status: 'COMPLETE' };
        }
        if (errCode(e) === '25006') throw e;
        await w('null\n');
        return { expected: null, count: 0, batches: 0, error: describe(e), status: 'FAILED' };
      }
      const m = await writeDossierExport(s, plan, 'json', { write: w }, { mask: M, stringifyRow: row, batchRows });
      for (const x of m.sections) if (x.status !== 'COMPLETE') warnings.push(`${path} › ${x.title} : ${x.status}${x.error ? ` — ${x.error}` : ''}.`);
      return { expected: m.totals.expected, count: m.totals.exported, batches: m.totals.batches, error: m.status === 'COMPLETE' ? null : m.error, status: m.status };
    });
  };
  if (req.scope === 'asset' && req.id) {
    dossier(`metier/bien-${req.id}.json`, 'asset', req.id);
    for (const e of per.equipmentIds) dossier(`metier/equipements/equipement-${e}.json`, 'equipment', e);
  } else if (req.scope === 'document' && req.id) {
    dossier(`metier/document-${req.id}.json`, 'document', req.id);
  } else if (req.scope === 'operation' && req.id) {
    dossier(`metier/operation-${req.id}.json`, 'operation', req.id);
    for (const f of per.fileIds) dossier(`metier/documents/document-${f}.json`, 'document', f);
  }

  // TCO et traçabilité de CHAQUE montant (moteur TCO existant, recalcul en lecture).
  let nTraces = 0;
  let nRuptures = 0;
  let nSansLien = 0;
  const summaries: Row[] = [];
  if (entityScope && per.accountIds.length) {
    const A = per.accountIds[0];
    if (!per.assetIds.length) unavailable.push({ element: 'TCO', motif: 'aucun bien rattaché à l’objet : aucun montant TCO à tracer' });
    const writeTrace = async (w: (c: string) => Promise<void>, t: AmountTrace, first: boolean) => {
      const masked = M(t) as AmountTrace;
      await w(`${first ? '' : ','}\n  ${safeJson(masked)}`);
      traceLines.push(...(maskForExport(traceReportLines(masked).join('\n'), maskOpts) as string).split('\n'));
      nTraces++;
      if (t.rupture) nRuptures++;
      if (String(t.ligne.id ?? '').startsWith('c:')) {
        const ext = t.chaine.find((x) => x.etape === 'EXTRACTION_IA');
        if (ext && ext.statut !== 'sans_objet' && !(ext.donnees as { lienPersiste?: unknown } | undefined)?.lienPersiste) nSansLien++;
      }
    };
    entry('tracabilite/montants.json', 'Traçabilité de chaque montant : Document → Extraction IA → Décision → Enregistrement → Rapprochement → Calcul → Affichage ; valeurs source / proposée IA / enregistrée / calculée / affichée', async (w) => {
      await w('[');
      let n = 0;
      let expected = 0;
      const failed: string[] = [];
      const safe = async (what: string, fn: () => Promise<AmountTrace[]>) => {
        try {
          for (const t of await s.savepoint(fn)) await writeTrace(w, t, n++ === 0);
        } catch (e) {
          if ((e as Error)?.name === 'SinkError' || errCode(e) === '25006') throw e;
          failed.push(`${what} : ${describe(e)}`);
          console.error('[admin/diagnostics] trace :', (e as Error)?.message);
        }
      };
      const loadCtx = async (a: number): Promise<TcoContext> => {
        const c = await loadTcoContext(A, a, opts.today);
        summaries.push(tcoSummary(c));
        if (c.unavailable) unavailable.push({ element: `TCO du bien #${c.assetId}`, motif: c.unavailable });
        return c;
      };
      if (req.scope === 'operation' && req.id) {
        const ctxs: TcoContext[] = [];
        for (const a of per.assetIds) ctxs.push(await loadCtx(a));
        let comps: number[] = [];
        try {
          comps = ids(await s.savepoint(() => s.q(`SELECT id FROM business_operation_financial_components WHERE account_id = $1 AND operation_id = $2 ORDER BY active DESC, id`, [A, req.id])));
        } catch (e) {
          if (errCode(e) === '25006') throw e;
          failed.push(`composantes : ${describe(e)}`);
        }
        if (!comps.length) unavailable.push({ element: `Composantes financières de l’Opération #${req.id}`, motif: 'aucune composante enregistrée : aucun montant de cette Opération ne peut entrer dans le TCO' });
        expected = comps.length * Math.max(1, ctxs.length);
        for (const c of comps) await safe(`composante #${c}`, () => traceComponent(s.q, A, c, ctxs));
      } else {
        // Un bien à la fois : contexte TCO libéré après ses lignes (mémoire bornée).
        const opIds = new Set(per.operationIds);
        for (const a of per.assetIds) {
          const ctx = await loadCtx(a);
          let lines = ctx.result?.lines ?? [];
          if (req.scope === 'document' && req.id) lines = lines.filter((l) => l.fileId === req.id || l.relatedFileId === req.id || (l.operationId != null && opIds.has(l.operationId)));
          expected += lines.length;
          for (const l of lines) await safe(`ligne ${l.id}`, async () => [await traceTcoLine(s.q, A, ctx, l)]);
        }
      }
      await w(`${n ? '\n' : ''}]\n`);
      return { expected, count: n, batches: 1, error: failed.length ? failed.join(' ; ') : null };
    });
    entry('tracabilite/tco.json', 'TCO recalculé (moteur existant) des biens concernés : synthèse, postes, fiabilité', async (w) => {
      await w(`${JSON.stringify(summaries.map((x) => M(x)), null, 2)}\n`);
      return { expected: per.assetIds.length, count: summaries.length, batches: 1, error: null };
    });
  }

  // Diagnostic renforcé : sorties modèle conservées (accès existant, journalisé).
  if (req.reinforced) {
    const traceSql = entityScope ? `SELECT t AS trace FROM ${TRACES} x(t) WHERE t IS NOT NULL ORDER BY 1`
      : `SELECT DISTINCT unnest(r.trace_ids) AS trace FROM (${REPORTS}) r ORDER BY 1`;
    const tq = named(traceSql, V);
    entry('ia/sorties-modele.json', 'DIAGNOSTIC RENFORCÉ — sorties modèle conservées des traces du périmètre (accès AI_MODEL_OUTPUT_READ journalisé)', async (w) => {
      const all = (await s.savepoint(() => s.q(tq.sql, tq.params))).map((r) => String(r.trace)).filter(Boolean);
      const traceIds = all.slice(0, DIAG_LIMITS.modelOutputTraces);
      const cq = named(`SELECT DISTINCT ON (metadata->>'traceId') metadata->>'traceId' AS trace, id FROM ai_usage_event
                         WHERE ${ACC()} AND metadata->>'traceId' = ANY({{traces}}::text[]) ORDER BY metadata->>'traceId', id DESC`, { ...V, traces: traceIds });
      const callsByTrace = new Map((await s.savepoint(() => s.q(cq.sql, cq.params))).map((r) => [String(r.trace), N(r.id)]));
      const { readModelOutputsForAdmin } = await import('@/services/ai/telemetry/model-output-access');
      const sorties: Row[] = [];
      let refus = false;
      let tronque = false;
      for (const t of traceIds) {
        const callId = callsByTrace.get(t);
        if (!callId) { unavailable.push({ element: `Sorties modèle de la trace ${t}`, motif: 'aucun appel IA corrélé conservé' }); continue; }
        const r = await readModelOutputsForAdmin({ adminUserId: opts.adminUserId, callId, purpose: 'export' });
        if (!r.ok) { if (r.code === 'FORBIDDEN') { refus = true; break; } unavailable.push({ element: `Sorties modèle de la trace ${t}`, motif: r.message }); continue; }
        const cut = (x: string | null) => {
          if (x === null || x.length <= DIAG_LIMITS.modelOutputChars) return x;
          tronque = true;
          return `${x.slice(0, DIAG_LIMITS.modelOutputChars)}… [tronqué : ${x.length} caractères — restriction d’accès aux sorties IA]`;
        };
        for (const o of r.outputs) sorties.push({ trace: t, appel: callId, diagnostic: o.diagnosticId, modele: o.model, rang: o.callIndex, sortieBrute: cut(o.raw), sortieExtraite: cut(o.extracted), sortieStructuree: o.parsed });
      }
      if (refus) unavailable.push({ element: 'Diagnostic renforcé', motif: 'refusé : consultation des sorties modèle réservée (AI_MODEL_OUTPUT_ADMIN_IDS) — refus journalisé' });
      else if (!all.length) unavailable.push({ element: 'Diagnostic renforcé', motif: 'aucune trace IA dans le périmètre et la période' });
      else if (!sorties.length) unavailable.push({ element: 'Diagnostic renforcé', motif: 'aucune sortie modèle conservée (rétention ai-call-diagnostics-purge, ou appels sans sortie)' });
      const restreint = all.length > traceIds.length;
      if (restreint) unavailable.push({ element: `Sorties modèle de ${all.length - traceIds.length} trace(s)`, motif: `restriction d’accès aux sorties IA sensibles (inchangée) : ${DIAG_LIMITS.modelOutputTraces} traces jointes sur ${all.length}` });
      await w(`${JSON.stringify(sorties.map((x) => M(x)), null, 2)}\n`);
      // Restriction d'accès (requalifiée, signalée) : le fichier n'est pas présenté comme complet si des sorties ne sont pas jointes.
      return { expected: null, count: sorties.length, batches: 1, error: null, status: restreint || tronque ? 'PARTIAL' : 'COMPLETE' };
    });
  }

  // Manifeste et rapport : en DERNIER (statuts, intégrité de tous les fichiers).
  const env = (process.env.NEXT_PUBLIC_APP_ENV || process.env.NODE_ENV || 'inconnu').trim();
  const build = getBuildIdentity();
  let finalManifest: DiagManifest | null = null;
  let finalReport = '';
  const buildManifest = (): DiagManifest => {
    if (finalManifest) return finalManifest;
    if (!infos.some((f) => f.path === 'ia/rapports-execution.json' && (f.count ?? 0) > 0) && !nReports) {
      unavailable.push({ element: 'Rapports d’exécution T1 / T3', motif: 'aucun rapport conservé sur la période (rétention ai-call-diagnostics-purge ou traitements antérieurs au lot 58C)' });
    }
    if (entityScope && nRuptures) unavailable.push({ element: `Traçabilité de ${nRuptures} montant(s) sur ${nTraces}`, motif: 'au moins une étape non disponible (voir « rupture » de chaque ligne dans tracabilite/montants.json)' });
    if (entityScope && nSansLien) unavailable.push({ element: `Lien composante → indice T1 (${nSansLien} montant(s))`, motif: 'non encore persisté (composante antérieure au lot 78A, pas encore reconsolidée) : indices du candidat exportés, correspondance de valeur signalée comme telle' });
    unavailable.push({ element: 'Documents originaux et texte intégral', motif: 'exclus par principe (sécurité) : seules les données structurées et extraits de preuve sont exportés' });
    const status = fatal ? 'FAILED' : globalStatus(infos.map((f) => ({ status: f.status ?? 'COMPLETE' })));
    finalManifest = {
      schema: DIAG_SCHEMA, generationId, generatedAt: now.toISOString(), environment: env,
      build: { version: build.version, commit: build.commit, commitSource: build.commitSource, container: build.container },
      request: { ...req, scopeLabel: DIAG_SCOPE_LABELS[req.scope] },
      target: { label: per.label, accountIds: per.accountIds },
      limits: DIAG_LIMITS, status,
      snapshot: {
        isolation: s.info.isolation, at: s.info.at, snapshot: s.info.snapshot,
        verification: 'Toutes les lectures dans UNE transaction REPEATABLE READ READ ONLY ; attendu = count(*) dans le même instantané ; exporté = lignes écrites (curseur, lots ordonnés) ; COMPLETE seulement si exporté = attendu pour chaque fichier et aucune erreur ; SHA-256 de chaque fichier (contenu non compressé) ci-dessous.',
        exceptions: ['TCO recalculé par le moteur existant (readAssetTco) à l’instant de la génération, hors instantané de la transaction.',
          ...(fatal ? [`Génération interrompue : ${fatal}`] : [])],
      },
      removedCaps: DIAG_REMOVED_CAPS,
      files: [
        { path: 'rapport.txt', description: 'Rapport synthétique lisible (copiable)', complete: true },
        { path: 'manifeste.json', description: 'Contexte, filtres, instantané, fichiers (attendu, exporté, statut, SHA-256), limites et masquage', complete: true },
        ...infos,
      ],
      warnings, unavailable, masking: [...MASKING_NOTES], readOnly: READ_ONLY_NOTE,
    };
    const summary: Array<[string, string | number]> = [
      ['Objet', per.label],
      ['Statut de la génération', status],
      ['Anomalies de supervision', nAnomalies],
      ['Traitements (file)', nJobs],
      ['Rapports d’exécution', nReports],
      ['Appels IA', nCalls],
      ['Montants tracés', nTraces],
      ['Montants à trace interrompue', nRuptures],
      ['Avertissements', warnings.length],
    ];
    finalReport = maskForExport(buildReportTextFromLines(finalManifest, summary, traceLines), maskOpts) as string;
    if (leaksSecretOrEmail(finalReport)) finalReport = maskText(finalReport);
    return finalManifest;
  };
  entries.push({
    path: 'rapport.txt',
    produce: async (sink) => { buildManifest(); await sink.write(finalReport); },
  });
  entries.push({
    path: 'manifeste.json',
    produce: async (sink) => {
      const rapport = createHash('sha256').update(finalReport).digest('hex');
      const m = buildManifest();
      m.files[0] = { ...m.files[0], bytes: Buffer.byteLength(finalReport), sha256: rapport, status: 'COMPLETE' };
      let json = `${JSON.stringify(maskForExport(m, maskOpts), null, 2)}\n`;
      if (leaksSecretOrEmail(json)) { const x = maskText(json); try { JSON.parse(x); json = x; } catch { /* JSON conservé : masquage par valeur déjà appliqué */ } }
      await sink.write(json);
    },
  });

  return {
    generationId, perimeter: per, entries,
    result: () => ({ manifest: buildManifest(), report: finalReport }),
    fail: (e) => { fatal = describe(e); },
  };
}

// ── Exécutions ──────────────────────────────────────────────────────────────

/** Ouvre la session, établit le plan, exécute `run`, ferme la session (place de génération réservée). */
export async function withDiagnosticPlan<T>(req: DiagRequest, opts: GenerateOptions, run: (plan: DiagPlan, s: ReadSession) => Promise<T>): Promise<T> {
  const { tryAcquireExportSlot } = await import('@/services/admin/export-generations');
  const slot = tryAcquireExportSlot('TECH_DIAGNOSTIC');
  if (!slot) throw new DiagBusyError();
  const own = !opts.session;
  const s = opts.session ?? await openReadSession().catch((e) => { slot.release(); throw e; });
  try {
    const plan = await planDiagnostic(req, s, opts);
    return await run(plan, s);
  } finally {
    if (own) await (s as ReadSession & { close(): Promise<void> }).close();
    slot.release();
  }
}

/** Produit tous les fichiers dans l'ordre vers `open(path)` ; rend le manifeste et le rapport. */
export async function producePlan(plan: DiagPlan, open: (path: string) => TextSink & { close?: () => Promise<void> | void }): Promise<{ manifest: DiagManifest; report: string }> {
  for (const e of plan.entries) {
    const sink = open(e.path);
    await e.produce(sink);
    await sink.close?.();
  }
  return plan.result();
}

/**
 * Génération EN MÉMOIRE (tests, petits volumes) : contenu de chaque fichier.
 * Le BO utilise la production en flux (`zip.ts`, aperçu sans contenu).
 */
export async function generateDiagnostic(req: DiagRequest, opts: GenerateOptions): Promise<DiagBundle> {
  return withDiagnosticPlan(req, opts, async (plan) => {
    const files: Array<{ path: string; content: string }> = [];
    const { manifest, report } = await producePlan(plan, (path) => {
      const parts: string[] = [];
      return { write: async (c: string) => { parts.push(c); }, close: () => { files.push({ path, content: parts.join('') }); } };
    });
    // Ordre historique : rapport et manifeste en tête.
    files.sort((a, b) => (a.path === 'rapport.txt' ? -1 : b.path === 'rapport.txt' ? 1 : a.path === 'manifeste.json' ? -1 : b.path === 'manifeste.json' ? 1 : 0));
    return { manifest, report, files, totalBytes: files.reduce((n, f) => n + Buffer.byteLength(f.content), 0) };
  });
}

/** Aperçu d'un plan : production complète SANS conserver le contenu — manifeste, rapport, tailles. */
export async function previewPlan(plan: DiagPlan): Promise<{ manifest: DiagManifest; report: string; files: Array<{ path: string; bytes: number }> }> {
  const sizes: Array<{ path: string; bytes: number }> = [];
  const { manifest, report } = await producePlan(plan, (path) => {
    let bytes = 0;
    return { write: async (c: string) => { bytes += Buffer.byteLength(c); }, close: () => { sizes.push({ path, bytes }); } };
  });
  return { manifest, report, files: sizes };
}

/** Aperçu (consultation BO) : génération complète SANS conserver le contenu — manifeste, rapport, tailles. */
export async function previewDiagnostic(req: DiagRequest, opts: GenerateOptions): Promise<{ manifest: DiagManifest; report: string; files: Array<{ path: string; bytes: number }> }> {
  return withDiagnosticPlan(req, opts, (plan) => previewPlan(plan));
}
