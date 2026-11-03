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
    if (queue.migrationApplied === false) alerts.push('MIGRATION_MISSING : migration 1035 non appliquée — aucun diagnostic durable possible.');
    if (!base.storageConfigured) alerts.push('STORAGE_UNAVAILABLE : stockage OVH non configuré — les diagnostics échoueront.');
    if (base.worker.disabledReason) alerts.push(`WORKER_DISABLED : worker désactivé sur cette instance (${base.worker.disabledReason}).`);
    const age = queue.oldestQueuedAgeSeconds as number | null | undefined;
    if (age != null && age > 300) alerts.push(`QUEUE_STALLED : un diagnostic attend depuis ${Math.round(age / 60)} min — aucun worker ne le prend (instance arrêtée, worker désactivé ou diagnostic déjà en cours).`);
    for (const r of (queue.running as Array<{ id: string; leaseExpired: boolean }> | undefined) ?? []) if (r.leaseExpired) alerts.push(`WORKER_LOST : diagnostic ${r.id.slice(0, 8)} sans signe de vie (bail expiré) — repris ou clos au prochain tour.`);
    if (Number(queue.legacyRunning ?? 0) > 0) alerts.push(`LEGACY_HTTP_INTERRUPTED : ${queue.legacyRunning} génération(s) de l’ancien moteur restée(s) « en cours » — closes automatiquement après 2 h.`);
    return NextResponse.json({ ...base, queue, alerts }, { headers: NO_STORE });
  } catch (e) {
    return NextResponse.json({ ...base, queue: null, alerts: [`QUEUE_UNREADABLE : ${st.sanitizeErrorMessage(e)}`] }, { headers: NO_STORE });
  }
}
