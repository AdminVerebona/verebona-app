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
  DIAG_JOB_ERROR_LABELS, DIAG_JOB_MODE, DiagJobError, diagJobSettings, isGlobalRequest, laneCapacity, requestKey, retryDelaySeconds, sanitizeErrorMessage,
  type DiagJobAttempt, type DiagLane, type DiagJobErrorCode, type DiagJobPhase, type DiagJobProgress, type DiagJobStatus,
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
  /** Lot 111C : motif d'annulation et demande remplaçante. */
  cancelReason: string | null;
  replacedBy: string | null;
  attemptsLog: DiagJobAttempt[];
  progress: DiagJobProgress | null;
  /** Lot 111Q : demande (started_at) et premier démarrage réel (migration 1280). */
  queuedAt?: string | null;
  firstRunStartedAt?: string | null;
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
    cancelReason: r.cancel_reason == null ? null : String(r.cancel_reason), replacedBy: r.replaced_by == null ? null : String(r.replaced_by),
    attemptsLog: json<DiagJobAttempt[]>(r.attempts_log, []),
    progress: json<DiagJobProgress | null>(r.progress, null),
    queuedAt: iso(r.started_at), firstRunStartedAt: iso(r.first_run_started_at),
  };
}

async function db() {
  return (await import('@/db')).pgClient;
}

// ── Mise en file (idempotente, remplacement des demandes globales) ─────────

export interface EnqueueInput {
  adminUserId: number;
  request: DiagJobRequest;
  idempotencyKey?: string | null;
  requestId?: string | null;
  parentId?: string | null;
}

/** Lot 111C : demande globale remplacée par la nouvelle demande. */
export interface ReplacedJob { id: string; previousStatus: 'QUEUED' | 'RUNNING'; outcome: 'CANCELLED' | 'CANCEL_REQUESTED'; phase: DiagJobPhase | null }

export interface EnqueueResult { job: DiagJobRow; duplicate: boolean; replaced: ReplacedJob[] }

/**
 * Enregistre une demande de diagnostic (QUEUED) et rend son identifiant, SANS
 * rien générer.
 *
 *   · REJEU (même `Idempotency-Key`, 24 h : double clic, requête réseau
 *     rejouée) → la demande existante, quel que soit le périmètre ;
 *   · diagnostic CIBLÉ (compte, utilisateur, bien, document, Opération) :
 *     demande identique encore en file / en cours → le travail existant ;
 *   · Lot 111C — diagnostic GLOBAL : toute nouvelle action explicite (nouvelle
 *     clé, ou aucune clé) REMPLACE les demandes globales encore actives, tous
 *     administrateurs confondus, même à paramètres identiques : QUEUED →
 *     CANCELLED immédiatement, RUNNING → annulation demandée (arrêt coopératif
 *     du worker, CANCELLED après arrêt effectif) ; motif stable
 *     REPLACED_BY_NEW_REQUEST, référence de la remplaçante, initiateur,
 *     horodatage, dernière étape. Les diagnostics ciblés ne sont jamais
 *     touchés ; l'historique terminé est conservé.
 *
 * Le tout dans UNE transaction sérialisée par un verrou consultatif : deux
 * demandes simultanées (deux administrateurs) ne laissent jamais deux
 * diagnostics globaux éligibles — la seconde remplace la première.
 */
