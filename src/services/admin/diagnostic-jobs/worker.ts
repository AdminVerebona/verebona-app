/**
 * Lot 107G — worker des diagnostics BO durables (serveur uniquement).
 *
 * Même modèle que le worker des exports lourds (V12, RGPD « Mes données ») :
 * boucle par instance démarrée au boot (`instrumentation-node.ts`), réveillée
 * à la mise en file (`nudgeDiagnosticWorker`), UN diagnostic à la fois par
 * instance et `DIAG_JOB_GLOBAL_CONCURRENCY` (1) sur l'ensemble des instances ;
 * bail renouvelé au tiers de sa durée (avec la progression et la mémoire du
 * processus) ; rattrapage des orphelins à chaque tour ; purge des archives
 * expirées (au plus une fois par heure).
 *
 * Boucle distincte de celle des dossiers V12 : un diagnostic global peut
 * durer longtemps et ne doit pas faire attendre les dossiers des utilisateurs.
 * Sa mémoire est bornée (lots, compression en flux, aucune archive en
 * mémoire) et surveillée (seuil de garde).
 *
 * `DIAG_JOB_WORKER_DISABLED=true` (ou `EXPORTS_WORKER_DISABLED=true`) : aucun
 * diagnostic sur cette instance.
 *
 * Lot 111C — chaque chemin où ce worker ne prend rien est désormais VISIBLE
 * en base (`diagnostic_worker_heartbeats`, battement toutes les 30 s par
 * processus) et donc au BO et dans l'alerte du superviseur :
 *   · désactivé (variable nommée) — ligne DISABLED ;
 *   · pas dans ce processus (BACKGROUND_JOBS_PROCESS) — ligne
 *     NOT_THIS_PROCESS (`markDiagnosticWorkerNotHere`) ;
 *   · tour en échec (dernière erreur), tour bloqué (`tick_running_since`),
 *     admission mémoire refusée, créneau global occupé, ancien diagnostic
 *     global en cours d'arrêt — raison d'attente du dernier tour.
 * `DIAG_JOB_WORKER_DISABLED=auto` : démarrage sûr — le worker tourne mais ne
 * prend un diagnostic que si la mémoire du conteneur est sous le seuil
 * d'admission (jamais de départ forcé) ; `true` reste une désactivation
 * explicite, jamais contournée.
 */
import { admitHeavyTask, memorySnapshot, pressureLevel, sampleNow, trackMemory } from '@/lib/runtime/memory-monitor';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DIAG_JOB_PREFIX, diagJobSettings, sanitizeErrorMessage, workerDisabledReason, type DiagJobStatus } from './state';
import {
  claimNextDiagnosticJobDetailed, expiredDiagnosticJobs, markDiagnosticJobPurged, recoverDiagnosticJobs, renewDiagnosticLease,
} from './repository';
import { containerMemoryLimitMb, emptyProgress, purgeDiagnosticPrefix, runDiagnosticJob, sampleMemory, type DiagStorage } from './runner';
import { DIAG_PRESENCE_INTERVAL_MS } from './wait';

export const DIAG_WORKER_ID = `${(() => { try { return hostname(); } catch { return 'local'; } })()}:${process.pid}:${randomUUID().slice(0, 8)}`;

interface WorkerState {
  started: boolean;
  running: boolean;
  again: boolean;
  timer: ReturnType<typeof setInterval> | null;
  startedAt: string | null;
  lastTickAt: string | null;
  lastTickError: string | null;
  currentJobId: string | null;
  lastPurgeAt: number;
  disabledReason: string | null;
  processed: number;
  /** Lot 111C — état persisté (battement). */
  mode: 'STARTED' | 'DISABLED' | 'NOT_THIS_PROCESS' | null;
  presence: ReturnType<typeof setInterval> | null;
  bootAt: string;
  lastTickOkAt: string | null;
  lastTickErrorAt: string | null;
  tickRunningSince: string | null;
  lastClaimAt: string | null;
  lastClaimJobId: string | null;
  waitReason: string | null;
}
const KEY = Symbol.for('verebona.admin.diagnostic-jobs.worker');
function state(): WorkerState {
  const g = globalThis as unknown as Record<symbol, WorkerState | undefined>;
  return (g[KEY] ??= {
    started: false, running: false, again: false, timer: null, startedAt: null, lastTickAt: null, lastTickError: null, currentJobId: null, lastPurgeAt: 0, disabledReason: null, processed: 0,
    mode: null, presence: null, bootAt: new Date().toISOString(), lastTickOkAt: null, lastTickErrorAt: null, tickRunningSince: null, lastClaimAt: null, lastClaimJobId: null, waitReason: null,
  });
}

