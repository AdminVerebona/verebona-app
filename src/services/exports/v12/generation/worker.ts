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
 */

import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { claimNextGeneration, renewGenerationLease, LEASE_SECONDS } from './repository';
import { runGeneration, failTimedOutGeneration, jobTimeoutMs } from './job';

export const EXPORT_WORKER_ID = `${(() => { try { return hostname(); } catch { return 'local'; } })()}:${process.pid}:${randomUUID().slice(0, 8)}`;

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
    try {
      const run = runGeneration(row, workerId, { isActive: () => active, signal: controller.signal })
        .catch((e) => { console.error(`[exports-v12] génération ${row.id} : erreur inattendue du worker :`, (e as Error).message); return 'failed' as const; });
      const outcome = await Promise.race([
        run,
        new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); timer.unref?.(); }),
      ]);
      if (outcome === 'timeout') {
        controller.abort();
        active = false;
        console.error(`[exports-v12] génération ${row.id} : délai global dépassé (${timeoutMs} ms), exécution abandonnée.`);
        await failTimedOutGeneration(row, workerId).catch(() => undefined);
      }
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
    }
    done++;
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