export async function enqueueDiagnosticJob(input: EnqueueInput): Promise<EnqueueResult> {
  const sql = await db();
  const s = diagJobSettings();
  const key = requestKey(input.request);
  const global = isGlobalRequest(input.request);
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${QUEUE_LOCK}))`;
    if (input.idempotencyKey) {
      const [same] = await tx<Raw[]>`
        SELECT * FROM admin_export_generations
         WHERE kind = 'TECH_DIAGNOSTIC' AND mode = ${DIAG_JOB_MODE} AND idempotency_key = ${input.idempotencyKey}
           AND started_at > now() - interval '24 hours'
         ORDER BY started_at DESC LIMIT 1`;
      if (same) return { job: toJob(same), duplicate: true, replaced: [] };
    }
    if (!global) {
      const [active] = await tx<Raw[]>`
        SELECT * FROM admin_export_generations
         WHERE kind = 'TECH_DIAGNOSTIC' AND mode = ${DIAG_JOB_MODE} AND status IN ('QUEUED', 'RUNNING')
           AND perimeter->>'requestKey' = ${key} AND NOT cancel_requested
         ORDER BY started_at LIMIT 1`;
      if (active) return { job: toJob(active), duplicate: true, replaced: [] };
    }
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
    const replaced: ReplacedJob[] = [];
    if (global) {
      const label = `${DIAG_JOB_ERROR_LABELS.REPLACED_BY_NEW_REQUEST} Remplacée par la demande ${id} (administrateur #${input.adminUserId}).`;
      const queued = await tx<Raw[]>`
        UPDATE admin_export_generations
           SET status = 'CANCELLED', error_phase = phase, phase = 'TERMINE', finished_at = now(), error_code = 'REPLACED_BY_NEW_REQUEST', error_at = now(),
               error = ${label}, cancel_requested = true, cancel_reason = 'REPLACED_BY_NEW_REQUEST', replaced_by = ${id}::uuid,
               cancel_requested_at = now(), cancel_requested_by = ${input.adminUserId}, next_attempt_at = NULL
         WHERE kind = 'TECH_DIAGNOSTIC' AND mode = ${DIAG_JOB_MODE} AND status = 'QUEUED' AND id <> ${id}::uuid AND coalesce(perimeter->>'scope', target_type, 'global') = 'global'
         RETURNING id::text, error_phase`;
      for (const r of queued) replaced.push({ id: String(r.id), previousStatus: 'QUEUED', outcome: 'CANCELLED', phase: (r.error_phase ?? null) as DiagJobPhase | null });
      const running = await tx<Raw[]>`
        UPDATE admin_export_generations
           SET cancel_requested = true, cancel_reason = 'REPLACED_BY_NEW_REQUEST', replaced_by = ${id}::uuid,
               cancel_requested_at = coalesce(cancel_requested_at, now()), cancel_requested_by = ${input.adminUserId}
         WHERE kind = 'TECH_DIAGNOSTIC' AND mode = ${DIAG_JOB_MODE} AND status = 'RUNNING' AND coalesce(perimeter->>'scope', target_type, 'global') = 'global'
         RETURNING id::text, phase`;
      for (const r of running) replaced.push({ id: String(r.id), previousStatus: 'RUNNING', outcome: 'CANCEL_REQUESTED', phase: (r.phase ?? null) as DiagJobPhase | null });
      if (replaced.length) console.info(`[diagnostic-job] ${JSON.stringify({ event: 'replaced', jobId: id, adminUserId: input.adminUserId, replaced: replaced.map((x) => ({ id: x.id, from: x.previousStatus, outcome: x.outcome, phase: x.phase })) })}`);
    }
    return { job: toJob(row), duplicate: false, replaced };
  }) as Promise<EnqueueResult>;
}

/**
 * « Relancer » : nouveau travail (même demande) rattaché à `parentId`. Sans
 * double demande : un enfant déjà en file / en cours est rendu tel quel.
 * Refusé (null) si le parent est introuvable ou encore actif. Lot 111C : la
 * relance d'un diagnostic global est une nouvelle demande globale — elle
 * remplace les demandes globales actives.
 */
export async function retryDiagnosticJob(parentId: string, adminUserId: number, requestId: string | null): Promise<EnqueueResult | { refused: 'NOT_FOUND' | 'STILL_ACTIVE' }> {
  const sql = await db();
  const [parent] = await sql<Raw[]>`SELECT * FROM admin_export_generations WHERE id = ${parentId}::uuid AND kind = 'TECH_DIAGNOSTIC'`;
  if (!parent) return { refused: 'NOT_FOUND' };
  if (parent.status === 'QUEUED' || parent.status === 'RUNNING') return { refused: 'STILL_ACTIVE' };
  const [child] = await sql<Raw[]>`
    SELECT * FROM admin_export_generations WHERE parent_id = ${parentId}::uuid AND status IN ('QUEUED', 'RUNNING') AND NOT cancel_requested ORDER BY started_at LIMIT 1`;
  if (child) return { job: toJob(child), duplicate: true, replaced: [] };
  const p = json<Raw>(parent.perimeter, {});
  const request: DiagJobRequest = {
    scope: String(p.scope ?? parent.target_type ?? 'global'),
    id: p.id == null ? (parent.target_id == null ? null : Number(parent.target_id)) : Number(p.id),
    reinforced: p.reinforced === true,
  };
  // Relance d'une génération : clé d'idempotence dérivée du parent (deux clics → un seul enfant).
  return enqueueDiagnosticJob({ adminUserId, request, parentId, requestId, idempotencyKey: `retry:${parentId}` });
}

/**
 * Annulation par un administrateur : QUEUED → CANCELLED immédiat ; RUNNING →
 * annulation demandée (le worker la lit en quelques secondes, interrompt la
 * requête SQL et l'envoi en cours, supprime ses fichiers, puis CANCELLED).
 */
