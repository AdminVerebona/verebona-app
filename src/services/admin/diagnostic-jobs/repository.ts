/**
 * Lot 107G — FILE DURABLE des diagnostics BO (serveur uniquement).
 *
 * La ligne `admin_export_generations` (kind TECH_DIAGNOSTIC, mode 'job') EST
 * le travail — mêmes garanties que les dossiers V12 (`export_generation`) et
 * l'archive RGPD « Mes données » (`gdpr_exports`, lot 103C), sans dépendre de
 * la file IA :
 *   · mise en file ATOMIQUE et IDEMPOTENTE (verrou consultatif) : double clic,
 *     requête rejouée (`Idempotency-Key`) ou demande identique déjà en cours →
 *     même travail ;
 *   · prise `FOR UPDATE SKIP LOCKED`, concurrence GLOBALE bornée (toutes
 *     instances) ;
 *   · bail (`locked_by`, `locked_until`) renouvelé ; écritures du worker
 *     conditionnées à la possession du bail (une tentative reprise ailleurs
 *     n'écrit plus rien) ;
 *   · rattrapage : bail expiré → nouvelle tentative (WORKER_LOST) ou FAILED
 *     explicite (WORKER_LOST_MAX_ATTEMPTS) ; anciennes générations
 *     synchrones jamais closes → FAILED LEGACY_HTTP_INTERRUPTED (persisté).
 */
import { randomUUID } from 'node:crypto';
import {
  DIAG_JOB_ERROR_LABELS, DIAG_JOB_MODE, diagJobSettings, requestKey, retryDelaySeconds, sanitizeErrorMessage,
  type DiagJobAttempt, type DiagJobErrorCode, type DiagJobPhase, type DiagJobProgress, type DiagJobStatus,
} from './state';

type Raw = Record<string, unknown>;

/** Verrou consultatif de la file des diagnostics (mise en file, prise). */
const QUEUE_LOCK = 'verebona:diagnostic-jobs';

export class DiagLeaseLostError extends Error {
  constructor() { super('bail perdu : génération reprise ailleurs, annulée ou close'); this.name = 'DiagLeaseLostError'; }
}

export interface DiagJobRequest { scope: string; id: number | null; reinforced: boolean }

export interface DiagJobRow {
  id: string;
  status: DiagJobStatus;
  phase: DiagJobPhase | null;
  adminUserId: number | null;
  request: DiagJobRequest;
  attempt: number;
  maxAttempts: number;
  lockedBy: string | null;
  lockedUntil: string | null;
  parentId: string | null;
  requestId: string | null;
  storagePrefix: string | null;
  cancelRequested: boolean;
  attemptsLog: DiagJobAttempt[];
  progress: DiagJobProgress | null;
}

const iso = (v: unknown) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
const json = <T>(v: unknown, d: T): T => (v == null ? d : (typeof v === 'string' ? JSON.parse(v) : v) as T);

function toJob(r: Raw): DiagJobRow {
  const p = json<Raw>(r.perimeter, {});
  return {
    id: String(r.id), status: String(r.status) as DiagJobStatus, phase: (r.phase ?? null) as DiagJobPhase | null,
    adminUserId: r.admin_user_id == null ? null : Number(r.admin_user_id),
    request: { scope: String(p.scope ?? r.target_type ?? 'global'), id: p.id == null ? null : Number(p.id), reinforced: p.reinforced === true },
    attempt: Number(r.attempt ?? 0), maxAttempts: Number(r.max_attempts ?? diagJobSettings().maxAttempts),
    lockedBy: r.locked_by == null ? null : String(r.locked_by), lockedUntil: iso(r.locked_until),
    parentId: r.parent_id == null ? null : String(r.parent_id), requestId: r.request_id == null ? null : String(r.request_id),
    storagePrefix: r.storage_prefix == null ? null : String(r.storage_prefix),
    cancelRequested: r.cancel_requested === true,
    attemptsLog: json<DiagJobAttempt[]>(r.attempts_log, []),
    progress: json<DiagJobProgress | null>(r.progress, null),
  };
}

async function db() {
  return (await import('@/db')).pgClient;
}

// ── Mise en file (idempotente) ─────────────────────────────────────────────

export interface EnqueueInput {
  adminUserId: number;
  request: DiagJobRequest;
  idempotencyKey?: string | null;
  requestId?: string | null;
  parentId?: string | null;
}

