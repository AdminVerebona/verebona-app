/**
 * Boucle d'exécution des générations V12 — une par instance, UNE génération
 * à la fois (le rendu Chromium est le poste le plus coûteux en mémoire).
 *
 * Démarrée par `instrumentation-node.ts` ; réveillée par la création d'une
 * génération (`nudgeExportWorker`) pour ne pas attendre le tour suivant.
 * Plusieurs instances se partagent la file sans coordination
 * (`FOR UPDATE SKIP LOCKED`) ; chaque génération tient un bail renouvelé :
 * un processus arrêté brutalement cesse de le renouveler et la génération est
 * reprise ailleurs (au plus `MAX_ATTEMPTS` fois).
 *
 * Aucune génération ne bloque le worker : délai global par exécution
 * (`EXPORTS_JOB_TIMEOUT_MS`, 10 min) — au-delà, la génération est close en
 * échec (RENDER_TIMEOUT), l'exécution est avertie par son signal et le worker
 * passe à la suivante. Le battement de cœur s'arrête lui aussi après ce délai
 * (plus une marge) : même si la clôture échoue, le bail finit par expirer.
 *
 * `EXPORTS_WORKER_DISABLED=true` : aucune génération sur cette instance
 * (instance web dédiée, par exemple).
 *
 * Lot 111B : une génération REMPLACÉE par une régénération explicite est
 * observée pendant son exécution (interrogation légère de
 * `cancel_requested_at`, `EXPORTS_CANCEL_POLL_MS`, 2 s) : signal d'abandon
 * levé (rendu Chromium, téléchargements, envois OVH), arrêt coopératif du
 * job (statut `cancelled`, bail libéré, temporaires et objets non publiés
 * nettoyés). Si une étape non interruptible retient l'exécution au-delà de
 * `EXPORTS_CANCEL_GRACE_MS` (30 s), le worker clôt l'annulation lui-même et
 * passe à la suite ; l'exécution résiduelle ne peut plus rien publier
 * (`updateOwnedGeneration`). Une génération à la fois par instance : la
 * nouvelle version démarre après l'arrêt effectif de l'ancienne.
 *
 * Lot 103C : la même boucle consomme aussi la file des archives RGPD
 * « Mes données » (`services/gdpr/gdpr-export.job.ts`) — une génération
 * lourde à la fois par instance, dossiers V12 et archives RGPD confondus
 * (borne mémoire) ; après chaque archive RGPD, la file V12 est revue.
 */

import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { claimNextGeneration, renewGenerationLease, isGenerationCancelRequested, markGenerationCancelled, LEASE_SECONDS } from './repository';
import { cancelGraceMs, cancelPollMs, CANCELLED_STEP_FORCED } from './identity';
import { runGeneration, failTimedOutGeneration, jobTimeoutMs } from './job';
import { admitHeavyTask, trackMemory } from '@/lib/runtime/memory-monitor';

const EXPORT_WORKER_ID = `${(() => { try { return hostname(); } catch { return 'local'; } })()}:${process.pid}:${randomUUID().slice(0, 8)}`;

interface WorkerState { started: boolean; running: boolean; again: boolean; timer: ReturnType<typeof setInterval> | null }
const KEY = Symbol.for('verebona.exports.v12.worker');
function state(): WorkerState {
  const g = globalThis as unknown as Record<symbol, WorkerState | undefined>;
  return (g[KEY] ??= { started: false, running: false, again: false, timer: null });
}