export async function cancelDiagnosticJob(id: string, adminUserId: number | null = null): Promise<'CANCELLED' | 'REQUESTED' | 'NOT_ACTIVE' | 'NOT_FOUND'> {
  const sql = await db();
  const [r] = await sql<Raw[]>`SELECT status FROM admin_export_generations WHERE id = ${id}::uuid AND kind = 'TECH_DIAGNOSTIC' AND mode = ${DIAG_JOB_MODE}`;
  if (!r) return 'NOT_FOUND';
  if (r.status === 'QUEUED') {
    const done = await sql`UPDATE admin_export_generations SET status = 'CANCELLED', error_phase = phase, phase = 'TERMINE', finished_at = now(), error_code = 'CANCELLED', error_at = now(),
             error = ${DIAG_JOB_ERROR_LABELS.CANCELLED}, cancel_requested = true, cancel_reason = 'ADMIN_CANCELLED', cancel_requested_at = now(), cancel_requested_by = ${adminUserId},
             next_attempt_at = NULL
             WHERE id = ${id}::uuid AND status = 'QUEUED' RETURNING id`;
    if (done.length) return 'CANCELLED';
  }
  const req = await sql`UPDATE admin_export_generations SET cancel_requested = true, cancel_reason = coalesce(cancel_reason, 'ADMIN_CANCELLED'),
             cancel_requested_at = coalesce(cancel_requested_at, now()), cancel_requested_by = coalesce(cancel_requested_by, ${adminUserId})
             WHERE id = ${id}::uuid AND status = 'RUNNING' RETURNING id`;
  return req.length ? 'REQUESTED' : 'NOT_ACTIVE';
}

/** Lot 111C : code d'erreur final d'une annulation (motif stable). */
function cancelCode(reason: unknown): DiagJobErrorCode {
  return reason === 'REPLACED_BY_NEW_REQUEST' ? 'REPLACED_BY_NEW_REQUEST' : 'CANCELLED';
}
function cancelMessage(reason: unknown, replacedBy: unknown): string {
  const code = cancelCode(reason);
  return `${DIAG_JOB_ERROR_LABELS[code]}${code === 'REPLACED_BY_NEW_REQUEST' && replacedBy ? ` Remplacée par la demande ${String(replacedBy)}.` : ''}`;
}

/**
 * Lot 111C : contrôle léger lu pendant la génération (toutes les
 * `DIAG_JOB_CANCEL_POLL_MS`) — le worker apprend une annulation sans
 * attendre le renouvellement du bail.
 */
