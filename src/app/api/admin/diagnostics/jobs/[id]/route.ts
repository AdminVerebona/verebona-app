import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { guardAdmin, NO_STORE } from '../../../ops/_shared';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/diagnostics/jobs/:id — lot 107G : un diagnostic durable
 * (statut, phase, progression, tentatives et leur historique, dernière
 * erreur avec code stable et étape, bilan par section, archive disponible).
 * `report=1` : le RAPPORT SYNTHÉTIQUE stocké (`rapport.txt`) — le vrai texte
 * produit avec l'archive, pas une reconstitution ; les données complètes
 * sont dans le ZIP. Administrateurs seulement ; jamais mis en cache.
 *
 * Lot 111Q : `metrics` (temps en file / exécution / total, séparés),
 * `category` (« Attente de ressource », « Worker indisponible », « Génération
 * en cours », « Échec », « Terminé », « Annulé », « En file »), `timings`
 * (profilage par étape, fichiers les plus lents), `workerView` (worker qui
 * exécute ou dernier worker vivant : battement, dernier tour, prélèvement),
 * `firstRunStartedAt`, `lane`, `readAt` (horodatage serveur de la lecture).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  const { id } = await params;
  const [{ getGeneration }, st] = await Promise.all([import('@/services/admin/export-generations'), import('@/services/admin/diagnostic-jobs/state')]);
  const job = await getGeneration(id).catch(() => null);
  if (!job || job.kind !== 'TECH_DIAGNOSTIC') return NextResponse.json({ error: 'Diagnostic introuvable.', code: 'NOT_FOUND' }, { status: 404, headers: NO_STORE });
  const downloadable = job.mode === st.DIAG_JOB_MODE && (job.status === 'COMPLETE' || job.status === 'PARTIAL') && !job.purgedAt && !!job.storagePrefix;
  const status = job.status as import('@/services/admin/diagnostic-jobs/state').DiagJobStatus;
  // Lot 111C : raison d'attente (battements persistés de toutes les instances) et statut explicite.
  const sup = job.mode === st.DIAG_JOB_MODE && job.status === 'QUEUED' && !job.cancelRequested ? await import('@/services/admin/diagnostic-jobs/supervision') : null;
  const wait = sup ? await sup.diagnosticJobWait(job.id) : null;
  const { displayStatus } = await import('@/services/admin/diagnostic-jobs/wait');
  const [mx, repo] = await Promise.all([import('@/services/admin/diagnostic-jobs/metrics'), import('@/services/admin/diagnostic-jobs/repository')]);
  const extras = job.mode === st.DIAG_JOB_MODE ? await repo.readDiagnosticJobExtras(job.id).catch(() => ({ firstRunStartedAt: null, lane: null, phaseTimings: null })) : { firstRunStartedAt: null, lane: null, phaseTimings: null };
  const now = new Date();
  const metrics = mx.diagMetrics({
    status: job.status, startedAt: job.startedAt, firstRunStartedAt: extras.firstRunStartedAt, runStartedAt: job.runStartedAt, finishedAt: job.finishedAt,
    attemptsLog: job.attemptsLog as Array<{ startedAt?: string | null; endedAt?: string | null }>, now,
  });
  const category = mx.stateCategory(job.status, wait?.diagnosis.reason ?? job.waitReason, job.cancelRequested && job.status === 'QUEUED');
  const workerView = job.mode === st.DIAG_JOB_MODE && (job.status === 'QUEUED' || job.status === 'RUNNING')
    ? await (sup ?? await import('@/services/admin/diagnostic-jobs/supervision')).diagnosticJobWorkerView(job, now)
    : null;
  const view = {
    job,
    readAt: now.toISOString(),
    metrics,
    category: { code: category, label: mx.DIAG_STATE_CATEGORY_LABELS[category] },
    firstRunStartedAt: extras.firstRunStartedAt ?? metrics.firstStartAt,
    lane: extras.lane,
    timings: extras.phaseTimings,
    workerView,
    statusLabel: displayStatus(job, wait?.diagnosis ?? null),
    wait: wait ? { reason: wait.diagnosis.reason, label: wait.label, detail: wait.diagnosis.detail, action: wait.action, blockingJobId: wait.diagnosis.blockingJobId, waitedSeconds: wait.diagnosis.waitedSeconds, alert: wait.diagnosis.alert } : null,
    downloadable,
    phaseLabel: job.phase ? st.DIAG_JOB_PHASE_LABELS[job.phase as keyof typeof st.DIAG_JOB_PHASE_LABELS] ?? job.phase : null,
    errorLabel: job.errorCode ? st.DIAG_JOB_ERROR_LABELS[job.errorCode as keyof typeof st.DIAG_JOB_ERROR_LABELS] ?? null : null,
    progressPercent: st.progressPercent(job.progress as never, status),
  };
  if (request.nextUrl.searchParams.get('report') !== '1') return NextResponse.json(view, { headers: NO_STORE });
  if (!downloadable) return NextResponse.json({ ...view, report: null, reportError: 'Rapport disponible quand la génération est terminée (COMPLETE ou PARTIAL) et non purgée.' }, { headers: NO_STORE });
  try {
    const [{ getS3Client, getS3Bucket }, { GetObjectCommand }, { gunzipSync }] = await Promise.all([import('@/lib/s3-config'), import('@aws-sdk/client-s3'), import('node:zlib')]);
    const o = await getS3Client('worker').send(new GetObjectCommand({ Bucket: getS3Bucket(), Key: `${job.storagePrefix}rapport.txt.gz` })) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };
    const report = gunzipSync(Buffer.from(await o.Body!.transformToByteArray())).toString('utf8');
    return NextResponse.json({ ...view, report }, { headers: NO_STORE });
  } catch (e) {
    console.error('[diagnostic-job] rapport illisible :', st.sanitizeErrorMessage(e));
    return NextResponse.json({ ...view, report: null, reportError: 'Rapport illisible dans le stockage (code DOWNLOAD_FAILED).' }, { headers: NO_STORE });
  }
}
