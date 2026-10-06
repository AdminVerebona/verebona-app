/**
 * État partagé des tâches planifiées internes — table `scheduled_task_state`
 * (migration 0252, lot 25).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA LIGNE EST À LA FOIS LE CALENDRIER ET LE VERROU
 *
 * Une tâche n'est exécutée que par l'instance qui a réussi la PRISE : un seul
 * `UPDATE … WHERE` (bail libre ET, pour un passage planifié, échéance
 * atteinte) qui pose un identifiant d'exécution et une fin de bail. Deux
 * conteneurs qui tentent la prise au même instant : PostgreSQL verrouille la
 * ligne, le second réévalue la condition après le premier et ne prend rien.
 * Même garantie pendant le recouvrement d'un déploiement (ancienne et
 * nouvelle version) que pour N instances stables.
 *
 * La fin d'exécution est CLÔTURÉE par l'identifiant : une instance dont le
 * bail a expiré (processus figé) et a été repris ne peut plus écrire l'état
 * d'une exécution qui ne lui appartient plus.
 *
 * Toutes les dates de prise et d'expiration sont celles du SERVEUR
 * PostgreSQL : les horloges des conteneurs n'arbitrent rien.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';

export type TaskTrigger = 'schedule' | 'manual' | 'startup';

export interface TaskStateRow {
  code: string;
  scheduleSignature: string | null;
  nextRunAt: Date | null;
  runningRunId: string | null;
  runningBy: string | null;
  runningUntil: Date | null;
  lastTrigger: TaskTrigger | null;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastDurationMs: number | null;
  lastStatus: 'ok' | 'error' | null;
  lastError: string | null;
  lastInstance: string | null;
  lastSuccessAt: Date | null;
  consecutiveFailures: number;
  createdAt: Date | null;
  /** Bail d'exécution en cours (selon l'horloge du serveur de base). */
  running: boolean;
}

export interface TaskRegistration {
  code: string;
  signature: string;
  /** Échéance posée si la ligne est créée ou si le calendrier a changé. */
  firstRunAt: Date;
  /** Tâche de démarrage : échéance ramenée au plus tard à cet instant. */
  bootRunAt?: Date | null;
}

export interface FinishRecord {
  status: 'ok' | 'error';
  error: string | null;
  durationMs: number;
  /** `'keep'` : échéance inchangée (exécution manuelle). */
  nextRunAt: Date | null | 'keep';
  /** Faux : le bail reste posé (délai dépassé, travail encore en cours). */
  release: boolean;
  /** Passage ignoré : dernier succès et échecs consécutifs inchangés. */
  skipped?: boolean;
}

/**
 * Accès à l'état. Interface injectable : les tests unitaires du moteur
 * utilisent une implémentation en mémoire, les tests e2e celle-ci.
 */
export interface TaskStateStore {
  ensure(rows: TaskRegistration[]): Promise<void>;
  /** Codes dont l'échéance est atteinte et le bail libre. */
  due(): Promise<Array<{ code: string; nextRunAt: Date }>>;
  claim(code: string, runId: string, owner: string, leaseMs: number, trigger: TaskTrigger, requireDue: boolean): Promise<boolean>;
  /** Saute un créneau périmé sans exécuter (échéance attendue = `expected`). */
  reschedule(code: string, expected: Date, next: Date | null): Promise<boolean>;
  finish(code: string, runId: string, rec: FinishRecord): Promise<{ consecutiveFailures: number } | null>;
  release(code: string, runId: string): Promise<void>;
  /**
   * Repousse la fin du bail à maintenant + `leaseMs` (renouvellement pendant
   * l'exécution, ou fin anticipée à l'arrêt du processus). Faux si
   * l'exécution n'est plus la détentrice.
   */
  renew(code: string, runId: string, leaseMs: number): Promise<boolean>;
  list(): Promise<TaskStateRow[]>;
}

const iso = (d: Date) => d.toISOString();
const date = (v: unknown): Date | null => (v === null || v === undefined ? null : new Date(v as string));

type RawRow = Record<string, unknown>;

function mapRow(r: RawRow): TaskStateRow {
  return {
    code: String(r.code),
    scheduleSignature: (r.schedule_signature as string | null) ?? null,
    nextRunAt: date(r.next_run_at),
    runningRunId: (r.running_run_id as string | null) ?? null,
    runningBy: (r.running_by as string | null) ?? null,
    runningUntil: date(r.running_until),
    lastTrigger: (r.last_trigger as TaskTrigger | null) ?? null,
    lastStartedAt: date(r.last_started_at),
    lastFinishedAt: date(r.last_finished_at),
    lastDurationMs: r.last_duration_ms === null || r.last_duration_ms === undefined ? null : Number(r.last_duration_ms),
    lastStatus: (r.last_status as 'ok' | 'error' | null) ?? null,
    lastError: (r.last_error as string | null) ?? null,
    lastInstance: (r.last_instance as string | null) ?? null,
    lastSuccessAt: date(r.last_success_at),
    consecutiveFailures: Number(r.consecutive_failures ?? 0),
    createdAt: date(r.created_at),
    running: r.running === true,
  };
}

