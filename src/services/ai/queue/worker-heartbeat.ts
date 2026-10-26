/**
 * Battement du boucleur de la file IA — lot 52A (ticket « [P1] T3 —
 * non-déclenchement des exécutions manuelles et horaires », COR-04).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI EN BASE
 *
 * Le boucleur tourne DANS chaque processus web (instrumentation). Sur
 * Scalingo, plusieurs conteneurs peuvent tourner ; la route du BO qui répond
 * est servie par l'un d'eux, au hasard. Lire l'état « du » boucleur en
 * mémoire montrerait l'état d'UN processus comme celui du service — ce que le
 * ticket interdit. Chaque boucleur écrit donc sa ligne
 * (`ai_queue_worker_heartbeats`, migration 0338) à chaque tour ; le BO agrège
 * toutes les instances vivantes (`summarizeWorkers`, pure, testée).
 *
 * Best effort : une écriture en échec (table absente, base indisponible) ne
 * bloque jamais la file.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { Treatment } from '../config/treatments';

/** Activité locale du boucleur, partagée entre les copies du module (Next.js). */
interface Activity {
  lastClaimAt: number | null;
  lastClaimTreatment: Treatment | null;
  lastError: string | null;
  lastErrorAt: number | null;
  startedAt: number;
  lastPurgeAt: number;
  /** Lot 54A : dernière évaluation de la planification par ce processus. */
  lastSchedule?: { at: number; outcomes: unknown[] } | null;
}
const KEY = Symbol.for('verebona.ai.queue-worker.activity');
function activity(): Activity {
  const g = globalThis as unknown as Record<symbol, Activity | undefined>;
  return (g[KEY] ??= { lastClaimAt: null, lastClaimTreatment: null, lastError: null, lastErrorAt: null, startedAt: Date.now(), lastPurgeAt: 0 });
}

/** Un job vient d'être prélevé par ce processus. */
export function noteWorkerClaim(treatment: Treatment, at: number = Date.now()): void {
  const a = activity();
  a.lastClaimAt = at;
  a.lastClaimTreatment = treatment;
}

/** Erreur d'un tour ou d'une place d'exécution (non bloquante). */
export function noteWorkerError(message: string, at: number = Date.now()): void {
  const a = activity();
  a.lastError = message.slice(0, 500);
  a.lastErrorAt = at;
}

/** Lot 54A : dernière évaluation de la planification (une issue par traitement). */
export function noteScheduleEvaluation(outcomes: ReadonlyArray<unknown>, at: number = Date.now()): void {
  activity().lastSchedule = { at, outcomes: [...outcomes] };
}

interface HeartbeatInput {
  workerId: string;
  handlers: Treatment[];
  concurrency: number;
  activeSlots: number;
  running: Partial<Record<Treatment, number>>;
  intervalMs: number;
}