/**
 * Enregistre une demande de diagnostic (QUEUED) et rend son identifiant, SANS
 * rien générer. Idempotente : même `Idempotency-Key` (24 h), ou demande
 * identique encore en file / en cours → le travail existant (`duplicate`).
 */
export async function enqueueDiagnosticJob(input: EnqueueInput): Promise<{ job: DiagJobRow; duplicate: boolean }> {
  const sql = await db();
  const s = diagJobSettings();
  const key = requestKey(input.request);
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${QUEUE_LOCK}))`;
    if (input.idempotencyKey) {
      const [same] = await tx<Raw[]>`
        SELECT * FROM admin_export_generations
         WHERE kind = 'TECH_DIAGNOSTIC' AND mode = ${DIAG_JOB_MODE} AND idempotency_key = ${input.idempotencyKey}
           AND started_at > now() - interval '24 hours'
         ORDER BY started_at DESC LIMIT 1`;
      if (same) return { job: toJob(same), duplicate: true };
    }
    const [active] = await tx<Raw[]>`
      SELECT * FROM admin_export_generations
       WHERE kind = 'TECH_DIAGNOSTIC' AND mode = ${DIAG_JOB_MODE} AND status IN ('QUEUED', 'RUNNING')
         AND perimeter->>'requestKey' = ${key} AND NOT cancel_requested
       ORDER BY started_at LIMIT 1`;
    if (active) return { job: toJob(active), duplicate: true };
    const id = randomUUID();
    const perimeter = { scope: input.request.scope, id: input.request.id, reinforced: input.request.reinforced, requestKey: key };
    const [row] = await tx<Raw[]>`
      INSERT INTO admin_export_generations
        (id, kind, mode, admin_user_id, target_type, target_id, target_account_id, perimeter, status, phase, attempt, max_attempts,
         idempotency_key, request_id, parent_id, storage_prefix)
      VALUES (${id}, 'TECH_DIAGNOSTIC', ${DIAG_JOB_MODE}, ${input.adminUserId}, ${input.request.scope}, ${input.request.id},
              ${input.request.scope === 'account' ? input.request.id : null}, ${JSON.stringify(perimeter)}::jsonb, 'QUEUED', 'EN_FILE', 0, ${s.maxAttempts},
              ${input.idempotencyKey ?? null}, ${input.requestId ?? null}, ${input.parentId ?? null}, ${`admin-exports/diagnostics/${id}/`})
      RETURNING *`;
    return { job: toJob(row), duplicate: false };
  }) as Promise<{ job: DiagJobRow; duplicate: boolean }>;
}

/**
 * « Relancer » : nouveau travail (même demande) rattaché à `parentId`. Sans
 * double demande : un enfant déjà en file / en cours est rendu tel quel.
 * Refusé (null) si le parent est introuvable ou encore actif.
 */
export async function retryDiagnosticJob(parentId: string, adminUserId: number, requestId: string | null): Promise<{ job: DiagJobRow; duplicate: boolean } | { refused: 'NOT_FOUND' | 'STILL_ACTIVE' }> {
  const sql = await db();
  const [parent] = await sql<Raw[]>`SELECT * FROM admin_export_generations WHERE id = ${parentId}::uuid AND kind = 'TECH_DIAGNOSTIC'`;
  if (!parent) return { refused: 'NOT_FOUND' };
  if (parent.status === 'QUEUED' || parent.status === 'RUNNING') return { refused: 'STILL_ACTIVE' };
  const [child] = await sql<Raw[]>`
    SELECT * FROM admin_export_generations WHERE parent_id = ${parentId}::uuid AND status IN ('QUEUED', 'RUNNING') ORDER BY started_at LIMIT 1`;
  if (child) return { job: toJob(child), duplicate: true };
  const p = json<Raw>(parent.perimeter, {});
  const request: DiagJobRequest = {
    scope: String(p.scope ?? parent.target_type ?? 'global'),
    id: p.id == null ? (parent.target_id == null ? null : Number(parent.target_id)) : Number(p.id),
    reinforced: p.reinforced === true,
  };
  // Relance d'une génération : clé d'idempotence dérivée du parent (deux clics → un seul enfant).
  return enqueueDiagnosticJob({ adminUserId, request, parentId, requestId, idempotencyKey: `retry:${parentId}` });
}

/** Annulation : QUEUED → CANCELLED immédiat ; RUNNING → demande lue par le worker. */
export async function cancelDiagnosticJob(id: string): Promise<'CANCELLED' | 'REQUESTED' | 'NOT_ACTIVE' | 'NOT_FOUND'> {
  const sql = await db();
  const [r] = await sql<Raw[]>`SELECT status FROM admin_export_generations WHERE id = ${id}::uuid AND kind = 'TECH_DIAGNOSTIC' AND mode = ${DIAG_JOB_MODE}`;
  if (!r) return 'NOT_FOUND';
  if (r.status === 'QUEUED') {
    const done = await sql`UPDATE admin_export_generations SET status = 'CANCELLED', phase = 'TERMINE', finished_at = now(), error_code = 'CANCELLED',
             error = ${DIAG_JOB_ERROR_LABELS.CANCELLED}, cancel_requested = true WHERE id = ${id}::uuid AND status = 'QUEUED' RETURNING id`;
    if (done.length) return 'CANCELLED';
  }
  const req = await sql`UPDATE admin_export_generations SET cancel_requested = true WHERE id = ${id}::uuid AND status = 'RUNNING' RETURNING id`;
  return req.length ? 'REQUESTED' : 'NOT_ACTIVE';
}

// ── Rattrapage des orphelins ────────────────────────────────────────────────

/** Ancienne génération synchrone (consultation / zip) sans clôture au-delà de ce délai : interrompue. */
const LEGACY_STALE_MS = 2 * 60 * 60_000;

/**
 * Rattrapage (à chaque tour du worker et avant chaque prise) :
 *   · bail expiré (processus arrêté) : nouvelle tentative différée
 *     (WORKER_LOST) ou FAILED explicite (WORKER_LOST_MAX_ATTEMPTS) — la
 *     dernière progression connue (étape, fichier, mémoire) est conservée
 *     dans l'historique des tentatives : c'est la PREUVE de l'endroit où le
 *     processus s'est arrêté ;
 *   · ancienne génération synchrone (avant 107G) restée RUNNING : FAILED
 *     LEGACY_HTTP_INTERRUPTED, persisté (plus seulement calculé à l'affichage) ;
 *   · annulation demandée sur un travail en file : CANCELLED.
 */
export async function recoverDiagnosticJobs(now: Date = new Date()): Promise<{ requeued: string[]; failed: string[]; legacy: string[] }> {
  const sql = await db();
  const nowIso = now.toISOString();
  const lost = await sql<Raw[]>`
    SELECT id, attempt, max_attempts, phase, progress, attempts_log FROM admin_export_generations
     WHERE kind = 'TECH_DIAGNOSTIC' AND mode = ${DIAG_JOB_MODE} AND status = 'RUNNING' AND locked_until IS NOT NULL AND locked_until < ${nowIso}::timestamptz`;
  const requeued: string[] = [];
  const failed: string[] = [];
  for (const r of lost) {
    const attempt = Number(r.attempt ?? 0);
    const max = Number(r.max_attempts ?? diagJobSettings().maxAttempts);
    const exhausted = attempt >= max;
    const code: DiagJobErrorCode = exhausted ? 'WORKER_LOST_MAX_ATTEMPTS' : 'WORKER_LOST';
    const prog = json<DiagJobProgress | null>(r.progress, null);
    const log = json<DiagJobAttempt[]>(r.attempts_log, []);
    const last = log[log.length - 1];
    if (last && !last.endedAt) Object.assign(last, {
      endedAt: now.toISOString(), outcome: 'LOST', errorCode: 'WORKER_LOST', phase: r.phase ?? null,
      lastProgress: prog ? { filesDone: prog.filesDone, filesPlanned: prog.filesPlanned, current: prog.current, rssMb: prog.rssMb, peakRssMb: prog.peakRssMb } : null,
    });
    const msg = `${DIAG_JOB_ERROR_LABELS[code]} Dernier signe de vie : étape ${String(r.phase ?? '?')}${prog?.current ? `, fichier ${prog.current}` : ''}${prog?.rssMb ? `, mémoire ${prog.rssMb} Mo (pic ${prog.peakRssMb ?? '?'} Mo)` : ''} — tentative ${attempt}/${max}.`;
    const rows = exhausted
      ? await sql`UPDATE admin_export_generations SET status = 'FAILED', finished_at = ${nowIso}::timestamptz, error_code = ${code}, error_phase = phase, error_at = ${nowIso}::timestamptz,
                 error = ${msg}, locked_by = NULL, locked_until = NULL, attempts_log = ${JSON.stringify(log)}::jsonb
           WHERE id = ${String(r.id)}::uuid AND status = 'RUNNING' AND locked_until < ${nowIso}::timestamptz RETURNING id`
      : await sql`UPDATE admin_export_generations SET status = 'QUEUED', next_attempt_at = ${new Date(now.getTime() + retryDelaySeconds(attempt) * 1000).toISOString()}::timestamptz,
                 error_code = ${code}, error_phase = phase, error_at = ${nowIso}::timestamptz, error = ${msg}, phase = 'EN_FILE', locked_by = NULL, locked_until = NULL,
                 attempts_log = ${JSON.stringify(log)}::jsonb
           WHERE id = ${String(r.id)}::uuid AND status = 'RUNNING' AND locked_until < ${nowIso}::timestamptz RETURNING id`;
    if (!rows.length) continue;
    (exhausted ? failed : requeued).push(String(r.id));
    console.error(`[diagnostic-job] ${JSON.stringify({ event: 'orphan', jobId: String(r.id), code, attempt, max, phase: r.phase ?? null, current: prog?.current ?? null, rssMb: prog?.rssMb ?? null })}`);
  }
  const legacy = await sql<Raw[]>`
    UPDATE admin_export_generations
       SET status = 'FAILED', finished_at = ${nowIso}::timestamptz, error_code = 'LEGACY_HTTP_INTERRUPTED', error_phase = 'GENERATION_HTTP', error_at = ${nowIso}::timestamptz,
           error = ${`${DIAG_JOB_ERROR_LABELS.LEGACY_HTTP_INTERRUPTED} Ligne close automatiquement par le lot 107G (aucune fin enregistrée).`}
     WHERE kind = 'TECH_DIAGNOSTIC' AND mode <> ${DIAG_JOB_MODE} AND status = 'RUNNING'
       AND coalesce(heartbeat_at, started_at) < ${new Date(now.getTime() - LEGACY_STALE_MS).toISOString()}::timestamptz
    RETURNING id`;
  await sql`UPDATE admin_export_generations SET status = 'CANCELLED', phase = 'TERMINE', finished_at = ${nowIso}::timestamptz, error_code = 'CANCELLED', error = ${DIAG_JOB_ERROR_LABELS.CANCELLED}
             WHERE kind = 'TECH_DIAGNOSTIC' AND mode = ${DIAG_JOB_MODE} AND status = 'QUEUED' AND cancel_requested`;
  return { requeued, failed, legacy: legacy.map((r) => String(r.id)) };
}

// ── Prise et bail ───────────────────────────────────────────────────────────

/**
 * Prend le prochain diagnostic à faire (QUEUED, échéance passée), dans la
 * limite de la concurrence GLOBALE (toutes instances) — verrou consultatif :
 * deux instances ne prennent jamais deux travaux au-delà de la borne.
 */
export async function claimNextDiagnosticJob(workerId: string, commit: string | null, opts: { onlyId?: string; now?: Date } = {}): Promise<DiagJobRow | null> {
  const sql = await db();
  const s = diagJobSettings();
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${QUEUE_LOCK}))`;
    const [busy] = await tx<Raw[]>`
      SELECT count(*)::int AS n FROM admin_export_generations
       WHERE kind = 'TECH_DIAGNOSTIC' AND mode = ${DIAG_JOB_MODE} AND status = 'RUNNING' AND locked_until > now()`;
    if (Number(busy?.n ?? 0) >= s.globalConcurrency) return null;
    const [pick] = await tx<Raw[]>`
      SELECT * FROM admin_export_generations
       WHERE kind = 'TECH_DIAGNOSTIC' AND mode = ${DIAG_JOB_MODE} AND status = 'QUEUED' AND NOT cancel_requested
         AND (next_attempt_at IS NULL OR next_attempt_at <= now())
         ${opts.onlyId ? tx`AND id = ${opts.onlyId}::uuid` : tx``}
       ORDER BY started_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`;
    if (!pick) return null;
    const log = json<DiagJobAttempt[]>(pick.attempts_log, []);
    const attempt = Number(pick.attempt ?? 0) + 1;
    log.push({ attempt, worker: workerId, commit, startedAt: new Date().toISOString(), endedAt: null, outcome: null, errorCode: null, phase: 'PLANIFICATION' });
    const [row] = await tx<Raw[]>`
      UPDATE admin_export_generations
         SET status = 'RUNNING', phase = 'PLANIFICATION', attempt = ${attempt}, locked_by = ${workerId},
             locked_until = now() + make_interval(secs => ${s.leaseSeconds}), heartbeat_at = now(), run_started_at = now(),
             next_attempt_at = NULL, build_commit = ${commit}, attempts_log = ${JSON.stringify(log)}::jsonb, finished_at = NULL
       WHERE id = ${String(pick.id)}::uuid RETURNING *`;
    return toJob(row);
  }) as Promise<DiagJobRow | null>;
}