export async function readDiagnosticControl(id: string, workerId: string): Promise<{ owned: boolean; cancelRequested: boolean; status: DiagJobStatus | null }> {
  const sql = await db();
  const [r] = await sql<Raw[]>`SELECT status, locked_by, cancel_requested FROM admin_export_generations WHERE id = ${id}::uuid`;
  return { owned: !!r && r.status === 'RUNNING' && r.locked_by === workerId, cancelRequested: r?.cancel_requested === true, status: r ? String(r.status) as DiagJobStatus : null };
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
export async function recoverDiagnosticJobs(now: Date = new Date()): Promise<{ requeued: string[]; failed: string[]; legacy: string[]; cancelled: string[] }> {
  const sql = await db();
  const nowIso = now.toISOString();
  const lost = await sql<Raw[]>`
    SELECT id, attempt, max_attempts, phase, progress, attempts_log, cancel_requested, cancel_reason, replaced_by FROM admin_export_generations
     WHERE kind = 'TECH_DIAGNOSTIC' AND mode = ${DIAG_JOB_MODE} AND status = 'RUNNING' AND locked_until IS NOT NULL AND locked_until < ${nowIso}::timestamptz`;
  const requeued: string[] = [];
  const failed: string[] = [];
  const cancelled: string[] = [];
  for (const r of lost) {
    const attempt = Number(r.attempt ?? 0);
    const max = Number(r.max_attempts ?? diagJobSettings().maxAttempts);
    const prog = json<DiagJobProgress | null>(r.progress, null);
    const log = json<DiagJobAttempt[]>(r.attempts_log, []);
    const last = log[log.length - 1];
    const lastProgress = prog ? { filesDone: prog.filesDone, filesPlanned: prog.filesPlanned, current: prog.current, rssMb: prog.rssMb, peakRssMb: prog.peakRssMb } : null;
    // Lot 111C : annulation demandée (remplacement ou administrateur) — un processus arrêté ne fait
    // jamais revivre une demande annulée : CANCELLED, jamais une nouvelle tentative.
    if (r.cancel_requested === true) {
      const code = cancelCode(r.cancel_reason);
      if (last && !last.endedAt) Object.assign(last, { endedAt: nowIso, outcome: 'CANCELLED', errorCode: code, phase: r.phase ?? null, lastProgress });
      const rows = await sql`UPDATE admin_export_generations SET status = 'CANCELLED', error_phase = phase, phase = 'TERMINE', finished_at = ${nowIso}::timestamptz,
                 error_code = ${code}, error_at = ${nowIso}::timestamptz, error = ${`${cancelMessage(r.cancel_reason, r.replaced_by)} Processus arrêté pendant l’arrêt coopératif (bail expiré).`},
                 locked_by = NULL, locked_until = NULL, attempts_log = ${JSON.stringify(log)}::jsonb
           WHERE id = ${String(r.id)}::uuid AND status = 'RUNNING' AND locked_until < ${nowIso}::timestamptz RETURNING id`;
      if (rows.length) cancelled.push(String(r.id));
      continue;
    }
    // Lot 111C : processus arrêté AVANT l'ouverture de l'instantané (étape PLANIFICATION, aucun
    // fichier) — la génération n'a jamais démarré : la tentative est rendue (bornée à max_attempts
    // restitutions, pour qu'un processus qui meurt toujours au démarrage finisse en FAILED explicite).
    const refunds = log.filter((x) => x.outcome === 'LOST_BEFORE_START').length;
    const notStarted = r.phase === 'PLANIFICATION' && !(prog?.filesDone) && !(prog?.filesPlanned) && attempt > 0 && refunds < max;
    const effective = notStarted ? attempt - 1 : attempt;
    const exhausted = effective >= max;
    const code: DiagJobErrorCode = exhausted ? 'WORKER_LOST_MAX_ATTEMPTS' : 'WORKER_LOST';
    if (last && !last.endedAt) Object.assign(last, {
      endedAt: nowIso, outcome: notStarted ? 'LOST_BEFORE_START' : 'LOST', errorCode: 'WORKER_LOST', phase: r.phase ?? null, lastProgress,
    });
    const msg = `${DIAG_JOB_ERROR_LABELS[code]} Dernier signe de vie : étape ${String(r.phase ?? '?')}${prog?.current ? `, fichier ${prog.current}` : ''}${prog?.rssMb ? `, mémoire ${prog.rssMb} Mo (pic ${prog.peakRssMb ?? '?'} Mo)` : ''} — tentative ${attempt}/${max}${notStarted ? ' (arrêt avant l’ouverture de l’instantané : tentative non décomptée)' : ''}.`;
    const rows = exhausted
      ? await sql`UPDATE admin_export_generations SET status = 'FAILED', finished_at = ${nowIso}::timestamptz, error_code = ${code}, error_phase = phase, error_at = ${nowIso}::timestamptz,
                 error = ${msg}, locked_by = NULL, locked_until = NULL, attempts_log = ${JSON.stringify(log)}::jsonb
           WHERE id = ${String(r.id)}::uuid AND status = 'RUNNING' AND locked_until < ${nowIso}::timestamptz RETURNING id`
      : await sql`UPDATE admin_export_generations SET status = 'QUEUED', attempt = ${effective},
                 next_attempt_at = ${notStarted ? nowIso : new Date(now.getTime() + retryDelaySeconds(attempt) * 1000).toISOString()}::timestamptz,
                 error_code = ${code}, error_phase = phase, error_at = ${nowIso}::timestamptz, error = ${msg}, phase = 'EN_FILE', locked_by = NULL, locked_until = NULL,
                 attempts_log = ${JSON.stringify(log)}::jsonb
           WHERE id = ${String(r.id)}::uuid AND status = 'RUNNING' AND locked_until < ${nowIso}::timestamptz RETURNING id`;
    if (!rows.length) continue;
    (exhausted ? failed : requeued).push(String(r.id));
    console.error(`[diagnostic-job] ${JSON.stringify({ event: 'orphan', jobId: String(r.id), code, attempt, max, notStarted, phase: r.phase ?? null, current: prog?.current ?? null, rssMb: prog?.rssMb ?? null })}`);
  }
  const legacy = await sql<Raw[]>`
    UPDATE admin_export_generations
       SET status = 'FAILED', finished_at = ${nowIso}::timestamptz, error_code = 'LEGACY_HTTP_INTERRUPTED', error_phase = 'GENERATION_HTTP', error_at = ${nowIso}::timestamptz,
           error = ${`${DIAG_JOB_ERROR_LABELS.LEGACY_HTTP_INTERRUPTED} Ligne close automatiquement par le lot 107G (aucune fin enregistrée).`}
     WHERE kind = 'TECH_DIAGNOSTIC' AND mode <> ${DIAG_JOB_MODE} AND status = 'RUNNING'
       AND coalesce(heartbeat_at, started_at) < ${new Date(now.getTime() - LEGACY_STALE_MS).toISOString()}::timestamptz
    RETURNING id`;
  const q = await sql<Raw[]>`UPDATE admin_export_generations SET status = 'CANCELLED', error_phase = phase, phase = 'TERMINE', finished_at = ${nowIso}::timestamptz,
             error_code = CASE WHEN cancel_reason = 'REPLACED_BY_NEW_REQUEST' THEN 'REPLACED_BY_NEW_REQUEST' ELSE 'CANCELLED' END,
             error = CASE WHEN cancel_reason = 'REPLACED_BY_NEW_REQUEST' THEN ${DIAG_JOB_ERROR_LABELS.REPLACED_BY_NEW_REQUEST} || coalesce(' Remplacée par la demande ' || replaced_by::text || '.', '')
                          ELSE ${DIAG_JOB_ERROR_LABELS.CANCELLED} END
             WHERE kind = 'TECH_DIAGNOSTIC' AND mode = ${DIAG_JOB_MODE} AND status = 'QUEUED' AND cancel_requested RETURNING id`;
  cancelled.push(...q.map((x) => String(x.id)));
  return { requeued, failed, legacy: legacy.map((r) => String(r.id)), cancelled };
}

// ── Prise et bail ───────────────────────────────────────────────────────────

/** Lot 111C : pourquoi la prise n'a rien rendu (raison d'attente vue par le worker). Lot 111Q : TARGETED_SLOT_BUSY (voie ciblée pleine). */
export type DiagClaimBlock = 'GLOBAL_SLOT_BUSY' | 'GLOBAL_DIAGNOSTIC_STOPPING' | 'TARGETED_SLOT_BUSY' | 'NO_ELIGIBLE_JOB';

/**
 * Prend le prochain diagnostic à faire (QUEUED, échéance passée), dans la
 * limite de la concurrence GLOBALE (toutes instances) — verrou consultatif :
 * deux instances ne prennent jamais deux travaux au-delà de la borne.
 */
export async function claimNextDiagnosticJob(workerId: string, commit: string | null, opts: { onlyId?: string; now?: Date; lane?: DiagLane } = {}): Promise<DiagJobRow | null> {
  return (await claimNextDiagnosticJobDetailed(workerId, commit, opts)).job;
}

/** Lot 111Q : expression SQL « demande globale » (même règle que `isGlobalRequest`). */
const IS_GLOBAL_SQL = (alias: string) => `coalesce(${alias}.perimeter->>'scope', ${alias}.target_type, 'global') = 'global'`;

/**
 * Lot 111C — prise avec raison d'attente. En plus de la borne globale :
 *   · un diagnostic GLOBAL ne démarre jamais tant qu'un autre diagnostic
 *     global tient un bail vivant (en particulier l'ancien, en cours d'arrêt
 *     après remplacement) — quelle que soit DIAG_JOB_GLOBAL_CONCURRENCY ;
 *   · seul le diagnostic global le PLUS RÉCENT est éligible (garde
 *     défensive : le remplacement en base l'assure déjà).
 */
export async function claimNextDiagnosticJobDetailed(workerId: string, commit: string | null, opts: { onlyId?: string; now?: Date; lane?: DiagLane } = {}): Promise<{ job: DiagJobRow | null; blocked: DiagClaimBlock | null }> {
  const sql = await db();
  const s = diagJobSettings();
  const lane: DiagLane = opts.lane ?? 'main';
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${QUEUE_LOCK}))`;
    const running = await tx<Raw[]>`
      SELECT id, cancel_requested, coalesce(perimeter->>'scope', target_type, 'global') = 'global' AS is_global FROM admin_export_generations
       WHERE kind = 'TECH_DIAGNOSTIC' AND mode = ${DIAG_JOB_MODE} AND status = 'RUNNING' AND locked_until > now()`;
    const globalRunning = running.some((r) => r.is_global === true);
    const stopping = running.some((r) => r.cancel_requested === true && r.is_global === true);
    // Lot 111Q : voie commune (DIAG_JOB_GLOBAL_CONCURRENCY) + places réservées aux ciblés
    // (DIAG_JOB_TARGETED_CONCURRENCY). Un global en cours, annulé, en cours d'arrêt ou orphelin
    // à bail vivant n'occupe JAMAIS les places réservées : un ciblé n'attend pas sa fin.
    const cap = laneCapacity({ total: running.length, global: running.filter((r) => r.is_global === true).length }, s);
    const globalOk = lane === 'main' && cap.globalAllowed;
    const targetedOk = cap.targetedAllowed;
    const busy = (): DiagClaimBlock => (lane === 'targeted' ? 'TARGETED_SLOT_BUSY' : stopping ? 'GLOBAL_DIAGNOSTIC_STOPPING' : 'GLOBAL_SLOT_BUSY');
    if (!globalOk && !targetedOk) return { job: null, blocked: busy() };
    const only = opts.onlyId ? tx`AND t.id = ${opts.onlyId}::uuid` : tx``;
    // Ordre : CIBLÉS d'abord (courts, demandés pour une analyse immédiate), puis le global le plus
    // récent (seul éligible, garde défensive du lot 111C) ; à priorité égale, ordre d'arrivée.
    const [pick] = await tx<Raw[]>`
      SELECT * FROM admin_export_generations t
       WHERE t.kind = 'TECH_DIAGNOSTIC' AND t.mode = ${DIAG_JOB_MODE} AND t.status = 'QUEUED' AND NOT t.cancel_requested
         AND (t.next_attempt_at IS NULL OR t.next_attempt_at <= now())
         AND (
           (NOT ${tx.unsafe(IS_GLOBAL_SQL('t'))} AND ${targetedOk}::boolean)
           OR (${tx.unsafe(IS_GLOBAL_SQL('t'))} AND ${globalOk}::boolean AND NOT EXISTS (
               SELECT 1 FROM admin_export_generations n
                WHERE n.kind = 'TECH_DIAGNOSTIC' AND n.mode = ${DIAG_JOB_MODE} AND n.status IN ('QUEUED', 'RUNNING') AND NOT n.cancel_requested
                  AND ${tx.unsafe(IS_GLOBAL_SQL('n'))} AND n.started_at > t.started_at))
         )
         ${only}
       ORDER BY (${tx.unsafe(IS_GLOBAL_SQL('t'))}) ASC, t.started_at, t.id LIMIT 1 FOR UPDATE SKIP LOCKED`;
    if (!pick) {
      // Rien de pris : file vide (pour cette voie), ou demandes retenues par la capacité.
      const [waiting] = await tx<Raw[]>`
        SELECT count(*)::int AS n FROM admin_export_generations t
         WHERE t.kind = 'TECH_DIAGNOSTIC' AND t.mode = ${DIAG_JOB_MODE} AND t.status = 'QUEUED' AND NOT t.cancel_requested
           AND (t.next_attempt_at IS NULL OR t.next_attempt_at <= now())
           ${lane === 'targeted' ? tx`AND NOT ${tx.unsafe(IS_GLOBAL_SQL('t'))}` : tx``}
           ${only}`;
      return { job: null, blocked: Number(waiting?.n ?? 0) > 0 && running.length > 0 ? busy() : 'NO_ELIGIBLE_JOB' };
    }
    const log = json<DiagJobAttempt[]>(pick.attempts_log, []);
    const attempt = Number(pick.attempt ?? 0) + 1;
    log.push({ attempt, worker: workerId, commit, startedAt: new Date().toISOString(), endedAt: null, outcome: null, errorCode: null, phase: 'PLANIFICATION' });
    const [row] = await tx<Raw[]>`
      UPDATE admin_export_generations
         SET status = 'RUNNING', phase = 'PLANIFICATION', attempt = ${attempt}, locked_by = ${workerId},
             locked_until = now() + make_interval(secs => ${s.leaseSeconds}), heartbeat_at = now(), run_started_at = now(),
             first_run_started_at = coalesce(first_run_started_at, now()), lane = ${lane}, phase_timings = NULL,
             next_attempt_at = NULL, build_commit = ${commit}, attempts_log = ${JSON.stringify(log)}::jsonb, finished_at = NULL,
             wait_reason = NULL, wait_reason_at = NULL
       WHERE id = ${String(pick.id)}::uuid RETURNING *`;
    return { job: toJob(row), blocked: null };
  }) as Promise<{ job: DiagJobRow | null; blocked: DiagClaimBlock | null }>;
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

/**
 * Étape atteinte (point de reprise journalisé) ; lève `DiagLeaseLostError` si
 * le bail n'est plus à nous, `DiagJobError('CANCELLED')` si une annulation
 * est demandée (lot 111C : arrêt coopératif sans attendre le bail).
 */
export async function setDiagnosticPhase(id: string, workerId: string, phase: DiagJobPhase, progress?: DiagJobProgress | null, timings?: unknown): Promise<void> {
  const sql = await db();
  // Lot 111Q : profilage de la tentative (durées par étape) écrit à chaque changement d'étape.
  const rows = await sql<Raw[]>`
    UPDATE admin_export_generations SET phase = ${phase}, heartbeat_at = now(),
           progress = COALESCE(${progress ? JSON.stringify(progress) : null}::jsonb, progress),
           phase_timings = COALESCE(${timings ? JSON.stringify(timings) : null}::jsonb, phase_timings)
     WHERE id = ${id}::uuid AND locked_by = ${workerId} AND status = 'RUNNING' RETURNING cancel_requested`;
  if (!rows.length) throw new DiagLeaseLostError();
  if (rows[0].cancel_requested === true) throw new DiagJobError('CANCELLED', 'annulation demandée');
}

/** Lot 111Q : profilage final de la tentative (best effort, exige le bail ; jamais bloquant). */
export async function saveDiagnosticTimings(id: string, workerId: string, timings: unknown): Promise<void> {
  try {
    const sql = await db();
    await sql`UPDATE admin_export_generations SET phase_timings = ${JSON.stringify(timings)}::jsonb
               WHERE id = ${id}::uuid AND locked_by = ${workerId} AND status = 'RUNNING'`;
  } catch (e) {
    console.error('[diagnostic-job] profilage non enregistré :', sanitizeErrorMessage(e));
  }
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
  /** Lot 113Q : archive ZIP définitive (stockée, vérifiée) ; null : aucune (jamais publié sans, hors tests anciens). */
  archive?: { key: string; bytes: number; sha256: string; entries: number; zip64: boolean; verifiedAt: string } | null;
}

function closeAttempt(log: DiagJobAttempt[], outcome: DiagJobAttempt['outcome'], code: DiagJobErrorCode | null, phase: DiagJobPhase | null, p: DiagJobProgress | null): DiagJobAttempt[] {
  const last = log[log.length - 1];
  if (last && !last.endedAt) Object.assign(last, {
    endedAt: new Date().toISOString(), outcome, errorCode: code, phase,
    lastProgress: p ? { filesDone: p.filesDone, filesPlanned: p.filesPlanned, current: p.current, rssMb: p.rssMb, peakRssMb: p.peakRssMb } : null,
  });
  return log;
}

/**
 * Publication (après validation) : COMPLETE / PARTIAL. Lot 111C : vérification
 * ATOMIQUE (une seule instruction) de la propriété du bail, du statut RUNNING
 * et de l'ABSENCE d'annulation — une ancienne exécution (remplacée, annulée,
 * reprise ailleurs) ne publie jamais. Annulation constatée → `DiagJobError`
 * CANCELLED (le runner nettoie et écrit CANCELLED) ; bail perdu →
 * `DiagLeaseLostError`.
 */
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
           expires_at = now() + make_interval(days => ${s.retentionDays}),
           archive_key = ${o.archive?.key ?? null}, archive_bytes = ${o.archive?.bytes ?? null}, archive_sha256 = ${o.archive?.sha256 ?? null},
           archive_entries = ${o.archive?.entries ?? null}, archive_zip64 = ${o.archive?.zip64 ?? null}, archive_verified_at = ${o.archive?.verifiedAt ?? null}::timestamptz
     WHERE id = ${job.id}::uuid AND locked_by = ${workerId} AND status = 'RUNNING' AND NOT cancel_requested RETURNING id`;
  if (rows.length) return;
  const control = await readDiagnosticControl(job.id, workerId);
  if (control.owned && control.cancelRequested) throw new DiagJobError('CANCELLED', 'annulation demandée avant la publication : résultat non publié');
  throw new DiagLeaseLostError();
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
  const [cur] = await sql<Raw[]>`SELECT attempt, max_attempts, attempts_log, cancel_requested, cancel_reason, replaced_by FROM admin_export_generations WHERE id = ${job.id}::uuid`;
  const attempt = Number(cur?.attempt ?? job.attempt);
  const max = Number(cur?.max_attempts ?? job.maxAttempts);
  // Lot 111C : une annulation demandée l'emporte sur toute autre erreur (requête SQL interrompue,
  // envoi coupé…) — jamais de nouvelle tentative pour une demande annulée ou remplacée.
  const cancelled = f.cancelled === true || cur?.cancel_requested === true;
  const code: DiagJobErrorCode = cancelled ? cancelCode(cur?.cancel_reason) : f.code;
  const retry = !cancelled && f.transient && attempt < max;
  const status: DiagJobStatus = cancelled ? 'CANCELLED' : retry ? 'QUEUED' : 'FAILED';
  const log = closeAttempt(json<DiagJobAttempt[]>(cur?.attempts_log, []), retry ? 'RETRY' : status, code, f.phase, f.progress);
  const msg = cancelled
    ? sanitizeErrorMessage(`${cancelMessage(cur?.cancel_reason, cur?.replaced_by)} Arrêt effectif à l’étape ${f.phase ?? '?'} ; fichiers de la tentative supprimés — tentative ${attempt}/${max}.`)
    : sanitizeErrorMessage(`${DIAG_JOB_ERROR_LABELS[code]} ${f.message ? `Détail : ${f.message}` : ''}${retry ? ` — nouvelle tentative programmée (${attempt}/${max}).` : ` — tentative ${attempt}/${max}.`}`);
  const rows = await sql`
    UPDATE admin_export_generations
       SET status = ${status}, error_code = ${code}, error_phase = ${f.phase}, error_at = now(), error = ${msg},
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
  const [cols] = await sql<Raw[]>`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'admin_export_generations' AND column_name IN ('phase', 'locked_until', 'attempts_log', 'cancel_reason', 'first_run_started_at')`;
  // Lot 111C : la migration 1200 (motif d'annulation, remplacement) est requise en plus de la 1035 ; lot 111Q : la 1280.
  if (Number(cols?.n ?? 0) < 5) return { migrationApplied: false };
  const byStatus = await sql<Raw[]>`
    SELECT status, count(*)::int AS n FROM admin_export_generations WHERE kind = 'TECH_DIAGNOSTIC' AND mode = ${DIAG_JOB_MODE} GROUP BY status`;
  const [oldest] = await sql<Raw[]>`
    SELECT min(started_at) AS at FROM admin_export_generations WHERE kind = 'TECH_DIAGNOSTIC' AND mode = ${DIAG_JOB_MODE} AND status = 'QUEUED'
       AND (next_attempt_at IS NULL OR next_attempt_at <= now())`;
  const running = await sql<Raw[]>`
    SELECT id::text, phase, attempt, max_attempts, locked_by, locked_until, heartbeat_at, progress, run_started_at, cancel_requested, cancel_reason, replaced_by::text AS replaced_by,
           coalesce(perimeter->>'scope', target_type, 'global') AS scope, lane
      FROM admin_export_generations WHERE kind = 'TECH_DIAGNOSTIC' AND mode = ${DIAG_JOB_MODE} AND status = 'RUNNING' ORDER BY run_started_at`;
  const failures = await sql<Raw[]>`
    SELECT id::text, status, error_code, error_phase, error_at, error, attempt, max_attempts, build_commit, attempts_log, target_type, target_id
      FROM admin_export_generations
     WHERE kind = 'TECH_DIAGNOSTIC' AND error_code IS NOT NULL AND error_code NOT IN ('CANCELLED', 'REPLACED_BY_NEW_REQUEST')
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
        scope: String(r.scope ?? 'global'), cancelRequested: r.cancel_requested === true,
        cancelReason: r.cancel_reason == null ? null : String(r.cancel_reason), replacedBy: r.replaced_by == null ? null : String(r.replaced_by),
        lane: r.lane == null ? null : String(r.lane),
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

