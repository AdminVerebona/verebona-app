/**
 * Lot 111C — SUPERVISION PERSISTANTE du worker des diagnostics (serveur
 * uniquement).
 *
 *   · Battement par processus (`diagnostic_worker_heartbeats`, migration
 *     1200) : chaque processus Next écrit SA ligne — worker démarré (dernier
 *     tour, dernier prélèvement, travail en cours, raison d'attente, dernière
 *     erreur), désactivé (variable en cause) ou absent de ce processus (rôle
 *     web/worker, BACKGROUND_JOBS_PROCESS) — avec version et mémoire. Le BO lit
 *     TOUTES les lignes : il ne confond plus l'instance HTTP qui répond avec
 *     le worker effectif.
 *   · Superviseur INDÉPENDANT du worker (`startDiagnosticSupervisor`, démarré
 *     dans chaque processus web, même quand le worker est désactivé, absent
 *     ou bloqué) : toutes les minutes, raison d'attente de chaque demande en
 *     file (`diagnoseWait`, pure), persistée sur la demande ; alerte BO
 *     (anomalie « Autres traitements techniques », une par raison) dès la
 *     demande pour une cause de configuration, au-delà de
 *     DIAG_JOB_STALL_ALERT_SECONDS (5 min) sinon ; résolution automatique
 *     quand la file repart (reprise : le worker rétabli prend la demande).
 *
 * Ne lève jamais : la supervision observe, elle ne fait rien échouer.
 */
import { hostname } from 'node:os';
import { diagJobSettings, sanitizeErrorMessage, DIAG_JOB_MODE } from './state';
import { DIAG_WAIT_ACTIONS, DIAG_WAIT_REASONS, diagnoseWait, isBeatAlive, waitLabel, type DiagWaitReason, type DiagWorkerBeat, type WaitDiagnosis } from './wait';

type Raw = Record<string, unknown>;
const iso = (v: unknown) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

async function db() {
  return (await import('@/db')).pgClient;
}

// ── Battements ──────────────────────────────────────────────────────────────

export interface BeatWrite {
  instanceId: string;
  state: DiagWorkerBeat['state'];
  disabledReason?: string | null;
  startedAt: string;
  lastTickAt?: string | null;
  lastTickOkAt?: string | null;
  tickRunningSince?: string | null;
  lastClaimAt?: string | null;
  lastClaimJobId?: string | null;
  currentJobId?: string | null;
  waitReason?: string | null;
  lastError?: string | null;
  lastErrorAt?: string | null;
  intervalMs?: number | null;
  processed?: number;
  /** Lot 111Q : état de la voie ciblée (migration 1280) ; null : voie absente (worker non démarré). */
  lane?: { jobId: string | null; waitReason: string | null; lastClaimAt: string | null; capacity: number } | null;
}

let lastPurge = 0;