/** État du worker DE CETTE INSTANCE (observabilité ; aucun secret). Le BO lit aussi les battements persistés de TOUTES les instances. */
export function diagnosticWorkerState(): Omit<WorkerState, 'timer' | 'again' | 'lastPurgeAt' | 'presence'> & { workerId: string } {
  const { timer: _t, again: _a, lastPurgeAt: _p, presence: _pr, ...rest } = state();
  return { ...rest, workerId: DIAG_WORKER_ID.split(':').slice(0, 2).join(':') };
}

/** Lot 111C : écrit le battement de ce processus (best effort). */
async function beat(): Promise<void> {
  const st = state();
  if (!st.mode) return;
  const { writeDiagnosticBeat } = await import('./supervision');
  await writeDiagnosticBeat({
    instanceId: DIAG_WORKER_ID, state: st.mode, disabledReason: st.disabledReason, startedAt: st.startedAt ?? st.bootAt,
    lastTickAt: st.lastTickAt, lastTickOkAt: st.lastTickOkAt, tickRunningSince: st.tickRunningSince, lastClaimAt: st.lastClaimAt,
    lastClaimJobId: st.lastClaimJobId, currentJobId: st.currentJobId, waitReason: st.waitReason,
    lastError: st.lastTickError, lastErrorAt: st.lastTickErrorAt, intervalMs: diagJobSettings().intervalMs, processed: st.processed,
  });
}

function startPresence(): void {
  const st = state();
  if (st.presence) return;
  // Premier battement après la mise en place de la base (migrations au postdeploy, pool prêt).
  setTimeout(() => void beat(), 5_000).unref?.();
  st.presence = setInterval(() => void beat(), DIAG_PRESENCE_INTERVAL_MS);
  st.presence.unref?.();
}

/**
 * Lot 111C : ce processus ne porte PAS le worker (BACKGROUND_JOBS_PROCESS ≠
 * son type) — il le DIT en base, pour que l'absence de tout worker se voie
 * (« BACKGROUND_JOBS_PROCESS=worker sans conteneur worker »).
 */
export function markDiagnosticWorkerNotHere(): void {
  const st = state();
  if (st.started || st.mode) return;
  st.mode = 'NOT_THIS_PROCESS';
  startPresence();
}

/**
 * Lot 111C : admission d'un diagnostic. Mode `auto` (DIAG_JOB_WORKER_DISABLED=auto) :
 * seulement sous le seuil d'admission, sans départ forcé ; sinon règle commune du lot 109H.
 */
function admitDiagnostic(strict: boolean): boolean {
  if (!strict) return admitHeavyTask('diagnostic:job');
  const snap = memorySnapshot();
  if (!snap.started) return true;
  const s = sampleNow() ?? snap.last;
  if (!s) return true;
  const level = pressureLevel(s, snap.settings);
  return level === 'ok' || level === 'unknown';
}

interface DrainOptions {
  workerId?: string;
  maxJobs?: number;
  onlyId?: string;
  /** Tests : stockage simulé, découpage, mesure mémoire. */
  storage?: DiagStorage;
  partRows?: number;
  batchRows?: number;
  rssMb?: () => number;
  /** Tests : renouvellement du bail plus fréquent. */
  heartbeatMs?: number;
  /** Tests (lot 111C) : lecture de l'annulation plus fréquente. */
  cancelPollMs?: number;
}