/** Renouvelle le bail (et la progression) ; `ok: false` si le bail est perdu, `cancel` si une annulation est demandée. */
export async function renewDiagnosticLease(id: string, workerId: string, progress?: DiagJobProgress | null): Promise<{ ok: boolean; cancel: boolean }> {
  const sql = await db();
  const s = diagJobSettings();
  const rows = await sql<Raw[]>`
    UPDATE admin_export_generations
       SET locked_until = now() + make_interval(secs => ${s.leaseSeconds}), heartbeat_at = now(),
           progress = COALESCE(${progress ? JSON.stringify(progress) : null}::jsonb, progress)
     WHERE id = ${id}::uuid AND locked_by = ${workerId} AND status = 'RUNNING' RETURNING cancel_requested`;
  return { ok: rows.length > 0, cancel: rows[0]?.cancel_requested === true };
}

/** Étape atteinte (point de reprise journalisé) ; lève `DiagLeaseLostError` si le bail n'est plus à nous. */
export async function setDiagnosticPhase(id: string, workerId: string, phase: DiagJobPhase, progress?: DiagJobProgress | null): Promise<void> {
  const sql = await db();
  const rows = await sql`
    UPDATE admin_export_generations SET phase = ${phase}, heartbeat_at = now(),
           progress = COALESCE(${progress ? JSON.stringify(progress) : null}::jsonb, progress)
     WHERE id = ${id}::uuid AND locked_by = ${workerId} AND status = 'RUNNING' RETURNING id`;
  if (!rows.length) throw new DiagLeaseLostError();
}