/** Écrit la ligne de CE processus (upsert complet). Ne lève jamais ; rend false en cas d'échec. */
export async function writeDiagnosticBeat(b: BeatWrite): Promise<boolean> {
  try {
    const [sql, { processRoleSummary }, { getBuildIdentity }, mem] = await Promise.all([
      db(), import('@/lib/runtime/process-role'), import('@/lib/runtime-identity'), import('@/lib/runtime/memory-monitor'),
    ]);
    const role = processRoleSummary();
    const build = getBuildIdentity();
    const snap = mem.memorySnapshot();
    let host = 'local';
    try { host = hostname(); } catch { /* conteneur sans nom */ }
    const u = (v: string | null | undefined) => (v && /^[0-9a-f-]{36}$/i.test(v) ? v : null);
    await sql`
      INSERT INTO diagnostic_worker_heartbeats
        (instance_id, host, pid, container, process_type, placement, state, disabled_reason, build_commit, build_version, started_at, seen_at,
         last_tick_at, last_tick_ok_at, tick_running_since, last_claim_at, last_claim_job_id, current_job_id, wait_reason, last_error, last_error_at,
         interval_ms, memory_level, rss_mb, container_limit_mb, processed)
      VALUES (${b.instanceId}, ${host.slice(0, 80)}, ${process.pid}, ${role.container}, ${role.process}, ${role.placement}, ${b.state}, ${b.disabledReason ?? null},
              ${build.commit ?? null}, ${build.version ?? null}, ${b.startedAt}::timestamptz, now(),
              ${b.lastTickAt ?? null}::timestamptz, ${b.lastTickOkAt ?? null}::timestamptz, ${b.tickRunningSince ?? null}::timestamptz,
              ${b.lastClaimAt ?? null}::timestamptz, ${u(b.lastClaimJobId)}::uuid, ${u(b.currentJobId)}::uuid, ${b.waitReason ?? null},
              ${b.lastError ? sanitizeErrorMessage(b.lastError) : null}, ${b.lastErrorAt ?? null}::timestamptz,
              ${b.intervalMs ?? null}, ${snap.level}, ${snap.last?.rssMb ?? null}, ${snap.last?.containerLimitMb ?? null}, ${b.processed ?? 0})
      ON CONFLICT (instance_id) DO UPDATE SET
        state = EXCLUDED.state, disabled_reason = EXCLUDED.disabled_reason, placement = EXCLUDED.placement, process_type = EXCLUDED.process_type,
        build_commit = EXCLUDED.build_commit, build_version = EXCLUDED.build_version, seen_at = now(),
        last_tick_at = EXCLUDED.last_tick_at, last_tick_ok_at = EXCLUDED.last_tick_ok_at, tick_running_since = EXCLUDED.tick_running_since,
        last_claim_at = EXCLUDED.last_claim_at, last_claim_job_id = EXCLUDED.last_claim_job_id, current_job_id = EXCLUDED.current_job_id,
        wait_reason = EXCLUDED.wait_reason, last_error = EXCLUDED.last_error, last_error_at = EXCLUDED.last_error_at,
        interval_ms = EXCLUDED.interval_ms, memory_level = EXCLUDED.memory_level, rss_mb = EXCLUDED.rss_mb,
        container_limit_mb = EXCLUDED.container_limit_mb, processed = EXCLUDED.processed`;
    // Lot 111Q : voie ciblée — écriture séparée, tolérante à l'absence de la migration 1280.
    await sql`UPDATE diagnostic_worker_heartbeats SET lane_job_id = ${u(b.lane?.jobId)}::uuid, lane_wait_reason = ${b.lane?.waitReason ?? null},
               lane_last_claim_at = ${b.lane?.lastClaimAt ?? null}::timestamptz, lane_capacity = ${b.lane ? b.lane.capacity : null}
               WHERE instance_id = ${b.instanceId}`.catch((e) => { if ((e as { code?: string })?.code !== '42703') throw e; });
    if (Date.now() - lastPurge > 3600_000) {
      lastPurge = Date.now();
      await sql`DELETE FROM diagnostic_worker_heartbeats WHERE seen_at < now() - interval '7 days'`.catch(() => undefined);
    }
    return true;
  } catch (e) {
    // Table absente (migration 1200 non appliquée) ou base indisponible : jamais bloquant.
    if ((e as { code?: string })?.code !== '42P01') console.error('[diagnostic-job] battement non écrit :', sanitizeErrorMessage(e));
    return false;
  }
}

/** Processus arrêté proprement : ligne marquée STOPPED (sinon elle vieillit et cesse d'être « vivante »). */
export async function markDiagnosticBeatStopped(instanceId: string): Promise<void> {
  try {
    const sql = await db();
    await sql`UPDATE diagnostic_worker_heartbeats SET state = 'STOPPED', current_job_id = NULL, seen_at = now() WHERE instance_id = ${instanceId}`;
  } catch { /* best effort */ }
}