/** Traite les diagnostics en attente (rattrapage d'abord) ; rend les statuts écrits. */
export async function drainDiagnosticJobs(opts: DrainOptions = {}): Promise<Array<DiagJobStatus | null>> {
  const workerId = opts.workerId ?? DIAG_WORKER_ID;
  const settings = diagJobSettings();
  const { getBuildIdentity } = await import('@/lib/runtime-identity');
  const commit = getBuildIdentity().commit;
  const limit = containerMemoryLimitMb();
  const rec = await recoverDiagnosticJobs();
  // Lot 111C : demandes closes par le rattrapage (annulées pendant l'arrêt du processus, tentatives
  // épuisées) — plus aucune tentative ne nettoiera leurs fichiers : supprimés ici.
  if (rec.cancelled.length || rec.failed.length) {
    const st = opts.storage ?? await defaultPurgeStorage();
    if (st) for (const id of [...rec.cancelled, ...rec.failed]) await purgeDiagnosticPrefix(st, `${DIAG_JOB_PREFIX}${id}/`);
  }
  const out: Array<DiagJobStatus | null> = [];
  const maxJobs = opts.maxJobs ?? 1;
  while (out.length < maxJobs) {
    // Lot 109H : mémoire du conteneur au-delà du seuil d'admission → le
    // diagnostic attend le tour suivant (au plus MEMORY_ADMISSION_MAX_WAIT_MS ;
    // lot 111C, mode `auto` : sans départ forcé).
    if (!opts.onlyId && !admitDiagnostic(settings.memoryGate === 'strict')) { state().waitReason = 'MEMORY_ADMISSION'; break; }
    const { job, blocked } = await claimNextDiagnosticJobDetailed(workerId, commit, { onlyId: opts.onlyId });
    if (!job) { if (!opts.onlyId) state().waitReason = blocked ?? 'NO_ELIGIBLE_JOB'; break; }
    Object.assign(state(), { currentJobId: job.id, lastClaimAt: new Date().toISOString(), lastClaimJobId: job.id, waitReason: 'PROCESSING' });
    if (!opts.onlyId) void beat();
    console.info(`[diagnostic-job] ${JSON.stringify({ event: 'claimed', jobId: job.id, attempt: job.attempt, maxAttempts: job.maxAttempts, scope: job.request.scope, targetId: job.request.id, reinforced: job.request.reinforced, worker: workerId.split(':').slice(0, 2).join(':'), commit })}`);
    let active = true;
    let cancel = false;
    const progress = emptyProgress(limit);
    sampleMemory(progress, opts.rssMb);
    const startedAt = Date.now();
    const beatMs = opts.heartbeatMs ?? Math.max(5_000, (settings.leaseSeconds * 1000) / 3);
    const heartbeat = setInterval(() => {
      // Plafond : au-delà du délai global (+ 1 min), plus de renouvellement — le bail finit par expirer.
      if (Date.now() - startedAt > settings.timeoutMs + 60_000) { active = false; clearInterval(heartbeat); return; }
      sampleMemory(progress, opts.rssMb);
      void renewDiagnosticLease(job.id, workerId, progress).then((r) => { if (!r.ok) active = false; if (r.cancel) cancel = true; }).catch(() => undefined);
    }, beatMs);
    heartbeat.unref?.();
    try {
      const status = await trackMemory('diagnostic:job', () => runDiagnosticJob(job, {
        workerId, isActive: () => active, cancelRequested: () => cancel, deadline: startedAt + settings.timeoutMs, progress,
        storage: opts.storage, partRows: opts.partRows, batchRows: opts.batchRows, rssMb: opts.rssMb, cancelPollMs: opts.cancelPollMs,
      })).catch((e) => { console.error(`[diagnostic-job] ${job.id} : erreur inattendue du worker :`, sanitizeErrorMessage(e)); return null; });
      out.push(status);
      state().processed++;
    } finally {
      clearInterval(heartbeat);
      state().currentJobId = null;
    }
  }
  return out;
}

