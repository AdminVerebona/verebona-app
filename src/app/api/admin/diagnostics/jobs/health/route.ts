import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { guardAdmin, NO_STORE } from '../../../ops/_shared';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/diagnostics/jobs/health — lot 107G : SANTÉ DU MOTEUR DE
 * DIAGNOSTIC, sans générer de diagnostic (requêtes légères seulement).
 *
 *   · worker DE L'INSTANCE qui répond : démarré / désactivé (motif), dernier
 *     tour, travail en cours, dernière erreur de tour ;
 *   · file : travaux par statut, âge du plus ancien en attente, travaux en
 *     cours (étape, tentative, bail, progression, mémoire), orphelins (bail
 *     expiré), 10 dernières erreurs (code stable, étape, horodatage,
 *     tentatives et worker) ;
 *   · processus : mémoire (RSS, tas), limite du conteneur, seuil de garde ;
 *   · version exécutée (commit), stockage configuré, migration 1035.
 *
 * Lot 111C : `workers` — battements PERSISTÉS de TOUS les processus (worker
 * démarré, désactivé avec la variable en cause, absent de ce processus selon
 * BACKGROUND_JOBS_PROCESS ; dernier tour, dernier prélèvement, raison
 * d'attente, erreur, version) ; `waits` — raison d'attente de chaque demande
 * en file. `worker` reste l'état de l'instance qui répond (libellé comme tel).
 *
 * Aucune donnée de compte, aucun secret : messages assainis. Administrateurs
 * seulement ; jamais mis en cache.
 */
export async function GET(request: NextRequest) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  const [{ diagnosticQueueHealth }, { diagnosticWorkerState }, runner, st, { getBuildIdentity }, { isS3Configured }] = await Promise.all([
    import('@/services/admin/diagnostic-jobs/repository'), import('@/services/admin/diagnostic-jobs/worker'), import('@/services/admin/diagnostic-jobs/runner'),
    import('@/services/admin/diagnostic-jobs/state'), import('@/lib/runtime-identity'), import('@/lib/s3-config'),
  ]);
  const m = process.memoryUsage();
  const limit = runner.containerMemoryLimitMb();
  const settings = st.diagJobSettings();
  const build = getBuildIdentity();
  const base = {
    checkedAt: new Date().toISOString(),
    build: { version: build.version, commit: build.commit, container: build.container },
    worker: diagnosticWorkerState(),
    process: {
      rssMb: Math.round(m.rss / 1024 / 1024), heapUsedMb: Math.round(m.heapUsed / 1024 / 1024), heapTotalMb: Math.round(m.heapTotal / 1024 / 1024),
      containerLimitMb: limit, guardMb: st.memoryGuardMb(settings.maxRssMb, limit), uptimeSeconds: Math.round(process.uptime()),
    },
    storageConfigured: isS3Configured(),
    settings: { maxAttempts: settings.maxAttempts, leaseSeconds: settings.leaseSeconds, timeoutMinutes: Math.round(settings.timeoutMs / 60_000), globalConcurrency: settings.globalConcurrency, retentionDays: settings.retentionDays },
    syncHttpEnabled: process.env.DIAG_SYNC_HTTP === 'on',
  };
  try {
    const queue = await diagnosticQueueHealth();
    const alerts: string[] = [];
    if (queue.migrationApplied === false) alerts.push('MIGRATION_MISSING : migrations 1035 / 1200 non appliquées — aucun diagnostic durable possible.');
    if (!base.storageConfigured) alerts.push('STORAGE_UNAVAILABLE : stockage OVH non configuré — les diagnostics échoueront.');
    // Lot 111C : état du worker lu dans les battements de TOUTES les instances (et plus seulement celle qui répond).
    const sup = await import('@/services/admin/diagnostic-jobs/supervision');
    const q = queue.migrationApplied === false ? { waits: [], beats: null, aliveWorkers: 0 } : await sup.diagnosticQueueWaits().catch(() => ({ waits: [], beats: null, aliveWorkers: 0 }));
    if (q.beats === null && queue.migrationApplied !== false) alerts.push('HEARTBEATS_UNAVAILABLE : battements du worker illisibles (migration 1200 non appliquée ?).');
    if (q.beats && q.aliveWorkers === 0) alerts.push('NO_LIVE_WORKER : aucun worker de diagnostics vivant sur l’ensemble des instances.');
    for (const b of (q.beats ?? []).filter((x) => x.state === 'DISABLED')) alerts.push(`WORKER_DISABLED : worker désactivé sur ${b.instanceId.split(':').slice(0, 2).join(':')} (${b.disabledReason}).`);
    if (!q.beats && base.worker.disabledReason) alerts.push(`WORKER_DISABLED : worker désactivé sur cette instance (${base.worker.disabledReason}).`);
    for (const w of q.waits) if (w.diagnosis.alert) alerts.push(`QUEUE_STALLED (${w.diagnosis.reason}) : diagnostic ${w.jobId.slice(0, 8)} — ${w.label}, depuis ${Math.round(w.diagnosis.waitedSeconds / 60)} min. ${w.action}`);
    if (q.waits.some((w) => w.diagnosis.alert)) void sup.superviseDiagnosticQueue();
    for (const r of (queue.running as Array<{ id: string; leaseExpired: boolean }> | undefined) ?? []) if (r.leaseExpired) alerts.push(`WORKER_LOST : diagnostic ${r.id.slice(0, 8)} sans signe de vie (bail expiré) — repris ou clos au prochain tour.`);
    if (Number(queue.legacyRunning ?? 0) > 0) alerts.push(`LEGACY_HTTP_INTERRUPTED : ${queue.legacyRunning} génération(s) de l’ancien moteur restée(s) « en cours » — closes automatiquement après 2 h.`);
    const { isBeatAlive } = await import('@/services/admin/diagnostic-jobs/wait');
    const workers = (q.beats ?? []).map((b) => ({
      instance: b.instanceId.split(':').slice(0, 2).join(':'), process: b.processType, placement: b.placement, state: b.state, disabledReason: b.disabledReason,
      alive: isBeatAlive(b, new Date()), seenAt: b.seenAt, startedAt: b.startedAt, lastTickAt: b.lastTickAt, lastTickOkAt: b.lastTickOkAt,
      tickRunningSince: b.tickRunningSince, lastClaimAt: b.lastClaimAt, lastClaimJobId: b.lastClaimJobId, currentJobId: b.currentJobId, waitReason: b.waitReason,
      lastError: b.lastError, lastErrorAt: b.lastErrorAt, commit: b.buildCommit, version: b.buildVersion, memoryLevel: b.memoryLevel, rssMb: b.rssMb, containerLimitMb: b.containerLimitMb,
    }));
    const waits = q.waits.map((w) => ({ jobId: w.jobId, scope: w.scope, startedAt: w.startedAt, reason: w.diagnosis.reason, label: w.label, detail: w.diagnosis.detail, action: w.action, waitedSeconds: w.diagnosis.waitedSeconds, alert: w.diagnosis.alert, blockingJobId: w.diagnosis.blockingJobId }));
    return NextResponse.json({ ...base, queue, workers, waits, alerts }, { headers: NO_STORE });
  } catch (e) {
    return NextResponse.json({ ...base, queue: null, alerts: [`QUEUE_UNREADABLE : ${st.sanitizeErrorMessage(e)}`] }, { headers: NO_STORE });
  }
}