function toBeat(r: Raw): DiagWorkerBeat {
  return {
    instanceId: String(r.instance_id), processType: String(r.process_type) as DiagWorkerBeat['processType'], placement: String(r.placement) as DiagWorkerBeat['placement'],
    state: String(r.state) as DiagWorkerBeat['state'], disabledReason: r.disabled_reason == null ? null : String(r.disabled_reason),
    buildCommit: r.build_commit == null ? null : String(r.build_commit), startedAt: iso(r.started_at)!, seenAt: iso(r.seen_at)!,
    lastTickAt: iso(r.last_tick_at), lastTickOkAt: iso(r.last_tick_ok_at), tickRunningSince: iso(r.tick_running_since), lastClaimAt: iso(r.last_claim_at),
    currentJobId: r.current_job_id == null ? null : String(r.current_job_id), waitReason: r.wait_reason == null ? null : String(r.wait_reason),
    lastError: r.last_error == null ? null : String(r.last_error), lastErrorAt: iso(r.last_error_at), intervalMs: r.interval_ms == null ? null : Number(r.interval_ms),
    laneJobId: r.lane_job_id == null ? null : String(r.lane_job_id), laneWaitReason: r.lane_wait_reason == null ? null : String(r.lane_wait_reason),
    laneLastClaimAt: iso(r.lane_last_claim_at), laneCapacity: r.lane_capacity == null ? null : Number(r.lane_capacity),
  };
}

export type DiagWorkerBeatRow = DiagWorkerBeat & {
  host: string | null; container: string | null; buildVersion: string | null; lastClaimJobId: string | null;
  memoryLevel: string | null; rssMb: number | null; containerLimitMb: number | null; processed: number;
};

/** Battements de tous les processus (vus depuis 24 h) ; null si la table est absente. */
export async function listDiagnosticBeats(): Promise<DiagWorkerBeatRow[] | null> {
  try {
    const sql = await db();
    const rows = await sql<Raw[]>`SELECT * FROM diagnostic_worker_heartbeats WHERE seen_at > now() - interval '24 hours' ORDER BY seen_at DESC LIMIT 50`;
    return rows.map((r) => ({
      ...toBeat(r),
      host: r.host == null ? null : String(r.host), container: r.container == null ? null : String(r.container), buildVersion: r.build_version == null ? null : String(r.build_version),
      lastClaimJobId: r.last_claim_job_id == null ? null : String(r.last_claim_job_id), memoryLevel: r.memory_level == null ? null : String(r.memory_level),
      rssMb: r.rss_mb == null ? null : Number(r.rss_mb), containerLimitMb: r.container_limit_mb == null ? null : Number(r.container_limit_mb), processed: Number(r.processed ?? 0),
    }));
  } catch (e) {
    if ((e as { code?: string })?.code === '42P01') return null;
    throw e;
  }
}

// ── Raison d'attente de la file ────────────────────────────────────────────

export interface QueueWait {
  jobId: string;
  scope: string;
  startedAt: string;
  diagnosis: WaitDiagnosis;
  label: string;
  action: string;
}

/** Raisons d'attente de toutes les demandes en file (lecture seule, multi-instance). */
export async function diagnosticQueueWaits(now: Date = new Date()): Promise<{ waits: QueueWait[]; beats: DiagWorkerBeatRow[] | null; aliveWorkers: number }> {
  const sql = await db();
  const s = diagJobSettings();
  const [queued, running, beats] = await Promise.all([
    sql<Raw[]>`SELECT id::text, coalesce(perimeter->>'scope', target_type, 'global') AS scope, started_at, next_attempt_at FROM admin_export_generations
                WHERE kind = 'TECH_DIAGNOSTIC' AND mode = ${DIAG_JOB_MODE} AND status = 'QUEUED' AND NOT cancel_requested ORDER BY started_at LIMIT 20`,
    sql<Raw[]>`SELECT id::text, coalesce(perimeter->>'scope', target_type, 'global') AS scope, (locked_until > now()) AS lease_alive, cancel_requested, cancel_reason
                 FROM admin_export_generations WHERE kind = 'TECH_DIAGNOSTIC' AND mode = ${DIAG_JOB_MODE} AND status = 'RUNNING'`,
    listDiagnosticBeats(),
  ]);
  const run = running.map((r) => ({ id: String(r.id), scope: String(r.scope), leaseAlive: r.lease_alive === true, cancelRequested: r.cancel_requested === true, cancelReason: r.cancel_reason == null ? null : String(r.cancel_reason) }));
  const waits = queued.map((q) => {
    const diagnosis = diagnoseWait({
      job: { id: String(q.id), scope: String(q.scope), startedAt: iso(q.started_at)!, nextAttemptAt: iso(q.next_attempt_at) },
      beats, running: run, globalConcurrency: s.globalConcurrency, targetedConcurrency: s.targetedConcurrency, stallAlertSeconds: s.stallAlertSeconds, now,
    });
    return { jobId: String(q.id), scope: String(q.scope), startedAt: iso(q.started_at)!, diagnosis, label: waitLabel(diagnosis), action: DIAG_WAIT_ACTIONS[diagnosis.reason] };
  });
  const aliveWorkers = (beats ?? []).filter((b) => b.state === 'STARTED' && isBeatAlive(b, now)).length;
  return { waits, beats, aliveWorkers };
}

