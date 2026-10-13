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

export interface HeartbeatInput {
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
    await pgClient.unsafe(
      `INSERT INTO ai_queue_worker_heartbeats
         (worker_id, hostname, pid, started_at, last_tick_at, last_claim_at, last_claim_treatment,
          last_error, last_error_at, handlers, concurrency, active_slots, running_json, interval_ms)
       VALUES ($1, $2, $3, $4::timestamptz, NOW(), $5::timestamptz, $6, $7, $8::timestamptz, $9::text[], $10, $11, $12::jsonb, $13)
       ON CONFLICT (worker_id) DO UPDATE SET
         last_tick_at = NOW(), last_claim_at = EXCLUDED.last_claim_at, last_claim_treatment = EXCLUDED.last_claim_treatment,
         last_error = EXCLUDED.last_error, last_error_at = EXCLUDED.last_error_at, handlers = EXCLUDED.handlers,
         concurrency = EXCLUDED.concurrency, active_slots = EXCLUDED.active_slots, running_json = EXCLUDED.running_json,
         interval_ms = EXCLUDED.interval_ms`,
      [
        input.workerId, host, process.pid, new Date(a.startedAt).toISOString(),
        a.lastClaimAt ? new Date(a.lastClaimAt).toISOString() : null, a.lastClaimTreatment,
        a.lastError, a.lastErrorAt ? new Date(a.lastErrorAt).toISOString() : null,
        `{${input.handlers.join(',')}}`, input.concurrency, input.activeSlots, JSON.stringify(input.running), input.intervalMs,
      ] as never[],
    );
    // Purge des instances disparues depuis plus de 7 jours (au plus une fois par heure et par processus).
    if (Date.now() - a.lastPurgeAt > 3_600_000) {
      a.lastPurgeAt = Date.now();
      await pgClient.unsafe(`DELETE FROM ai_queue_worker_heartbeats WHERE last_tick_at < NOW() - interval '7 days'`, [] as never[]);
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
}

/** Lignes connues (vivantes ou non), plus récentes d'abord ; `null` si la table est absente. */
export async function listWorkerHeartbeats(): Promise<WorkerHeartbeatRow[] | null> {
  try {
    const { pgClient } = await import('@/db');
    const rows = (await pgClient.unsafe(
      `SELECT worker_id, hostname, pid, started_at, last_tick_at, last_claim_at, last_claim_treatment,
              last_error, last_error_at, handlers, concurrency, active_slots, running_json, interval_ms
         FROM ai_queue_worker_heartbeats ORDER BY last_tick_at DESC LIMIT 50`,
      [] as never[],
    )) as unknown as Array<Record<string, unknown>>;
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
