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
import { USAGE_COLS } from '@/services/admin/diagnostics-export/trace';
import { toExecutionDto, type ExecutionCallsDto } from './dto';
import { matchesJournalFilter, journalFilterFingerprint, journalFilterToParams, type JournalFilter } from './journal';
import { projectBusinessExecutions } from './repository';
import {
  EXPORT_CALL_BATCH, EXPORT_MIN_SLICE_MS, EXPORT_RETENTION_DAYS, EXECUTION_UNIT_SCHEMA, EXECUTIONS_EXPORT_PREFIX,
  addToTotals, buildManifest, executionLine, executionsExportPrefix, exportReadme, initialResumeState, partPath, readEnd, sliceAt,
  type ExecutionsManifest, type ExportFile, type ExportPerimeter, type ExportResumeState,
} from './export-model';
import { BUSINESS_TREATMENTS, type BusinessExecution } from './types';

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
export function exchangeOf(capture: Row | null, sensitive: boolean): Record<string, unknown> {
  if (!capture) return { $etat: 'absent', motif: 'aucune capture : appel antérieur à la capture (lot 82C) ou capture non écrite — non reconstitué' };
  const out: Row = {
    captureStatus: capture.capture_status ?? null, captureReason: capture.capture_reason ?? null,
    promptStatus: capture.prompt_status ?? null, responseStatus: capture.response_status ?? null,
    attemptDurationMs: capture.attempt_duration_ms ?? null, executionElapsedMs: capture.execution_elapsed_ms ?? null,
  };
  for (const [key, col, statusCol] of CONTENT_FIELDS) {
    const len = capture[`${col}_len`];
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
    const rows = await q(`SELECT ${USAGE_COLS}, business_execution_id FROM ai_usage_event
       WHERE business_execution_id = ANY($1::text[]) OR (business_execution_id IS NULL AND (metadata->>'traceId') = ANY($2::text[]))
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
      const id = r.business_execution_id ? String(r.business_execution_id) : traces.get(String(r.trace_id)) ?? null;
      const l = id ? out.get(id) : undefined;
      if (l) l.push({ row: r, capture: caps.get(Number(r.id)) ?? null });
    }
  }
  return out;
}

/** Synthèse des appels d'une exécution (même règle que `callsOfExecutions` : inconnu ≠ zéro). */
function callsSummary(calls: Array<{ row: Row }>): ExecutionCallsDto {
  const s: ExecutionCallsDto = { calls: 0, failedCalls: 0, repairCalls: 0, costMicros: 0, models: [], usageEventIds: [] };
  for (const { row: r } of calls) {
    s.calls++;
    if (r.status !== 'success') s.failedCalls++;
    if (r.call_kind === 'repair') s.repairCalls++;
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
// Export unitaire (JSON structuré)
// ══════════════════════════════════════════════════════════════════════════

/** Une exécution, tous ses appels et échanges, travaux et rapports (lecture cohérente). null : inconnue. */
export async function buildExecutionUnitExport(id: string, opts: { sensitive: boolean; now?: Date; session?: ReadSession }): Promise<Record<string, unknown> | null> {
  const { getBusinessExecution } = await import('./repository');
  const { missingOf, isCauseUnknown } = await import('./detail-model');
  const own = !opts.session;
  const s = opts.session ?? await openReadSession();
  try {
    const now = opts.now ?? new Date(s.info.at);
    const x = await getBusinessExecution(id, now, s.q);
    if (!x) return null;
    const calls = (await readCallsOf(s.q, [x], opts.sensitive)).get(x.id) ?? [];
    const dto = toExecutionDto(x, callsSummary(calls));
    const jobs = x.jobIds.length ? await s.q(`SELECT id, treatment, account_id, target_type, target_id, status, origin, trigger_code, attempts, left(last_error, 500) AS last_error,
        business_result, created_at, started_at, finished_at FROM ai_job_queue WHERE id = ANY($1::int[]) ORDER BY id`, [x.jobIds]) : [];
    const { REPORT_COLS } = await import('@/services/admin/diagnostics-export/trace');
    const reports = x.reportIds.length ? await s.q(`SELECT ${REPORT_COLS} FROM ai_execution_reports WHERE id = ANY($1::bigint[]) ORDER BY id`, [x.reportIds]) : [];
    const entries = x.reportIds.length ? await s.q(`SELECT r.id AS report_id, e.seq, e.section, e.table_name, e.record_id, e.field_key, e.label, e.entity_type, e.entity_id,
        e.value_type, e.value_chars, e.record_status, e.write_result, e.reason_code, e.reason
        FROM ai_execution_reports r JOIN ai_execution_report_entries e ON e.report_id = coalesce(r.entries_report_id, r.id)
       WHERE r.id = ANY($1::bigint[]) ORDER BY r.id, e.seq`, [x.reportIds]) : [];
    return {
      format: EXECUTION_UNIT_SCHEMA, readAt: s.info.at, snapshot: { isolation: s.info.isolation, at: s.info.at, snapshot: s.info.snapshot },
      sensitiveContent: opts.sensitive,
      execution: executionLine(dto), missing: missingOf(dto), causeUnknown: isCauseUnknown(dto),
      calls: calls.map((c) => callLine(x.id, c.row, c.capture, opts.sensitive)),
      jobs: maskForExport(jobs), reports: maskForExport(reports),
      writes: maskForExport(entries),
      notes: [
        'Écritures : métadonnées des lignes de rapport (table, champ, résultat d’écriture, motif) — les valeurs restent consultables au rapport d’exécution (accès journalisé).',
        opts.sensitive ? 'Contenus des échanges IA inclus (administrateur habilité, demande journalisée).' : 'Contenus des échanges IA masqués (longueur + SHA-256).',
      ],
    };
  } finally {
    if (own) await (s as ReadSession & { close(): Promise<void> }).close().catch(() => undefined);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Export groupé / volumineux (tâche de fond, stocké, reprenable)
// ══════════════════════════════════════════════════════════════════════════

export function perimeterOf(f: JournalFilter, sensitive: boolean): ExportPerimeter {
  return {
    params: Object.fromEntries(journalFilterToParams(f)), from: f.period.from.toISOString(), to: f.period.to.toISOString(), rule: f.period.rule,
    timeZone: 'Europe/Paris', treatment: f.treatment, outcome: f.outcome, nature: f.nature, origin: f.origin, accountId: f.accountId,
    sensitiveContent: sensitive, fingerprint: sha256(journalFilterFingerprint(f)).slice(0, 16),
  };
}

const filterOf = (p: ExportPerimeter): Pick<JournalFilter, 'treatment' | 'outcome' | 'nature' | 'origin' | 'accountId'> => ({
  treatment: p.treatment, outcome: p.outcome, nature: p.nature, origin: p.origin as JournalFilter['origin'], accountId: p.accountId,
});

export interface RunOptions {
  generationId: string;
  state: ExportResumeState;
  storage?: ExportStorage;
  volumeMaxBytes?: number;
  /** Point de reprise écrit (tests : simuler un arrêt du processus en levant ici). */
  onCheckpoint?: (s: ExportResumeState) => Promise<void> | void;
  onProgress?: (p: { rowsExported: number; files: number; bytes: number }) => void;
  session?: ReadSession;
}

/**
 * Produit (ou poursuit) l'export à partir de `state.cursorAt`, écrit le
 * manifeste EN DERNIER et le rend. Une erreur laisse le dernier point de
 * reprise valide (parties closes) et se propage.
 */
export async function runExecutionsExport(opts: RunOptions): Promise<ExecutionsManifest> {
  const st = opts.state;
  const storage = opts.storage ?? await defaultStorage();
  const prefix = executionsExportPrefix(opts.generationId);
  const { openGzipUpload } = await import('@/services/backup/s3-gzip-upload');
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const { saveResumeState } = await import('@/services/admin/export-generations');
  const own = !opts.session;
  const s = opts.session ?? await openReadSession();
  const readAt = new Date(st.readAt);
  const end = readEnd(st.perimeter, st.readAt);
  const filter = filterOf(st.perimeter);
  const treatments = st.perimeter.treatment ? [st.perimeter.treatment] : [...BUSINESS_TREATMENTS];
  type Up = Awaited<ReturnType<typeof openGzipUpload>>;
  type Part = { n: number; exec: Up; calls: Up; rows: number };
  /** Partie ouverte (porteur : les fermetures la modifient). */
  const cur: { part: Part | null } = { part: null };
  const tick = () => opts.onProgress?.({
    rowsExported: st.totals.executions.exported, files: st.files.length, bytes: st.files.reduce((n, f) => n + f.bytes, 0),
  });
  const checkpoint = async () => {
    await saveResumeState(opts.generationId, st, { rowsExported: st.totals.executions.exported, files: st.files.length, bytes: st.files.reduce((n, f) => n + f.bytes, 0) });
    await opts.onCheckpoint?.(st);
  };
  const openPart = async (): Promise<Part> => {
    const n = st.nextPart;
    cur.part = {
      n, rows: 0,
      exec: await openGzipUpload(storage.client, storage.bucket, `${prefix}${partPath('executions', n)}`, { contentType: 'application/gzip' }),
      calls: await openGzipUpload(storage.client, storage.bucket, `${prefix}${partPath('appels', n)}`, { contentType: 'application/gzip' }),
    };
    return cur.part;
  };
  /** Totaux de la partie ouverte (reportés dans `st` seulement à sa fermeture : un arrêt ne les compte jamais). */
  let pending = { executions: 0, expected: 0, calls: 0, callsExpected: 0, rows: [] as Array<{ outcome: string; treatment: string; nature: string }> };
  const closePart = async () => {
    const p = cur.part!;
    const e = await p.exec.finish();
    const c = await p.calls.finish();
    const files: ExportFile[] = [
      { path: partPath('executions', p.n), kind: 'executions', part: p.n, expected: pending.expected, exported: pending.executions, bytes: e.bytes, compressedBytes: e.compressedBytes, sha256: e.sha256, status: pending.expected === pending.executions ? 'COMPLETE' : 'PARTIAL' },
      { path: partPath('appels', p.n), kind: 'appels', part: p.n, expected: pending.callsExpected, exported: pending.calls, bytes: c.bytes, compressedBytes: c.compressedBytes, sha256: c.sha256, status: pending.callsExpected === pending.calls ? 'COMPLETE' : 'PARTIAL' },
    ];
    st.files.push(...files);
    st.totals.executions.expected += pending.expected;
    st.totals.executions.exported += pending.executions;
    st.totals.calls.expected += pending.callsExpected;
    st.totals.calls.exported += pending.calls;
    for (const r of pending.rows) addToTotals(st.totals, r as never);
    pending = { executions: 0, expected: 0, calls: 0, callsExpected: 0, rows: [] };
    st.nextPart = p.n + 1;
    cur.part = null;
  };

  try {
    st.sessions.push({ at: s.info.at, snapshot: s.info.snapshot, fromCursor: st.cursorAt });
    let cursor = new Date(st.cursorAt);
    let width = st.sliceMs;
    while (cursor < end) {
      const sl = sliceAt(cursor, end, width);
      const rows: BusinessExecution[] = [];
      let truncated = false;
      for (const t of treatments) {
        try {
          const proj = await s.savepoint(() => projectBusinessExecutions({ from: sl.from, to: sl.to, treatments: [t], accountId: st.perimeter.accountId }, readAt, s.q));
          if (proj.truncated.length) truncated = true;
          for (const u of proj.unavailable) {
            st.partial = true;
            st.warnings.push(`${u.treatment} illisible sur [${sl.from.toISOString()} ; ${sl.to.toISOString()}[ : ${u.message}`);
          }
          rows.push(...proj.rows);
        } catch (e) {
          if ((e as { code?: string })?.code === '25006') throw e;
          st.partial = true;
          st.warnings.push(`${t} illisible sur [${sl.from.toISOString()} ; ${sl.to.toISOString()}[ : ${describe(e)}`);
        }
      }
      if (truncated && sl.to.getTime() - sl.from.getTime() > EXPORT_MIN_SLICE_MS) {
        // Plafond de lecture atteint : tranche coupée en deux (aucune coupe silencieuse).
        width = Math.max(EXPORT_MIN_SLICE_MS, Math.floor((sl.to.getTime() - sl.from.getTime()) / 2));
        continue;
      }
      if (truncated) {
        st.partial = true;
        st.warnings.push(`Plafond de lecture atteint sur une tranche d’une minute [${sl.from.toISOString()} ; ${sl.to.toISOString()}[ : exécutions au-delà du plafond NON exportées.`);
      }
      const sel = rows
        .filter((r) => matchesJournalFilter(r, filter) && r.referenceAt.getTime() < readAt.getTime())
        .sort((a, b) => a.referenceAt.getTime() - b.referenceAt.getTime() || a.id.localeCompare(b.id));
      if (sel.length) {
        const p = cur.part ?? await openPart();
        const calls = await s.savepoint(() => readCallsOf(s.q, sel, st.perimeter.sensitiveContent));
        let chunk = '';
        let callChunk = '';
        for (const x of sel) {
          const cs = calls.get(x.id) ?? [];
          const dto = toExecutionDto(x, callsSummary(cs));
          chunk += `${recetteLine(maskForExport(executionLine(dto)) as Row)}\n`;
          pending.expected++;
          pending.executions++;
          pending.rows.push({ outcome: dto.outcome, treatment: dto.treatment, nature: dto.nature });
          p.rows++;
          for (const c of cs) {
            callChunk += `${recetteLine(callLine(x.id, c.row, c.capture, st.perimeter.sensitiveContent))}\n`;
            pending.callsExpected++;
            pending.calls++;
          }
          if (chunk.length > 1_000_000) { await p.exec.write(chunk); chunk = ''; }
          if (callChunk.length > 1_000_000) { await p.calls.write(callChunk); callChunk = ''; }
        }
        if (chunk) await p.exec.write(chunk);
        if (callChunk) await p.calls.write(callChunk);
      }
      cursor = sl.to;
      width = st.sliceMs;
      tick();
      if (cur.part && cur.part.rows >= st.partRows) {
        await closePart();
        st.cursorAt = cursor.toISOString();
        await checkpoint();
      }
    }
    if (cur.part || st.files.length === 0) {
      if (!cur.part) await openPart();
      await closePart();
    }
    st.cursorAt = end.toISOString();
    st.done = true;

    const finishedAt = new Date().toISOString();
    const build = getBuildIdentity();
    const extra = {
      generatedAt: st.sessions[0]?.at ?? st.readAt, finishedAt, environment: (process.env.NEXT_PUBLIC_APP_ENV || process.env.NODE_ENV || 'inconnu').trim(),
      build: { version: build.version ?? null, commit: build.commit ?? null }, volumeMaxBytes: opts.volumeMaxBytes,
    };
    const readme = exportReadme(buildManifest(opts.generationId, st, extra));
    await storage.client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: `${prefix}LISEZMOI.txt`, Body: readme, ContentType: 'text/plain; charset=utf-8' }));
    st.files.push({ path: 'LISEZMOI.txt', kind: 'documentation', part: null, expected: null, exported: 0, bytes: Buffer.byteLength(readme), compressedBytes: null, sha256: sha256(readme), status: 'COMPLETE' });
    const manifest = buildManifest(opts.generationId, st, extra);
    await storage.client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: `${prefix}manifeste.json`, Body: `${JSON.stringify(manifest, null, 2)}\n`, ContentType: 'application/json; charset=utf-8' }));
    await checkpoint();
    return manifest;
  } catch (e) {
    const p = cur.part;
    if (p) { await p.exec.abort().catch(() => undefined); await p.calls.abort().catch(() => undefined); }
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
type LaunchOptions = Pick<RunOptions, 'storage' | 'volumeMaxBytes' | 'onCheckpoint'> & { sliceMs?: number; partRows?: number; now?: Date };

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
      await gen.finishGeneration(generationId, {
        status: m.status, snapshotAt: m.sessions[m.sessions.length - 1]?.at ?? null, pgSnapshot: m.sessions[m.sessions.length - 1]?.snapshot ?? null,
        rowsExpected: m.totals.executions.expected, rowsExported: m.totals.executions.exported, batches: null,
        bytes: m.files.reduce((n, f) => n + f.bytes, 0), files: m.files.length + 1, sections: m.files,
        error: m.status === 'COMPLETE' ? null : m.warnings.join(' ; ').slice(0, 4000) || 'export partiel', fileName: `${executionsExportPrefix(generationId)}manifeste.json`,
      });
      await audit(admin, m.status === 'FAILED' ? 'FAILURE' : 'SUCCESS', { generationId, phase: 'finished', from: phase, status: m.status, executions: m.totals.executions.exported, calls: m.totals.calls.exported });
      await purgeOldExecutionsExports(opts.storage).catch((e) => console.error('[ai/executions-export] purge des anciens exports impossible :', (e as Error).message));
    } catch (e) {
      console.error('[ai/executions-export] génération interrompue :', (e as Error)?.message ?? e);
      // Le point de reprise (dernière partie close) reste en place : la génération peut être reprise.
      await gen.finishGeneration(generationId, {
        status: 'FAILED', rowsExported: st.totals.executions.exported, files: st.files.length,
        error: `génération interrompue — reprise possible à partir de ${st.cursorAt} : ${describe(e)}`,
      });
      await audit(admin, 'FAILURE', { generationId, phase: 'interrupted', from: phase, cursorAt: st.cursorAt, error: describe(e) });
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

/**
 * Lance un export groupé (tâche de fond) ; rend l'identifiant dès que la
 * génération est enregistrée (RUNNING) avec son point de reprise initial.
 */
export async function startExecutionsExport(admin: Admin, f: JournalFilter, opts: LaunchOptions & { sensitive: boolean }): Promise<{ generationId: string; storagePrefix: string }> {
  const release = await acquire();
  try {
    const gen = await import('@/services/admin/export-generations');
    const generationId = randomUUID();
    const storagePrefix = executionsExportPrefix(generationId);
    const perimeter = perimeterOf(f, opts.sensitive);
    const st = initialResumeState(perimeter, opts.now ?? new Date(), { sliceMs: opts.sliceMs, partRows: opts.partRows });
    await gen.startGeneration({
      id: generationId, kind: 'AI_EXECUTIONS_EXPORT', mode: 'stockage', adminUserId: admin.id, targetType: 'AI_EXECUTIONS',
      targetId: null, targetAccountId: f.accountId, perimeter: { ...perimeter.params, from: perimeter.from, to: perimeter.to, contenusSensibles: opts.sensitive }, storagePrefix,
    });
    await gen.saveResumeState(generationId, st);
    await audit(admin, 'SUCCESS', { generationId, phase: 'launched', perimeter: perimeter.params, from: perimeter.from, to: perimeter.to, readAt: st.readAt, contenusSensibles: opts.sensitive });
    runInBackground(admin, generationId, st, opts, release, 'launched');
    return { generationId, storagePrefix };
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
    st.files = st.files.filter((f) => f.kind !== 'documentation');
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

/** Fichiers téléchargeables (écrits, listés au manifeste) — jamais une clé arbitraire. */
export function executionsDownloadables(m: ExecutionsManifest | null): string[] {
  if (!m) return [];
  return [...m.files.filter((f) => f.sha256 !== null).map((f) => f.path), 'manifeste.json'];
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