/** Écrit la ligne de ce processus (upsert). Ne lève jamais. */
export async function writeWorkerHeartbeat(input: HeartbeatInput): Promise<boolean> {
  const a = activity();
  try {
    const [{ pgClient }, os] = await Promise.all([import('@/db'), import('node:os')]);
    let host = 'local';
    try { host = os.hostname(); } catch { /* conteneur sans nom */ }
    const params = [
      input.workerId, host, process.pid, new Date(a.startedAt).toISOString(),
      a.lastClaimAt ? new Date(a.lastClaimAt).toISOString() : null, a.lastClaimTreatment,
      a.lastError, a.lastErrorAt ? new Date(a.lastErrorAt).toISOString() : null,
      `{${input.handlers.join(',')}}`, input.concurrency, input.activeSlots, JSON.stringify(input.running), input.intervalMs,
    ];
    const base = `INSERT INTO ai_queue_worker_heartbeats
         (worker_id, hostname, pid, started_at, last_tick_at, last_claim_at, last_claim_treatment,
          last_error, last_error_at, handlers, concurrency, active_slots, running_json, interval_ms%COLS%)
       VALUES ($1, $2, $3, $4::timestamptz, NOW(), $5::timestamptz, $6, $7, $8::timestamptz, $9::text[], $10, $11, $12::jsonb, $13%VALS%)
       ON CONFLICT (worker_id) DO UPDATE SET
         last_tick_at = NOW(), last_claim_at = EXCLUDED.last_claim_at, last_claim_treatment = EXCLUDED.last_claim_treatment,
         last_error = EXCLUDED.last_error, last_error_at = EXCLUDED.last_error_at, handlers = EXCLUDED.handlers,
         concurrency = EXCLUDED.concurrency, active_slots = EXCLUDED.active_slots, running_json = EXCLUDED.running_json,
         interval_ms = EXCLUDED.interval_ms%SETS%`;
    // Lot 54A (migration 0370) : commit du code de CETTE instance et dernière
    // évaluation de la planification. Colonnes absentes (0370 non appliquée) :
    // battement d'avant ce lot, sans ces deux informations.
    let commit: string | null = null;
    try { commit = (await import('@/lib/runtime-identity')).getBuildIdentity().commit; } catch { commit = null; }
    const planif = a.lastSchedule ? JSON.stringify({ at: new Date(a.lastSchedule.at).toISOString(), outcomes: a.lastSchedule.outcomes }) : null;
    try {
      await pgClient.unsafe(
        base.replace('%COLS%', ', build_commit, schedule_json').replace('%VALS%', ', $14, $15::jsonb')
          .replace('%SETS%', ', build_commit = EXCLUDED.build_commit, schedule_json = COALESCE(EXCLUDED.schedule_json, ai_queue_worker_heartbeats.schedule_json)'),
        [...params, commit, planif] as never[],
      );
    } catch (e) {
      if ((e as { code?: string }).code !== '42703') throw e;
      await pgClient.unsafe(base.replace('%COLS%', '').replace('%VALS%', '').replace('%SETS%', ''), params as never[]);
    }
    // Purge des instances disparues depuis plus de 7 jours (au plus une fois par heure et par processus).
    if (Date.now() - a.lastPurgeAt > 3_600_000) {
      a.lastPurgeAt = Date.now();
      await pgClient.unsafe(`DELETE FROM ai_queue_worker_heartbeats WHERE last_tick_at < NOW() - interval '7 days'`, [] as never[]);
      // Lot 54A : traces des demandes T3 de plus de 30 jours.
      const { purgeT3EnqueueEvents } = await import('./t3-enqueue-trace');
      await purgeT3EnqueueEvents();
    }
    return true;
  } catch {
    return false;
  }
}

export interface WorkerHeartbeatRow {
  workerId: string;
  hostname: string | null;
  pid: number | null;
  startedAt: Date;
  lastTickAt: Date;
  lastClaimAt: Date | null;
  lastClaimTreatment: string | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  handlers: string[];
  concurrency: number;
  activeSlots: number;
  running: Record<string, number>;
  intervalMs: number;
  /** Lot 54A : commit du code de l'instance (null : inconnu ou 0370 absente). */
  buildCommit?: string | null;
  /** Lot 54A : dernière évaluation de la planification par l'instance. */
  schedule?: { at: string; outcomes: Array<Record<string, unknown>> } | null;
}