/**
 * Lot 111Q — champs de la migration 1280 d'un travail (premier démarrage réel,
 * voie, profilage) ; valeurs nulles si la migration n'est pas appliquée.
 */
export async function readDiagnosticJobExtras(id: string): Promise<{ firstRunStartedAt: string | null; lane: string | null; phaseTimings: unknown | null; archive: DiagArchiveRow | null }> {
  const sql = await db();
  try {
    const [r] = await sql<Raw[]>`SELECT first_run_started_at, lane, phase_timings FROM admin_export_generations WHERE id = ${id}::uuid`;
    return { firstRunStartedAt: iso(r?.first_run_started_at), lane: r?.lane == null ? null : String(r.lane), phaseTimings: json<unknown | null>(r?.phase_timings, null), archive: await readDiagnosticArchive(id) };
  } catch (e) {
    if ((e as { code?: string })?.code === '42703') return { firstRunStartedAt: null, lane: null, phaseTimings: null, archive: null };
    throw e;
  }
}

/** Lot 113Q : archive ZIP définitive d'un travail publié (migration 1530). */
export interface DiagArchiveRow { key: string; bytes: number; sha256: string | null; entries: number | null; zip64: boolean; verifiedAt: string | null }

/** Lot 113Q : archive définitive stockée ; null si aucune (publication antérieure au lot 113Q, migration absente). */
export async function readDiagnosticArchive(id: string): Promise<DiagArchiveRow | null> {
  const sql = await db();
  try {
    const [r] = await sql<Raw[]>`SELECT archive_key, archive_bytes, archive_sha256, archive_entries, archive_zip64, archive_verified_at FROM admin_export_generations WHERE id = ${id}::uuid`;
    if (!r?.archive_key) return null;
    return {
      key: String(r.archive_key), bytes: Number(r.archive_bytes ?? 0), sha256: r.archive_sha256 == null ? null : String(r.archive_sha256),
      entries: r.archive_entries == null ? null : Number(r.archive_entries), zip64: r.archive_zip64 === true, verifiedAt: iso(r.archive_verified_at),
    };
  } catch (e) {
    if ((e as { code?: string })?.code === '42703') return null;
    throw e;
  }
}