export interface DiagJobOutcome {
  status: 'COMPLETE' | 'PARTIAL';
  snapshotAt: string | null;
  pgSnapshot: string | null;
  rowsExpected: number;
  rowsExported: number;
  batches: number;
  bytes: number;
  files: number;
  sections: unknown[];
  warning: string | null;
  fileName: string;
  progress: DiagJobProgress;
  /** Préfixe de la tentative publiée (fichiers téléchargeables). */
  storagePrefix: string;
}

function closeAttempt(log: DiagJobAttempt[], outcome: DiagJobAttempt['outcome'], code: DiagJobErrorCode | null, phase: DiagJobPhase | null, p: DiagJobProgress | null): DiagJobAttempt[] {
  const last = log[log.length - 1];
  if (last && !last.endedAt) Object.assign(last, {
    endedAt: new Date().toISOString(), outcome, errorCode: code, phase,
    lastProgress: p ? { filesDone: p.filesDone, filesPlanned: p.filesPlanned, current: p.current, rssMb: p.rssMb, peakRssMb: p.peakRssMb } : null,
  });
  return log;
}

/** Publication (après validation) : COMPLETE / PARTIAL ; exige le bail. */
export async function publishDiagnosticJob(job: DiagJobRow, workerId: string, o: DiagJobOutcome): Promise<void> {
  const sql = await db();
  const s = diagJobSettings();
  const [cur] = await sql<Raw[]>`SELECT attempts_log FROM admin_export_generations WHERE id = ${job.id}::uuid`;
  const log = closeAttempt(json<DiagJobAttempt[]>(cur?.attempts_log, []), o.status, null, 'TERMINE', o.progress);
  const rows = await sql`
    UPDATE admin_export_generations
       SET status = ${o.status}, phase = 'TERMINE', finished_at = now(), snapshot_at = ${o.snapshotAt}::timestamptz, pg_snapshot = ${o.pgSnapshot},
           rows_expected = ${o.rowsExpected}, rows_exported = ${o.rowsExported}, batches = ${o.batches}, bytes = ${o.bytes}, files = ${o.files},
           sections = ${JSON.stringify(o.sections)}::jsonb, error = ${o.warning ? sanitizeErrorMessage(o.warning) : null},
           error_code = NULL, error_phase = NULL, file_name = ${o.fileName}, progress = ${JSON.stringify(o.progress)}::jsonb, storage_prefix = ${o.storagePrefix},
           locked_by = NULL, locked_until = NULL, attempts_log = ${JSON.stringify(log)}::jsonb,
           expires_at = now() + make_interval(days => ${s.retentionDays})
     WHERE id = ${job.id}::uuid AND locked_by = ${workerId} AND status = 'RUNNING' RETURNING id`;
  if (!rows.length) throw new DiagLeaseLostError();
}

