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
  const view = {
    job,
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
