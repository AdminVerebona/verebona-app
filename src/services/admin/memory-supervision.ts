/**
 * Supervision mémoire — lot 109H.
 *
 *  · Pression mémoire d'un conteneur (au-delà de MEMORY_ALERT_PERCENT de sa
 *    limite sur deux échantillons) → anomalie « Autres traitements
 *    techniques », une par type de processus (web, worker), consolidée ;
 *    résolue automatiquement après 30 min sous le seuil d'admission.
 *  · Séparation web / worker activée (BACKGROUND_JOBS_PROCESS=worker) sans
 *    conteneur worker vivant → anomalie « aucun conteneur worker » (les
 *    analyses, exports, diagnostics et tâches planifiées ne tourneraient
 *    plus) ; résolue dès qu'un worker bat de nouveau.
 *
 * Détail sans secret : tailles, pourcentages, codes de tâche, conteneur.
 * Ne lève jamais.
 */
import { autoResolveAnomaly, buildFingerprint, reportAnomaly } from '@/services/admin/anomaly.service';
import type { AlertContext, MemorySample } from '@/lib/runtime/memory-monitor';

const GUIDE = 'docs/exploitation/memoire-scalingo-109h.md';

export const memoryFingerprint = (processType: string): string => buildFingerprint('other', 'memory', processType);
export const NO_WORKER_FINGERPRINT = buildFingerprint('other', 'background-jobs', 'no-worker');

export async function reportMemoryPressure(s: MemorySample, ctx: AlertContext, container: string | null = (process.env.CONTAINER ?? '').trim() || null): Promise<void> {
  await reportAnomaly({
    domain: 'other',
    fingerprint: memoryFingerprint(ctx.processType),
    title: `Mémoire du conteneur ${ctx.processType} à ${ctx.percent ?? '?'} % de sa limite`,
    detail: {
      container,
      processType: ctx.processType,
      usedMb: s.containerUsedMb ?? s.rssMb,
      measuredOn: s.containerUsedMb != null ? 'conteneur (cgroup)' : 'processus (rss)',
      limitMb: s.containerLimitMb,
      limitSource: s.limitSource,
      rssMb: s.rssMb,
      heapUsedMb: s.heapUsedMb,
      heapLimitMb: s.heapLimitMb,
      activeTasks: ctx.activeTasks,
      topTaskPeaks: ctx.topPeaks.map((p) => ({ kind: p.kind, maxPeakMb: p.maxPeakUsedMb, maxDeltaMb: p.maxDeltaMb, runs: p.runs })),
      action: `Voir ${GUIDE} : taille du conteneur, AI_QUEUE_CONCURRENCY, séparation web / worker.`,
    },
  }).catch(() => null);
}

export async function resolveMemoryPressure(s: MemorySample, ctx: AlertContext): Promise<void> {
  await autoResolveAnomaly(memoryFingerprint(ctx.processType), {
    origin: 'memory_monitor',
    cause: `Retour sous le seuil : ${s.containerUsedMb ?? s.rssMb} Mo / ${s.containerLimitMb ?? '?'} Mo`,
  });
}

/**
 * Séparation activée : un worker vivant (battement de la file IA, toutes
 * instances) ? Rend l'état constaté. `list` injectable (tests).
 */
export async function checkBackgroundWorkerPresence(deps: {
  list?: () => Promise<Array<{ lastTickAt: Date; intervalMs: number }> | null>;
  now?: () => Date;
} = {}): Promise<'ok' | 'missing' | 'unknown'> {
  try {
    const hb = await import('@/services/ai/queue/worker-heartbeat');
    const rows = await (deps.list ?? hb.listWorkerHeartbeats)();
    if (rows === null) return 'unknown';
    const now = (deps.now ?? (() => new Date()))();
    const alive = rows.some((r) => hb.isWorkerAlive(r, now));
    if (!alive) {
      await reportAnomaly({
        domain: 'other',
        fingerprint: NO_WORKER_FINGERPRINT,
        title: 'Aucun conteneur worker actif alors que les traitements de fond lui sont confiés',
        detail: {
          setting: 'BACKGROUND_JOBS_PROCESS=worker',
          effect: 'Analyses, exports, diagnostics, sauvegarde et tâches planifiées en attente.',
          action: `Dans Scalingo : passer le type « worker » à 1 conteneur, ou retirer BACKGROUND_JOBS_PROCESS (retour au conteneur web). Voir ${GUIDE}.`,
        },
      });
      return 'missing';
    }
    await autoResolveAnomaly(NO_WORKER_FINGERPRINT, { origin: 'memory_supervision', cause: 'Conteneur worker de nouveau actif' });
    return 'ok';
  } catch (e) {
    console.error('[memory] contrôle de présence du worker impossible :', (e as Error).message);
    return 'unknown';
  }
}