async function defaultPurgeStorage(): Promise<DiagStorage | null> {
  try {
    const { isS3Configured, getS3Client, getS3Bucket } = await import('@/lib/s3-config');
    return isS3Configured() ? { client: getS3Client('worker'), bucket: getS3Bucket() } : null;
  } catch { return null; }
}

/** Archives expirées (rétention) : fichiers supprimés du stockage, historique conservé. */
export async function purgeExpiredDiagnosticJobs(storage?: DiagStorage): Promise<number> {
  const jobs = await expiredDiagnosticJobs();
  if (!jobs.length) return 0;
  let st = storage;
  if (!st) {
    const { isS3Configured, getS3Client, getS3Bucket } = await import('@/lib/s3-config');
    if (!isS3Configured()) return 0;
    st = { client: getS3Client('worker'), bucket: getS3Bucket() };
  }
  let n = 0;
  for (const j of jobs) {
    const root = `${DIAG_JOB_PREFIX}${j.id}/`;
    await purgeDiagnosticPrefix(st, root);
    await markDiagnosticJobPurged(j.id);
    n++;
  }
  return n;
}

async function tick(): Promise<void> {
  const st = state();
  if (st.running) { st.again = true; return; }
  st.running = true;
  st.tickRunningSince = new Date().toISOString();
  const hadError = st.lastTickError !== null;
  try {
    do {
      st.again = false;
      st.lastTickAt = new Date().toISOString();
      await drainDiagnosticJobs();
      if (Date.now() - st.lastPurgeAt > 60 * 60_000) {
        st.lastPurgeAt = Date.now();
        await purgeExpiredDiagnosticJobs().catch((e) => console.error('[diagnostic-job] purge des archives expirées impossible :', sanitizeErrorMessage(e)));
      }
    } while (st.again);
    st.lastTickError = null;
    st.lastTickOkAt = new Date().toISOString();
    if (hadError) console.info('[diagnostic-job] tour du worker rétabli.');
  } catch (e) {
    st.lastTickError = sanitizeErrorMessage(e);
    st.lastTickErrorAt = new Date().toISOString();
    st.waitReason = 'LOOP_ERROR';
    console.error('[diagnostic-job] tour du worker en échec (non bloquant) :', st.lastTickError);
  } finally {
    st.running = false;
    st.tickRunningSince = null;
    // Lot 111C : un changement d'état (erreur ↔ rétabli) est écrit tout de suite ; le reste au battement (30 s).
    if (hadError !== (st.lastTickError !== null)) void beat();
  }
}

/** Réveille le worker de ce processus (sans effet s'il n'est pas démarré ici). */
export function nudgeDiagnosticWorker(): void {
  if (state().started) void tick();
}

export function startDiagnosticWorker(): void {
  const st = state();
  if (st.started) return;
  const s = diagJobSettings();
  const disabled = workerDisabledReason();
  if (disabled) {
    st.disabledReason = disabled;
    st.mode = 'DISABLED';
    // Lot 111C : la désactivation est écrite en base (BO, superviseur) — plus seulement journalisée au démarrage.
    startPresence();
    console.warn(`[diagnostic-job] worker désactivé (${disabled}=true) : aucun diagnostic ne sera produit par ce processus ; les demandes resteront en attente « worker désactivé » (voir docs/exploitation/recette-111c-diagnostic-global.md).`);
    return;
  }
  st.started = true;
  st.mode = 'STARTED';
  st.startedAt = new Date().toISOString();
  startPresence();
  // Premier tour différé : migrations et référentiels se mettent en place au démarrage ; les orphelins sont rattrapés au premier tour.
  setTimeout(() => void tick(), 15_000).unref?.();
  st.timer = setInterval(() => void tick(), s.intervalMs);
  st.timer.unref?.();
  console.info(`[diagnostic-job] worker démarré (${DIAG_WORKER_ID.split(':').slice(0, 2).join(':')}) — un diagnostic à la fois, concurrence globale ${s.globalConcurrency}, tour toutes les ${s.intervalMs / 1000} s${s.memoryGate === 'strict' ? ', mode auto (départ seulement sous le seuil d’admission mémoire)' : ''}.`);
}