/** Raison d'attente d'UNE demande (null : pas en file, ou lecture impossible). */
export async function diagnosticJobWait(jobId: string, now: Date = new Date()): Promise<QueueWait | null> {
  try {
    const { waits } = await diagnosticQueueWaits(now);
    return waits.find((w) => w.jobId === jobId) ?? null;
  } catch (e) {
    console.error('[diagnostic-job] raison d’attente illisible :', sanitizeErrorMessage(e));
    return null;
  }
}

// ── Superviseur ─────────────────────────────────────────────────────────────

export const stallFingerprint = async (reason: DiagWaitReason): Promise<string> =>
  (await import('@/services/admin/anomaly.service')).buildFingerprint('other', 'diagnostic-jobs', 'queue-stalled', reason);

const GUIDE = 'docs/exploitation/recette-111c-diagnostic-global.md';

/**
 * Un tour du superviseur : raison d'attente persistée sur chaque demande en
 * file, alertes BO (une par raison), résolution des autres. Rend ce qui a été
 * signalé. Ne lève jamais.
 */
export async function superviseDiagnosticQueue(now: Date = new Date()): Promise<{ alerted: DiagWaitReason[]; waits: QueueWait[] }> {
  try {
    const sql = await db();
    const { waits, beats } = await diagnosticQueueWaits(now);
    for (const w of waits) {
      await sql`UPDATE admin_export_generations SET wait_reason = ${w.diagnosis.reason}, wait_reason_at = ${now.toISOString()}::timestamptz,
                 stall_alerted_at = CASE WHEN ${w.diagnosis.alert} THEN coalesce(stall_alerted_at, ${now.toISOString()}::timestamptz) ELSE stall_alerted_at END
                 WHERE id = ${w.jobId}::uuid AND status = 'QUEUED'`;
    }
    const { reportAnomaly, autoResolveAnomaly } = await import('@/services/admin/anomaly.service');
    const byReason = new Map<DiagWaitReason, QueueWait[]>();
    for (const w of waits) if (w.diagnosis.alert) byReason.set(w.diagnosis.reason, [...(byReason.get(w.diagnosis.reason) ?? []), w]);
    for (const [reason, list] of byReason) {
      const first = list[0];
      console.warn(`[diagnostic-supervisor] ${JSON.stringify({ event: 'stalled', reason, detail: first.diagnosis.detail, jobId: first.jobId, scope: first.scope, waitedSeconds: first.diagnosis.waitedSeconds, queued: list.length, blockingJobId: first.diagnosis.blockingJobId })}`);
      await reportAnomaly({
        domain: 'other',
        fingerprint: await stallFingerprint(reason),
        title: `Diagnostic BO non démarré : ${first.label}`,
        detail: {
          reason, detail: first.diagnosis.detail, jobId: first.jobId, scope: first.scope, waitedMinutes: Math.round(first.diagnosis.waitedSeconds / 60),
          queued: list.map((x) => x.jobId), blockingJobId: first.diagnosis.blockingJobId,
          workers: (beats ?? []).filter((b) => isBeatAlive(b, now)).map((b) => ({ instance: b.instanceId.split(':').slice(0, 2).join(':'), process: b.processType, placement: b.placement, state: b.state, disabledReason: b.disabledReason, lastTickAt: b.lastTickAt, waitReason: b.waitReason, commit: b.buildCommit })),
          action: `${DIAG_WAIT_ACTIONS[reason]} Voir ${GUIDE}.`,
        },
      });
    }
    for (const reason of DIAG_WAIT_REASONS) {
      if (byReason.has(reason)) continue;
      await autoResolveAnomaly(await stallFingerprint(reason), { origin: 'diagnostic_supervisor', cause: waits.length ? `File repartie (raison actuelle : ${waits[0].diagnosis.reason})` : 'Plus aucune demande de diagnostic en attente' });
    }
    return { alerted: [...byReason.keys()], waits };
  } catch (e) {
    console.error('[diagnostic-supervisor] tour en échec (non bloquant) :', sanitizeErrorMessage(e));
    return { alerted: [], waits: [] };
  }
}

