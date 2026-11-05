/**
 * Lot 81C — suivi des générations d'export du back-office
 * (`admin_export_generations`, migration 0632). Serveur uniquement.
 *
 * Journal TECHNIQUE (comme `admin_audit_log`) : une ligne RUNNING à
 * l'ouverture d'une génération, mise à jour à sa fin (COMPLETE / PARTIAL /
 * FAILED, bilan par section, erreur exploitable). Les écritures se font sur
 * une connexion du pool DISTINCTE de la session de lecture (READ ONLY) de
 * l'export ; un échec d'écriture du suivi n'interrompt jamais l'export
 * (journalisé). Une génération restée RUNNING au-delà de
 * `STALE_RUNNING_MS` (processus arrêté) est rendue FAILED à la lecture.
 *
 * Aussi : bornes de générations SIMULTANÉES par instance (protection de la
 * mémoire du conteneur et du pool : pagination technique, pas un plafond
 * de données).
 */
import type { ExtractionStatus } from '@/services/admin/account-data/model';

/** Lot 82E : une génération précise (export de recette : détail, téléchargement). */
export async function getGeneration(id: string): Promise<GenerationRow | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  return (await listGenerations({ id, pageSize: 1 })).items[0] ?? null;
}

/** Lot 84D : `AI_EXECUTIONS_EXPORT` — export des exécutions IA (BO › Exécutions & logs), reprenable. */
type ExportKind = 'ACCOUNT_DATA' | 'TECH_DIAGNOSTIC' | 'RECETTE_EXPORT' | 'AI_EXECUTIONS_EXPORT';
export const EXPORT_KINDS: readonly ExportKind[] = ['ACCOUNT_DATA', 'TECH_DIAGNOSTIC', 'RECETTE_EXPORT', 'AI_EXECUTIONS_EXPORT'];

/** Générations simultanées par instance (au-delà : 429, réessayer). Lot 82E : un seul export de recette ; lot 84D : un seul export d'exécutions IA. */
const MAX_CONCURRENT: Readonly<Record<ExportKind, number>> = { ACCOUNT_DATA: 3, TECH_DIAGNOSTIC: 2, RECETTE_EXPORT: 1, AI_EXECUTIONS_EXPORT: 1 };
const running: Record<ExportKind, number> = { ACCOUNT_DATA: 0, TECH_DIAGNOSTIC: 0, RECETTE_EXPORT: 0, AI_EXECUTIONS_EXPORT: 0 };

/** Réserve une place de génération ; `release` à appeler une fois (idempotent). */
export function tryAcquireExportSlot(kind: ExportKind): { release: () => void } | null {
  if (running[kind] >= MAX_CONCURRENT[kind]) return null;
  running[kind]++;
  let done = false;
  return { release: () => { if (!done) { done = true; running[kind]--; } } };
}

/** Au-delà, une génération encore RUNNING est considérée interrompue (processus arrêté). */
const STALE_RUNNING_MS = 2 * 60 * 60_000;
/**
 * Lot 82E — génération en tâche de fond (export de recette) : interrompue si
 * son dernier signe de vie (`heartbeat_at`, écrit au moins toutes les 30 s)
 * date de plus de 10 minutes — quelle que soit sa durée totale.
 */
const STALE_HEARTBEAT_MS = 10 * 60_000;

/** Interrompue (processus arrêté) ? Pure. */
export function isInterrupted(r: { status: string; startedAt: string; heartbeatAt?: string | null }, now: number): boolean {
  if (r.status !== 'RUNNING') return false;
  if (r.heartbeatAt) return now - Date.parse(r.heartbeatAt) > STALE_HEARTBEAT_MS;
  return now - Date.parse(r.startedAt) > STALE_RUNNING_MS;
}

interface GenerationStart {
  id: string;
  kind: ExportKind;
  mode: string;
  adminUserId: number | null;
  targetType: string | null;
  targetId: number | null;
  targetAccountId: number | null;
  perimeter: Record<string, unknown>;
  /** Lot 82E : préfixe de stockage des fichiers (génération stockée). */
  storagePrefix?: string | null;
}