async function q(sql: string, params: unknown[] = []): Promise<RawRow[]> {
  return (await pgClient.unsafe(sql, params as never[])) as unknown as RawRow[];
}

/** Implémentation PostgreSQL. */
export const pgTaskStateStore: TaskStateStore = {
  async ensure(rows) {
    for (const r of rows) {
      await q(
        `INSERT INTO scheduled_task_state (code, schedule_signature, next_run_at)
         VALUES ($1, $2, $3::timestamptz)
         ON CONFLICT (code) DO UPDATE
            SET schedule_signature = EXCLUDED.schedule_signature,
                next_run_at        = EXCLUDED.next_run_at,
                updated_at         = now()
          WHERE scheduled_task_state.schedule_signature IS DISTINCT FROM EXCLUDED.schedule_signature`,
        [r.code, r.signature, iso(r.firstRunAt)],
      );
      if (r.bootRunAt) {
        await q(
          `UPDATE scheduled_task_state
              SET next_run_at = LEAST(COALESCE(next_run_at, $2::timestamptz), $2::timestamptz), updated_at = now()
            WHERE code = $1`,
          [r.code, iso(r.bootRunAt)],
        );
      }
    }
  },

  async due() {
    const rows = await q(
      `SELECT code, next_run_at FROM scheduled_task_state
        WHERE next_run_at IS NOT NULL AND next_run_at <= now()
          AND (running_until IS NULL OR running_until < now())`,
    );
    return rows.map((r) => ({ code: String(r.code), nextRunAt: new Date(r.next_run_at as string) }));
  },

  async claim(code, runId, owner, leaseMs, trigger, requireDue) {
    const rows = await q(
      `UPDATE scheduled_task_state
          SET running_run_id  = $2,
              running_by      = $3,
              running_until   = now() + ($4::int * interval '1 millisecond'),
              last_trigger    = $5,
              last_started_at = now(),
              last_instance   = $3,
              updated_at      = now()
        WHERE code = $1
          AND (running_until IS NULL OR running_until < now())
          AND (NOT $6::boolean OR (next_run_at IS NOT NULL AND next_run_at <= now()))
        RETURNING code`,
      [code, runId, owner, Math.round(leaseMs), trigger, requireDue],
    );
    return rows.length > 0;
  },

  async reschedule(code, expected, next) {
    const rows = await q(
      `UPDATE scheduled_task_state SET next_run_at = $3::timestamptz, updated_at = now()
        WHERE code = $1 AND next_run_at = $2::timestamptz
          AND (running_until IS NULL OR running_until < now())
        RETURNING code`,
      [code, iso(expected), next ? iso(next) : null],
    );
    return rows.length > 0;
  },

  async finish(code, runId, rec) {
    const keep = rec.nextRunAt === 'keep';
    const next = rec.nextRunAt === 'keep' || rec.nextRunAt === null ? null : iso(rec.nextRunAt);
    const rows = await q(
      `UPDATE scheduled_task_state
          SET last_finished_at     = now(),
              last_duration_ms     = $3,
              last_status          = $4,
              last_error           = $5,
              last_success_at      = CASE WHEN $9::boolean THEN last_success_at
                                          WHEN $4 = 'ok' THEN now() ELSE last_success_at END,
              consecutive_failures = CASE WHEN $9::boolean THEN consecutive_failures
                                          WHEN $4 = 'ok' THEN 0 ELSE consecutive_failures + 1 END,
              next_run_at          = CASE WHEN $6::boolean THEN next_run_at ELSE $7::timestamptz END,
              running_run_id       = CASE WHEN $8::boolean THEN NULL ELSE running_run_id END,
              running_by           = CASE WHEN $8::boolean THEN NULL ELSE running_by END,
              running_until        = CASE WHEN $8::boolean THEN NULL ELSE running_until END,
              updated_at           = now()
        WHERE code = $1 AND running_run_id = $2
        RETURNING consecutive_failures`,
      [code, runId, Math.max(0, Math.round(rec.durationMs)), rec.status, rec.error, keep, next, rec.release, Boolean(rec.skipped)],
    );
    return rows.length > 0 ? { consecutiveFailures: Number(rows[0].consecutive_failures) } : null;
  },

  async release(code, runId) {
    await q(
      `UPDATE scheduled_task_state
          SET running_run_id = NULL, running_by = NULL, running_until = NULL, updated_at = now()
        WHERE code = $1 AND running_run_id = $2`,
      [code, runId],
    );
  },

  async renew(code, runId, leaseMs) {
    const rows = await q(
      `UPDATE scheduled_task_state
          SET running_until = now() + ($3::int * interval '1 millisecond'), updated_at = now()
        WHERE code = $1 AND running_run_id = $2
        RETURNING code`,
      [code, runId, Math.round(leaseMs)],
    );
    return rows.length > 0;
  },

  async list() {
    const rows = await q(
      `SELECT *, (running_run_id IS NOT NULL AND running_until IS NOT NULL AND running_until > now()) AS running
         FROM scheduled_task_state ORDER BY code`,
    );
    return rows.map(mapRow);
  },
};