/**
 * Échec d'une tentative : erreur transitoire et tentatives restantes →
 * QUEUED (nouvelle tentative différée) ; sinon FAILED explicite. Exige le
 * bail. Rend le statut écrit (null : bail perdu, rien écrit).
 */
export async function failDiagnosticAttempt(job: DiagJobRow, workerId: string, f: {
  code: DiagJobErrorCode; phase: DiagJobPhase | null; message: string; transient: boolean; progress: DiagJobProgress | null; cancelled?: boolean;
}): Promise<DiagJobStatus | null> {
  const sql = await db();
  const [cur] = await sql<Raw[]>`SELECT attempt, max_attempts, attempts_log FROM admin_export_generations WHERE id = ${job.id}::uuid`;
  const attempt = Number(cur?.attempt ?? job.attempt);
  const max = Number(cur?.max_attempts ?? job.maxAttempts);
  const retry = !f.cancelled && f.transient && attempt < max;
  const status: DiagJobStatus = f.cancelled ? 'CANCELLED' : retry ? 'QUEUED' : 'FAILED';
  const log = closeAttempt(json<DiagJobAttempt[]>(cur?.attempts_log, []), retry ? 'RETRY' : status, f.code, f.phase, f.progress);
  const msg = sanitizeErrorMessage(`${DIAG_JOB_ERROR_LABELS[f.code]} ${f.message ? `Détail : ${f.message}` : ''}${retry ? ` — nouvelle tentative programmée (${attempt}/${max}).` : ` — tentative ${attempt}/${max}.`}`);
  const rows = await sql`
    UPDATE admin_export_generations
       SET status = ${status}, error_code = ${f.code}, error_phase = ${f.phase}, error_at = now(), error = ${msg},
           phase = ${retry ? 'EN_FILE' : 'TERMINE'}, finished_at = CASE WHEN ${retry} THEN NULL ELSE now() END,
           next_attempt_at = ${retry ? new Date(Date.now() + retryDelaySeconds(attempt) * 1000).toISOString() : null}::timestamptz,
           progress = COALESCE(${f.progress ? JSON.stringify(f.progress) : null}::jsonb, progress),
           locked_by = NULL, locked_until = NULL, attempts_log = ${JSON.stringify(log)}::jsonb
     WHERE id = ${job.id}::uuid AND locked_by = ${workerId} AND status = 'RUNNING' RETURNING id`;
  return rows.length ? status : null;
}

