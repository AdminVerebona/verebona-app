import { NextRequest, NextResponse } from 'next/server';
import { getSession, requireAdmin } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { guardAdmin, NO_STORE } from '../../../../ops/_shared';

export const dynamic = 'force-dynamic';
export const maxDuration = 900;

/**
 * GET /api/admin/diagnostics/jobs/:id/download — lot 107G.
 *
 *   sans paramètre → archive ZIP complète, assemblée EN FLUX depuis les
 *          fichiers stockés de la génération publiée (rien n'est régénéré ;
 *          une coupure ne touche pas l'archive stockée : relancer suffit) ;
 *   `path=<fichier>` → redirection vers une URL signée de courte durée
 *          (fichier `.json.gz`), pour un chemin de l'index d'intégrité.
 *
 * Seule une génération COMPLETE ou PARTIAL, non purgée, est téléchargeable
 * (jamais un résultat FAILED). Droits revérifiés à chaque demande ;
 * journalisé (`TECH_DIAGNOSTIC_DOWNLOAD`) ; jamais mis en cache.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  const { id } = await params;
  const path = request.nextUrl.searchParams.get('path');
  const adminEmail = await getSession(request).then((s) => (typeof s?.email === 'string' ? s.email : undefined), () => undefined);
  const audit = (result: 'SUCCESS' | 'FAILURE' | 'DENIED', details: Record<string, unknown>) => logAdminAction({
    adminId: g.adminId, adminEmail, action: 'TECH_DIAGNOSTIC_DOWNLOAD', targetType: 'TECH_DIAGNOSTIC', targetId: null, result,
    details: { jobId: id, path, ...details },
  });
  const [{ getGeneration }, st] = await Promise.all([import('@/services/admin/export-generations'), import('@/services/admin/diagnostic-jobs/state')]);
  const job = await getGeneration(id).catch(() => null);
  if (!job || job.kind !== 'TECH_DIAGNOSTIC' || job.mode !== st.DIAG_JOB_MODE) return NextResponse.json({ error: 'Diagnostic introuvable.', code: 'NOT_FOUND' }, { status: 404, headers: NO_STORE });
  if (job.status !== 'COMPLETE' && job.status !== 'PARTIAL') {
    await audit('FAILURE', { code: 'NOT_READY', status: job.status });
    return NextResponse.json({ error: `Archive indisponible : génération ${job.status}.`, code: 'NOT_READY' }, { status: 409, headers: NO_STORE });
  }
  if (job.purgedAt || !job.storagePrefix) {
    await audit('FAILURE', { code: 'PURGED' });
    return NextResponse.json({ error: 'Archive purgée (rétention dépassée) : relancez la génération.', code: 'PURGED' }, { status: 410, headers: NO_STORE });
  }
  const [{ isS3Configured, getS3Client, getS3Bucket }, dl] = await Promise.all([import('@/lib/s3-config'), import('@/services/admin/diagnostic-jobs/download')]);
  if (!isS3Configured()) return NextResponse.json({ error: 'Stockage OVH non configuré.', code: 'STORAGE_UNAVAILABLE' }, { status: 503, headers: NO_STORE });
  const storage = { client: getS3Client('worker'), bucket: getS3Bucket() };
  const index = await dl.readStoredIndex(storage, job.storagePrefix).catch((e) => { console.error('[diagnostic-job] index illisible :', st.sanitizeErrorMessage(e)); return null; });
  if (!index) {
    await audit('FAILURE', { code: 'INDEX_MISSING' });
    return NextResponse.json({ error: 'Index d’intégrité absent du stockage : archive inexploitable, relancez la génération.', code: 'INDEX_MISSING' }, { status: 404, headers: NO_STORE });
  }

  if (path !== null) {
    if (!dl.isStoredPath(index, path)) {
      await audit('DENIED', { code: 'INVALID_PATH' });
      return NextResponse.json({ error: 'Fichier inconnu pour ce diagnostic.', code: 'INVALID_PATH' }, { status: 400, headers: NO_STORE });
    }
    const { shortLivedDownloadUrl } = await import('@/services/exports/v12/storage');
    const url = await shortLivedDownloadUrl(`${job.storagePrefix}${path}.gz`, `verebona-diagnostic-${id.slice(0, 8)}-${path.replace(/\//g, '_')}.gz`, 'application/gzip');
    await audit('SUCCESS', {});
    return NextResponse.redirect(url, { status: 302, headers: NO_STORE });
  }

  const [{ responseStream }, { contentDisposition }] = await Promise.all([import('@/services/admin/account-data/stream-response'), import('@/lib/download-filename')]);
  const out = responseStream();
  const fileName = index.fileName || `verebona-diagnostic-${id.slice(0, 8)}.zip`;
  void dl.streamDiagnosticJobZip(index, storage, job.storagePrefix, out.node).then(async (o) => {
    if (o.ok) { out.end(); await audit('SUCCESS', { bytes: o.bytes }); return; }
    console.error(`[diagnostic-job] ${JSON.stringify({ event: 'download-failed', jobId: id, clientGone: o.clientGone, bytes: o.bytes, message: st.sanitizeErrorMessage(o.error) })}`);
    await audit('FAILURE', { code: o.clientGone ? 'CLIENT_GONE' : 'DOWNLOAD_FAILED', bytes: o.bytes });
    out.abort(o.error);
  });
  return new Response(out.body, {
    status: 200,
    headers: { ...NO_STORE, 'Content-Type': 'application/zip', 'Content-Disposition': contentDisposition(fileName), 'X-Content-Type-Options': 'nosniff', 'X-Verebona-Diagnostic-Id': id },
  });
}