interface GenerationEnd {
  status: ExtractionStatus;
  snapshotAt?: string | null;
  pgSnapshot?: string | null;
  rowsExpected?: number | null;
  rowsExported?: number | null;
  batches?: number | null;
  bytes?: number | null;
  files?: number | null;
  sections?: unknown[];
  error?: string | null;
  fileName?: string | null;
}

export async function startGeneration(g: GenerationStart): Promise<void> {
  try {
    const { pgClient } = await import('@/db');
    await pgClient.unsafe(
      g.storagePrefix
        ? `INSERT INTO admin_export_generations (id, kind, mode, admin_user_id, target_type, target_id, target_account_id, perimeter, storage_prefix, heartbeat_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, now()) ON CONFLICT (id) DO NOTHING`
        : `INSERT INTO admin_export_generations (id, kind, mode, admin_user_id, target_type, target_id, target_account_id, perimeter)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) ON CONFLICT (id) DO NOTHING`,
      [g.id, g.kind, g.mode, g.adminUserId, g.targetType, g.targetId, g.targetAccountId, JSON.stringify(g.perimeter), ...(g.storagePrefix ? [g.storagePrefix] : [])] as never[],
    );
  } catch (e) {
    console.error('[admin/export-generations] début non journalisé :', (e as Error)?.message ?? e);
  }
}

export async function finishGeneration(id: string, e: GenerationEnd): Promise<void> {
  try {
    const { pgClient } = await import('@/db');
    await pgClient.unsafe(
      `UPDATE admin_export_generations
          SET status = $2, snapshot_at = $3::timestamptz, pg_snapshot = $4, rows_expected = $5, rows_exported = $6, batches = $7, bytes = $8,
              files = $9, sections = $10::jsonb, error = $11, file_name = $12, finished_at = now()
        WHERE id = $1`,
      [id, e.status, e.snapshotAt ?? null, e.pgSnapshot ?? null, e.rowsExpected ?? null, e.rowsExported ?? null, e.batches ?? null, e.bytes ?? null,
        e.files ?? null, JSON.stringify(e.sections ?? []), e.error ? e.error.slice(0, 4000) : null, e.fileName ?? null] as never[],
    );
  } catch (err) {
    console.error('[admin/export-generations] fin non journalisée :', (err as Error)?.message ?? err);
  }
}

/** Lot 82E — signe de vie et progression d'une génération en tâche de fond (jamais bloquant). */
export async function heartbeatGeneration(id: string, p: { rowsExported?: number; files?: number; bytes?: number } = {}): Promise<void> {
  try {
    const { pgClient } = await import('@/db');
    await pgClient.unsafe(
      `UPDATE admin_export_generations SET heartbeat_at = now(), rows_exported = COALESCE($2, rows_exported), files = COALESCE($3, files), bytes = COALESCE($4, bytes)
        WHERE id = $1 AND status = 'RUNNING'`,
      [id, p.rowsExported ?? null, p.files ?? null, p.bytes ?? null] as never[],
    );
  } catch (e) {
    console.error('[admin/export-generations] signe de vie non écrit :', (e as Error)?.message ?? e);
  }
}

/**
 * Lot 84D — point de reprise d'une génération longue (`resume_state`,
 * migration 0692), écrit à chaque étape close (jamais bloquant).
 */
export async function saveResumeState(id: string, state: unknown, p: { rowsExported?: number; files?: number; bytes?: number } = {}): Promise<void> {
  try {
    const { pgClient } = await import('@/db');
    await pgClient.unsafe(
      `UPDATE admin_export_generations SET resume_state = $2::jsonb, heartbeat_at = now(),
              rows_exported = COALESCE($3, rows_exported), files = COALESCE($4, files), bytes = COALESCE($5, bytes)
        WHERE id = $1`,
      [id, JSON.stringify(state), p.rowsExported ?? null, p.files ?? null, p.bytes ?? null] as never[],
    );
  } catch (e) {
    console.error('[admin/export-generations] point de reprise non écrit :', (e as Error)?.message ?? e);
  }
}