// ── Lecture ─────────────────────────────────────────────────────────────────

/** Détail d'un travail (ligne complète, bilan par section compris) ; null : inconnu. */
export async function readDiagnosticJob(id: string): Promise<(DiagJobRow & { raw: Raw }) | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const sql = await db();
  const [r] = await sql<Raw[]>`SELECT * FROM admin_export_generations WHERE id = ${id}::uuid AND kind = 'TECH_DIAGNOSTIC'`;
  return r ? { ...toJob(r), raw: r } : null;
}

/** Travaux expirés à purger (stockage), et marquage une fois purgés. */
export async function expiredDiagnosticJobs(limit = 50): Promise<Array<{ id: string; prefix: string }>> {
  const sql = await db();
  const rows = await sql<Raw[]>`
    SELECT id::text, storage_prefix FROM admin_export_generations
     WHERE kind = 'TECH_DIAGNOSTIC' AND mode = ${DIAG_JOB_MODE} AND purged_at IS NULL AND expires_at IS NOT NULL AND expires_at < now()
     ORDER BY expires_at LIMIT ${limit}`;
  return rows.filter((r) => r.storage_prefix).map((r) => ({ id: String(r.id), prefix: String(r.storage_prefix) }));
}

export async function markDiagnosticJobPurged(id: string): Promise<void> {
  const sql = await db();
  await sql`UPDATE admin_export_generations SET purged_at = now(), file_name = NULL WHERE id = ${id}::uuid`;
}

