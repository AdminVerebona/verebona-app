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
 */
import { admitHeavyTask, trackMemory } from '@/lib/runtime/memory-monitor';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DIAG_JOB_PREFIX, diagJobSettings, sanitizeErrorMessage, type DiagJobStatus } from './state';
import {
  claimNextDiagnosticJob, expiredDiagnosticJobs, markDiagnosticJobPurged, recoverDiagnosticJobs, renewDiagnosticLease,
} from './repository';
import { containerMemoryLimitMb, deletePrefix, emptyProgress, runDiagnosticJob, sampleMemory, type DiagStorage } from './runner';

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
}
const KEY = Symbol.for('verebona.admin.diagnostic-jobs.worker');
function state(): WorkerState {
  const g = globalThis as unknown as Record<symbol, WorkerState | undefined>;
  return (g[KEY] ??= { started: false, running: false, again: false, timer: null, startedAt: null, lastTickAt: null, lastTickError: null, currentJobId: null, lastPurgeAt: 0, disabledReason: null, processed: 0 });
}

/** État du worker DE CETTE INSTANCE (observabilité ; aucun secret). */
export function diagnosticWorkerState(): Omit<WorkerState, 'timer' | 'again' | 'lastPurgeAt'> & { workerId: string } {
  const { timer: _t, again: _a, lastPurgeAt: _p, ...rest } = state();
  return { ...rest, workerId: DIAG_WORKER_ID.split(':').slice(0, 2).join(':') };
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
}

/** Traite les diagnostics en attente (rattrapage d'abord) ; rend les statuts écrits. */
export async function drainDiagnosticJobs(opts: DrainOptions = {}): Promise<Array<DiagJobStatus | null>> {
  const workerId = opts.workerId ?? DIAG_WORKER_ID;
  const settings = diagJobSettings();
  const { getBuildIdentity } = await import('@/lib/runtime-identity');
  const commit = getBuildIdentity().commit;
  const limit = containerMemoryLimitMb();
  await recoverDiagnosticJobs();
  const out: Array<DiagJobStatus | null> = [];
  const maxJobs = opts.maxJobs ?? 1;
  while (out.length < maxJobs) {
    // Lot 109H : mémoire du conteneur au-delà du seuil d'admission → le
    // diagnostic attend le tour suivant (au plus MEMORY_ADMISSION_MAX_WAIT_MS).
    if (!opts.onlyId && !admitHeavyTask('diagnostic:job')) break;
    const job = await claimNextDiagnosticJob(workerId, commit, { onlyId: opts.onlyId });
    if (!job) break;
    state().currentJobId = job.id;
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
        storage: opts.storage, partRows: opts.partRows, batchRows: opts.batchRows, rssMb: opts.rssMb,
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
    await deletePrefix(st, root);
    await markDiagnosticJobPurged(j.id);
    n++;
  }
  return n;
}

async function tick(): Promise<void> {
  const st = state();
  if (st.running) { st.again = true; return; }
  st.running = true;
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
  } catch (e) {
    st.lastTickError = sanitizeErrorMessage(e);
    console.error('[diagnostic-job] tour du worker en échec (non bloquant) :', st.lastTickError);
  } finally {
    st.running = false;
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
  if (s.disabled || process.env.EXPORTS_WORKER_DISABLED === 'true') {
    st.disabledReason = s.disabled ? 'DIAG_JOB_WORKER_DISABLED=true' : 'EXPORTS_WORKER_DISABLED=true';
    console.info(`[diagnostic-job] worker désactivé (${st.disabledReason}).`);
    return;
  }
  st.started = true;
  st.startedAt = new Date().toISOString();
  // Premier tour différé : migrations et référentiels se mettent en place au démarrage ; les orphelins sont rattrapés au premier tour.
  setTimeout(() => void tick(), 15_000).unref?.();
  st.timer = setInterval(() => void tick(), s.intervalMs);
  st.timer.unref?.();
  console.info(`[diagnostic-job] worker démarré (${DIAG_WORKER_ID.split(':').slice(0, 2).join(':')}) — un diagnostic à la fois, concurrence globale ${s.globalConcurrency}, tour toutes les ${s.intervalMs / 1000} s.`);
}