/** Traite les générations en attente jusqu'à épuisement de la file. */
export async function drainExportQueue(workerId = EXPORT_WORKER_ID): Promise<number> {
  let done = 0;
  for (;;) {
    // Lot 109H : mémoire du conteneur au-delà du seuil d'admission → la
    // génération attend le tour suivant (au plus MEMORY_ADMISSION_MAX_WAIT_MS).
    if (!admitHeavyTask('export:v12')) return done;
    const row = await claimNextGeneration(workerId);
    if (!row) return done;
    let active = true;
    const startedAt = Date.now();
    const timeoutMs = jobTimeoutMs();
    const controller = new AbortController();
    const heartbeat = setInterval(() => {
      // Plafond : au-delà du délai global (+ 1 min), plus de renouvellement.
      if (Date.now() - startedAt > timeoutMs + 60_000) { active = false; clearInterval(heartbeat); return; }
      void renewGenerationLease(row.id, workerId).then((ok) => { if (!ok) active = false; }).catch(() => undefined);
    }, Math.max(5_000, (LEASE_SECONDS * 1000) / 3));
    heartbeat.unref?.();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Lot 111B : observation de l'annulation (génération remplacée).
    let cancelled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let onGrace: ((v: 'cancel_grace') => void) | null = null;
    const grace = new Promise<'cancel_grace'>((resolve) => { onGrace = resolve; });
    const cancelWatch = setInterval(() => {
      if (cancelled) return;
      void isGenerationCancelRequested(row.id).then((c) => {
        if (!c || cancelled) return;
        cancelled = true;
        controller.abort();
        graceTimer = setTimeout(() => onGrace?.('cancel_grace'), cancelGraceMs());
        graceTimer.unref?.();
      }).catch(() => undefined);
    }, cancelPollMs());
    cancelWatch.unref?.();
    try {
      const run = trackMemory('export:v12', () => runGeneration(row, workerId, { isActive: () => active, isCancelled: () => cancelled, signal: controller.signal }))
        .catch((e) => { console.error(`[exports-v12] génération ${row.id} : erreur inattendue du worker :`, (e as Error).message); return 'failed' as const; });
      const outcome = await Promise.race([
        run,
        new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); timer.unref?.(); }),
        grace,
      ]);
      if (outcome === 'cancel_grace') {
        // Étape non interruptible trop longue : annulation close ici, plus aucune écriture de l'exécution.
        await markGenerationCancelled(row.id, workerId, CANCELLED_STEP_FORCED).catch(() => false);
        active = false;
        console.warn(`[exports-v12] génération ${row.id} : annulation close après ${cancelGraceMs()} ms d'attente de l'arrêt coopératif.`);
      } else if (outcome === 'timeout') {
        controller.abort();
        active = false;
        console.error(`[exports-v12] génération ${row.id} : délai global dépassé (${timeoutMs} ms), exécution abandonnée.`);
        await failTimedOutGeneration(row, workerId).catch(() => undefined);
      }
    } finally {
      clearTimeout(timer);
      clearTimeout(graceTimer);
      clearInterval(cancelWatch);
      clearInterval(heartbeat);
    }
    done++;
  }
}

/** Lot 103C : une génération RGPD « Mes données » (jamais bloquant pour la file V12). */
async function drainGdprExportsSafely(): Promise<number> {
  try {
    if (!admitHeavyTask('export:gdpr')) return 0;
    const { drainGdprExportQueue } = await import('@/services/gdpr/gdpr-export.job');
    return await trackMemory('export:gdpr', () => drainGdprExportQueue(EXPORT_WORKER_ID, { maxJobs: 1 }));
  } catch (e) {
    console.error('[exports-v12] file RGPD « Mes données » en échec (non bloquant) :', (e as Error).message);
    return 0;
  }
}

async function tick(): Promise<void> {
  const st = state();
  if (st.running) { st.again = true; return; }
  st.running = true;
  try {
    do {
      st.again = false;
      await drainExportQueue();
      // Lot 103C : une archive RGPD par passage, puis retour à la file V12.
      if ((await drainGdprExportsSafely()) > 0) st.again = true;
    } while (st.again);
  } catch (e) {
    console.error('[exports-v12] tour du worker en échec (non bloquant) :', (e as Error).message);
  } finally {
    st.running = false;
  }
}

/** Réveille le worker de ce processus (sans effet s'il n'est pas démarré ici). */
export function nudgeExportWorker(): void {
  if (state().started) void tick();
}

export function startExportWorker(): void {
  const st = state();
  if (st.started) return;
  if (process.env.EXPORTS_WORKER_DISABLED === 'true') {
    console.info('[exports-v12] worker désactivé (EXPORTS_WORKER_DISABLED=true).');
    return;
  }
  st.started = true;
  const n = Number(process.env.EXPORTS_WORKER_INTERVAL_MS);
  const interval = Number.isFinite(n) && n >= 1_000 ? n : 10_000;
  // Premier tour différé : migrations et référentiels se mettent en place au démarrage.
  setTimeout(() => void tick(), 20_000).unref?.();
  st.timer = setInterval(() => void tick(), interval);
  st.timer.unref?.();
  console.info(`[exports-v12] worker démarré (${EXPORT_WORKER_ID}) — une génération à la fois, tour toutes les ${interval / 1000} s.`);
}