/** État de la file (observabilité sans générer de diagnostic). */
export async function diagnosticQueueHealth(now: Date = new Date()): Promise<Raw> {
  const sql = await db();
  const [cols] = await sql<Raw[]>`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'admin_export_generations' AND column_name IN ('phase', 'locked_until', 'attempts_log')`;
  if (Number(cols?.n ?? 0) < 3) return { migrationApplied: false };
  const byStatus = await sql<Raw[]>`
    SELECT status, count(*)::int AS n FROM admin_export_generations WHERE kind = 'TECH_DIAGNOSTIC' AND mode = ${DIAG_JOB_MODE} GROUP BY status`;
  const [oldest] = await sql<Raw[]>`
    SELECT min(started_at) AS at FROM admin_export_generations WHERE kind = 'TECH_DIAGNOSTIC' AND mode = ${DIAG_JOB_MODE} AND status = 'QUEUED'
       AND (next_attempt_at IS NULL OR next_attempt_at <= now())`;
  const running = await sql<Raw[]>`
    SELECT id::text, phase, attempt, max_attempts, locked_by, locked_until, heartbeat_at, progress, run_started_at
      FROM admin_export_generations WHERE kind = 'TECH_DIAGNOSTIC' AND mode = ${DIAG_JOB_MODE} AND status = 'RUNNING' ORDER BY run_started_at`;
  const failures = await sql<Raw[]>`
    SELECT id::text, status, error_code, error_phase, error_at, error, attempt, max_attempts, build_commit, attempts_log, target_type, target_id
      FROM admin_export_generations
     WHERE kind = 'TECH_DIAGNOSTIC' AND error_code IS NOT NULL AND error_code <> 'CANCELLED'
     ORDER BY coalesce(error_at, finished_at, started_at) DESC LIMIT 10`;
  const legacyRunning = await sql<Raw[]>`
    SELECT count(*)::int AS n FROM admin_export_generations WHERE kind = 'TECH_DIAGNOSTIC' AND mode <> ${DIAG_JOB_MODE} AND status = 'RUNNING'`;
  return {
    migrationApplied: true,
    byStatus: Object.fromEntries(byStatus.map((r) => [String(r.status), Number(r.n)])),
    oldestQueuedAgeSeconds: oldest?.at ? Math.round((now.getTime() - new Date(String(iso(oldest.at))).getTime()) / 1000) : null,
    running: running.map((r) => {
      const lockedUntil = iso(r.locked_until);
      const workerName = r.locked_by == null ? null : String(r.locked_by).split(':').slice(0, 2).join(':');
      return {
        id: String(r.id), phase: r.phase ?? null, attempt: Number(r.attempt ?? 0), maxAttempts: Number(r.max_attempts ?? 0), worker: workerName,
        lockedUntil, leaseExpired: lockedUntil ? Date.parse(lockedUntil) < now.getTime() : false, heartbeatAt: iso(r.heartbeat_at), runStartedAt: iso(r.run_started_at),
        progress: json<DiagJobProgress | null>(r.progress, null),
      };
    }),
    recentFailures: failures.map((r) => ({
      id: String(r.id), status: String(r.status), code: r.error_code ?? null, phase: r.error_phase ?? null, at: iso(r.error_at),
      message: r.error == null ? null : sanitizeErrorMessage(r.error), attempt: Number(r.attempt ?? 0), maxAttempts: r.max_attempts == null ? null : Number(r.max_attempts),
      commit: r.build_commit ?? null, scope: r.target_type ?? null, targetId: r.target_id == null ? null : Number(r.target_id),
      attempts: json<DiagJobAttempt[]>(r.attempts_log, []).map((a) => ({ ...a, worker: String(a.worker).split(':').slice(0, 2).join(':') })),
    })),
    legacyRunning: Number(legacyRunning[0]?.n ?? 0),
  };
}