/** Lot 84D — point de reprise d'une génération (null : aucun, ou migration 0692 absente). */
export async function readResumeState<T>(id: string): Promise<T | null> {
  try {
    const { pgClient } = await import('@/db');
    const [r] = (await pgClient.unsafe(`SELECT resume_state FROM admin_export_generations WHERE id = $1`, [id] as never[])) as unknown as Array<{ resume_state: unknown }>;
    const v = r?.resume_state;
    return (typeof v === 'string' ? JSON.parse(v) : v ?? null) as T | null;
  } catch {
    return null;
  }
}

/**
 * Lot 84D — reprise d'une génération interrompue ou en échec : de nouveau
 * RUNNING (signe de vie immédiat), fin et erreur effacées. Rend false si la
 * génération est déjà en cours (non interrompue) ou arrivée à son terme
 * (`resume_state.done`, quel que soit son statut).
 */
export async function reopenGeneration(id: string, now: Date = new Date()): Promise<boolean> {
  const { pgClient } = await import('@/db');
  const stale = new Date(now.getTime() - STALE_HEARTBEAT_MS).toISOString();
  const rows = (await pgClient.unsafe(
    `UPDATE admin_export_generations SET status = 'RUNNING', heartbeat_at = now(), finished_at = NULL, error = NULL
      WHERE id = $1 AND resume_state IS NOT NULL AND (resume_state->>'done') IS DISTINCT FROM 'true'
        AND (status IN ('FAILED', 'PARTIAL') OR (status = 'RUNNING' AND COALESCE(heartbeat_at, started_at) < $2::timestamptz))
      RETURNING id`,
    [id, stale] as never[],
  )) as unknown as unknown[];
  return rows.length === 1;
}

export interface GenerationRow {
  id: string;
  kind: ExportKind;
  mode: string;
  adminUserId: number | null;
  targetType: string | null;
  targetId: number | null;
  targetAccountId: number | null;
  perimeter: Record<string, unknown>;
  /** Lot 107G : QUEUED / CANCELLED (diagnostics durables) s'ajoutent. */
  status: ExtractionStatus | 'RUNNING' | 'QUEUED' | 'CANCELLED';
  /** RUNNING depuis plus de `STALE_RUNNING_MS` : interrompue (processus arrêté), jamais complète. */
  interrupted: boolean;
  snapshotAt: string | null;
  rowsExpected: number | null;
  rowsExported: number | null;
  batches: number | null;
  bytes: number | null;
  files: number | null;
  /**
   * Bilan par section ou fichier — LOURD (un élément par fichier d'un
   * diagnostic global) : rendu seulement pour UNE génération (`id`), jamais
   * dans la liste (lot 107G : cause du 502 de « Générations d'export »).
   */
  sections: unknown[];
  error: string | null;
  fileName: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** Lot 82E : génération stockée (préfixe) et dernier signe de vie. */
  storagePrefix: string | null;
  heartbeatAt: string | null;
  /** Lot 107G — diagnostics durables (null / défauts pour les autres générations ou sans migration 1035). */
  phase: string | null;
  progress: Record<string, unknown> | null;
  attempt: number;
  maxAttempts: number | null;
  errorCode: string | null;
  errorPhase: string | null;
  errorAt: string | null;
  parentId: string | null;
  requestId: string | null;
  buildCommit: string | null;
  cancelRequested: boolean;
  runStartedAt: string | null;
  nextAttemptAt: string | null;
  expiresAt: string | null;
  purgedAt: string | null;
  lockedUntil: string | null;
  /** Bail expiré d'un travail RUNNING (processus arrêté) : repris ou close au prochain tour du worker. */
  leaseExpired: boolean;
  /** Worker (instance:processus), sans suffixe aléatoire. */
  worker: string | null;
  /** Historique des tentatives (détail d'UNE génération seulement). */
  attemptsLog: unknown[];
  /** Lot 111C (migration 1200) : motif d'annulation, demande remplaçante, raison d'attente persistée. */
  cancelReason: string | null;
  replacedBy: string | null;
  cancelRequestedAt: string | null;
  waitReason: string | null;
  waitReasonAt: string | null;
  stallAlertedAt: string | null;
}