const KEY = Symbol.for('verebona.admin.diagnostic-jobs.supervisor');

/**
 * Démarre le superviseur dans CE processus (une fois). Indépendant du worker :
 * minuterie propre, aucune dépendance à son état en mémoire ; démarré dans les
 * processus web, qu'ils portent le worker ou non.
 */
export function startDiagnosticSupervisor(intervalMs = 60_000): void {
  const g = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (g[KEY]) return;
  g[KEY] = true;
  let busy = false;
  const run = () => {
    if (busy) return;
    busy = true;
    void superviseDiagnosticQueue().finally(() => { busy = false; });
  };
  setTimeout(run, 45_000).unref?.();
  setInterval(run, intervalMs).unref?.();
  console.info(`[diagnostic-supervisor] superviseur de la file des diagnostics démarré (tour toutes les ${Math.round(intervalMs / 1000)} s, alerte au-delà de ${diagJobSettings().stallAlertSeconds} s d’attente).`);
}

/**
 * Lot 111Q — worker vu par le BO pour UNE demande : celui qui l'exécute (voie
 * commune ou ciblée) ou, en file, le dernier worker vivant (dernier tour,
 * dernier prélèvement, battement). Lecture seule, ne lève jamais.
 */
export async function diagnosticJobWorkerView(job: { id: string; status: string; worker: string | null }, now: Date = new Date()): Promise<null | {
  instance: string; state: string; alive: boolean; seenAt: string; lastTickAt: string | null; lastClaimAt: string | null; lane: 'main' | 'targeted' | null;
  waitReason: string | null; laneWaitReason: string | null; commit: string | null; version: string | null; aliveWorkers: number;
}> {
  try {
    const beats = await listDiagnosticBeats();
    if (!beats) return null;
    const alive = beats.filter((b) => isBeatAlive(b, now));
    const short = (b: DiagWorkerBeatRow) => b.instanceId.split(':').slice(0, 2).join(':');
    const own = beats.find((b) => b.currentJobId === job.id || b.laneJobId === job.id) ?? (job.worker ? beats.find((b) => short(b) === job.worker) : undefined);
    const pick = own ?? alive.filter((b) => b.state === 'STARTED').sort((a, b) => Date.parse(b.seenAt) - Date.parse(a.seenAt))[0] ?? alive[0] ?? beats[0];
    if (!pick) return null;
    return {
      instance: short(pick), state: pick.state, alive: isBeatAlive(pick, now), seenAt: pick.seenAt, lastTickAt: pick.lastTickAt,
      lastClaimAt: [pick.lastClaimAt, pick.laneLastClaimAt ?? null].filter(Boolean).sort().at(-1) ?? null,
      lane: own ? (pick.laneJobId === job.id ? 'targeted' : 'main') : null, waitReason: pick.waitReason, laneWaitReason: pick.laneWaitReason ?? null,
      commit: pick.buildCommit, version: pick.buildVersion, aliveWorkers: alive.filter((b) => b.state === 'STARTED').length,
    };
  } catch (e) {
    console.error('[diagnostic-job] worker illisible :', sanitizeErrorMessage(e));
    return null;
  }
}