/** Lignes connues (vivantes ou non), plus récentes d'abord ; `null` si la table est absente. */
export async function listWorkerHeartbeats(): Promise<WorkerHeartbeatRow[] | null> {
  try {
    const { pgClient } = await import('@/db');
    const cols = `worker_id, hostname, pid, started_at, last_tick_at, last_claim_at, last_claim_treatment,
              last_error, last_error_at, handlers, concurrency, active_slots, running_json, interval_ms`;
    let rows: Array<Record<string, unknown>>;
    try {
      rows = (await pgClient.unsafe(
        `SELECT ${cols}, build_commit, schedule_json FROM ai_queue_worker_heartbeats ORDER BY last_tick_at DESC LIMIT 50`, [] as never[],
      )) as unknown as Array<Record<string, unknown>>;
    } catch (e) {
      // Lot 54A : colonnes 0370 absentes — lecture d'avant ce lot.
      if ((e as { code?: string }).code !== '42703') throw e;
      rows = (await pgClient.unsafe(
        `SELECT ${cols} FROM ai_queue_worker_heartbeats ORDER BY last_tick_at DESC LIMIT 50`, [] as never[],
      )) as unknown as Array<Record<string, unknown>>;
    }
    const d = (v: unknown) => (v ? new Date(String(v)) : null);
    return rows.map((r) => ({
      workerId: String(r.worker_id),
      hostname: r.hostname == null ? null : String(r.hostname),
      pid: r.pid == null ? null : Number(r.pid),
      startedAt: d(r.started_at)!,
      lastTickAt: d(r.last_tick_at)!,
      lastClaimAt: d(r.last_claim_at),
      lastClaimTreatment: r.last_claim_treatment == null ? null : String(r.last_claim_treatment),
      lastError: r.last_error == null ? null : String(r.last_error),
      lastErrorAt: d(r.last_error_at),
      handlers: Array.isArray(r.handlers) ? (r.handlers as unknown[]).map(String) : [],
      concurrency: Number(r.concurrency ?? 0),
      activeSlots: Number(r.active_slots ?? 0),
      running: (r.running_json ?? {}) as Record<string, number>,
      intervalMs: Number(r.interval_ms ?? 15_000),
      buildCommit: r.build_commit == null ? null : String(r.build_commit),
      schedule: (r.schedule_json ?? null) as WorkerHeartbeatRow['schedule'],
    }));
  } catch {
    return null;
  }
}

/** Une instance est vivante si son dernier tour date de moins de 3 intervalles (90 s au moins). */
export function isWorkerAlive(row: Pick<WorkerHeartbeatRow, 'lastTickAt' | 'intervalMs'>, now: Date = new Date()): boolean {
  const seuil = Math.max(90_000, 3 * (row.intervalMs || 15_000));
  return now.getTime() - row.lastTickAt.getTime() <= seuil;
}

export type WorkerServiceState = 'OK' | 'NO_LIVE_WORKER' | 'NO_T3_EXECUTOR' | 'UNKNOWN';

export interface WorkerSummary {
  /** État du SERVICE (toutes instances), jamais celui d'un seul processus. */
  state: WorkerServiceState;
  liveInstances: number;
  knownInstances: number;
  /** Instances vivantes dont l'exécutant T3 est enregistré. */
  t3ExecutorInstances: number;
  lastTickAt: Date | null;
  lastClaimAt: Date | null;
  instances: Array<WorkerHeartbeatRow & { alive: boolean }>;
}

/** Agrège les instances (pure, testée). `rows = null` : table absente → état inconnu. */
export function summarizeWorkers(rows: WorkerHeartbeatRow[] | null, now: Date = new Date()): WorkerSummary {
  if (rows === null) {
    return { state: 'UNKNOWN', liveInstances: 0, knownInstances: 0, t3ExecutorInstances: 0, lastTickAt: null, lastClaimAt: null, instances: [] };
  }
  const instances = rows.map((r) => ({ ...r, alive: isWorkerAlive(r, now) }));
  const vivantes = instances.filter((i) => i.alive);
  const t3 = vivantes.filter((i) => i.handlers.includes('T3')).length;
  const max = (xs: Array<Date | null>) => xs.reduce<Date | null>((m, x) => (x && (!m || x > m) ? x : m), null);
  return {
    state: vivantes.length === 0 ? 'NO_LIVE_WORKER' : t3 === 0 ? 'NO_T3_EXECUTOR' : 'OK',
    liveInstances: vivantes.length,
    knownInstances: instances.length,
    t3ExecutorInstances: t3,
    lastTickAt: max(instances.map((i) => i.lastTickAt)),
    lastClaimAt: max(instances.map((i) => i.lastClaimAt)),
    instances,
  };
}