const LIGHT_COLUMNS = `id::text, kind, mode, admin_user_id, target_type, target_id, target_account_id, perimeter, status, snapshot_at, rows_expected, rows_exported,
              batches, bytes, files, left(error, 1000) AS error, file_name, started_at, finished_at, storage_prefix, heartbeat_at`;
const JOB_COLUMNS = `, phase, progress, attempt, max_attempts, error_code, error_phase, error_at, parent_id::text AS parent_id, request_id, build_commit,
              cancel_requested, run_started_at, next_attempt_at, expires_at, purged_at, locked_until, locked_by`;
/** Lot 111C (migration 1200) : remplacement et raison d'attente. */
const REPLACE_COLUMNS = `, cancel_reason, replaced_by::text AS replaced_by, cancel_requested_at, wait_reason, wait_reason_at, stall_alerted_at`;

/**
 * Générations récentes (pagination technique : `pageSize` ≤ 100, toutes les pages accessibles).
 *
 * Lot 107G : liste LÉGÈRE — colonnes scalaires seulement (jamais `sections`,
 * `resume_state` ni `attempts_log`, qui peuvent peser des mégaoctets par
 * ligne pour un diagnostic global), erreur coupée à 1 000 caractères, aucun
 * calcul à la volée. `id` : une seule génération, détail complet.
 */
export async function listGenerations(opts: { page?: number; pageSize?: number; kind?: ExportKind | null; now?: Date; id?: string | null; status?: string | null } = {}): Promise<{ items: GenerationRow[]; total: number; page: number; pageSize: number }> {
  const { readOnlyExecutor } = await import('@/services/business-operations/diagnostics/service');
  const pageSize = Math.min(100, Math.max(1, Math.floor(opts.pageSize ?? 20)));
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const now = (opts.now ?? new Date()).getTime();
  const detail = !!opts.id;
  return readOnlyExecutor(async (q) => {
    const where = `($1::text IS NULL OR kind = $1) AND ($2::uuid IS NULL OR id = $2::uuid) AND ($3::text IS NULL OR status = $3)`;
    const params = [opts.kind ?? null, opts.id ?? null, opts.status ?? null];
    const [c] = await q(`SELECT count(*)::int AS n FROM admin_export_generations WHERE ${where}`, params);
    const select = (job: boolean, l111c = false) => q(
      `SELECT ${LIGHT_COLUMNS}${job ? JOB_COLUMNS : ''}${job && l111c ? REPLACE_COLUMNS : ''}${detail ? `, sections${job ? ', attempts_log' : ''}` : ''}
         FROM admin_export_generations WHERE ${where}
        ORDER BY started_at DESC, id LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params);
    // Migration absente (déploiement partiel) : la liste reste lisible — sans les champs du lot 111C
    // (1200), puis sans ceux des travaux durables (1035).
    const attempt = async (job: boolean, l111c: boolean, fallback: () => Promise<Record<string, unknown>[]>) => {
      await q('SAVEPOINT vb_list');
      return select(job, l111c).then(async (r) => { await q('RELEASE SAVEPOINT vb_list'); return r; }, async (e) => {
        if ((e as { code?: string })?.code !== '42703') throw e;
        await q('ROLLBACK TO SAVEPOINT vb_list');
        return fallback();
      });
    };
    const rows = await attempt(true, true, () => attempt(true, false, () => select(false)));
    const iso = (v: unknown) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
    const n = (v: unknown) => (v == null ? null : Number(v));
    const obj = (v: unknown) => (v == null ? null : (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, unknown>);
    return {
      total: Number(c?.n ?? 0), page, pageSize,
      items: rows.map((r) => {
        const startedAt = iso(r.started_at)!;
        const heartbeatAt = iso(r.heartbeat_at);
        const isJob = r.mode === 'job';
        // Les travaux durables (107G) ont leur propre rattrapage persistant (bail) : jamais « interrompus » par calcul.
        const interrupted = !isJob && isInterrupted({ status: String(r.status), startedAt, heartbeatAt }, now);
        const lockedUntil = iso(r.locked_until);
        const legacyDiag = interrupted && r.kind === 'TECH_DIAGNOSTIC';
        const sections = detail && r.sections != null ? ((typeof r.sections === 'string' ? JSON.parse(r.sections) : r.sections) as unknown[]) : [];
        return {
          id: String(r.id), kind: r.kind as ExportKind, mode: String(r.mode), adminUserId: n(r.admin_user_id), targetType: r.target_type == null ? null : String(r.target_type),
          targetId: n(r.target_id), targetAccountId: n(r.target_account_id), perimeter: (obj(r.perimeter) ?? {}) as Record<string, unknown>,
          status: interrupted ? 'FAILED' : (String(r.status) as GenerationRow['status']), interrupted,
          snapshotAt: iso(r.snapshot_at), rowsExpected: n(r.rows_expected), rowsExported: n(r.rows_exported), batches: n(r.batches), bytes: n(r.bytes), files: n(r.files),
          sections: Array.isArray(sections) ? sections : [],
          error: interrupted
            ? (legacyDiag
              ? 'génération interrompue (processus arrêté avant la fin) — ancien moteur : diagnostic produit dans la requête HTTP du processus web, arrêté (redémarrage, déploiement ou mémoire) avant sa clôture ; relancer la génération (désormais durable)'
              : 'génération interrompue (processus arrêté avant la fin) — relancer la génération')
            : (r.error == null ? null : String(r.error)),
          fileName: r.file_name == null ? null : String(r.file_name), startedAt, finishedAt: iso(r.finished_at),
          storagePrefix: r.storage_prefix == null ? null : String(r.storage_prefix), heartbeatAt,
          phase: r.phase == null ? null : String(r.phase), progress: obj(r.progress), attempt: Number(r.attempt ?? 0), maxAttempts: n(r.max_attempts),
          errorCode: legacyDiag ? 'LEGACY_HTTP_INTERRUPTED' : (r.error_code == null ? null : String(r.error_code)),
          errorPhase: r.error_phase == null ? null : String(r.error_phase), errorAt: iso(r.error_at),
          parentId: r.parent_id == null ? null : String(r.parent_id), requestId: r.request_id == null ? null : String(r.request_id),
          buildCommit: r.build_commit == null ? null : String(r.build_commit), cancelRequested: r.cancel_requested === true,
          runStartedAt: iso(r.run_started_at), nextAttemptAt: iso(r.next_attempt_at), expiresAt: iso(r.expires_at), purgedAt: iso(r.purged_at), lockedUntil,
          leaseExpired: r.status === 'RUNNING' && !!lockedUntil && Date.parse(lockedUntil) < now,
          worker: r.locked_by == null ? null : String(r.locked_by).split(':').slice(0, 2).join(':'),
          attemptsLog: detail && r.attempts_log != null ? ((typeof r.attempts_log === 'string' ? JSON.parse(r.attempts_log) : r.attempts_log) as unknown[]) : [],
          cancelReason: r.cancel_reason == null ? null : String(r.cancel_reason), replacedBy: r.replaced_by == null ? null : String(r.replaced_by),
          cancelRequestedAt: iso(r.cancel_requested_at), waitReason: r.wait_reason == null ? null : String(r.wait_reason),
          waitReasonAt: iso(r.wait_reason_at), stallAlertedAt: iso(r.stall_alerted_at),
        };
      }),
    };
  });
}
