import { NextRequest, NextResponse } from 'next/server';
import { getSession, requireAdmin } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { guardAdmin, NO_STORE } from '../../../../ops/_shared';

export const dynamic = 'force-dynamic';
export const maxDuration = 900;

/**
 * GET /api/admin/diagnostics/recette/:id/download — lot 82E.
 *
 *   `path=<fichier du manifeste>` → redirection vers une URL signée de courte
 *          durée (droits revérifiés à chaque demande, comme les dossiers V12) ;
 *   `archive=zip` → archive ZIP de TOUS les fichiers, produite en flux depuis
 *          le stockage (parties gzip stockées telles quelles).
 *
 * Seuls les fichiers listés au manifeste d'une génération terminée sont
 * servis (aucune clé arbitraire). Administrateurs seulement ; journalisé.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  const { id } = await params;
  const sp = request.nextUrl.searchParams;
  const path = sp.get('path');
  const archive = sp.get('archive') === 'zip';
  const email = await getSession(request).then((s) => (typeof s?.email === 'string' ? s.email : undefined), () => undefined);
  const audit = (result: 'SUCCESS' | 'FAILURE' | 'DENIED', details: Record<string, unknown>) => logAdminAction({
    adminId: g.adminId, adminEmail: email, action: 'RECETTE_EXPORT_DOWNLOAD', targetType: 'RECETTE_EXPORT', targetId: null, result,
    details: { generationId: id, path, archive, ...details },
  });
  const { getGeneration } = await import('@/services/admin/export-generations');
  const gen = await getGeneration(id).catch(() => null);
  if (!gen || gen.kind !== 'RECETTE_EXPORT') return NextResponse.json({ error: 'Export introuvable.', code: 'NOT_FOUND' }, { status: 404, headers: NO_STORE });
  if (gen.status === 'RUNNING') return NextResponse.json({ error: 'Export en cours de génération.', code: 'NOT_READY' }, { status: 409, headers: NO_STORE });
  const [{ readRecetteManifest, recettePrefix }, dl] = await Promise.all([
    import('@/services/admin/diagnostics-export/recette'), import('@/services/admin/diagnostics-export/recette-download'),
  ]);
  const manifest = await readRecetteManifest(id).catch(() => null);
  if (!manifest) {
    await audit('FAILURE', { code: 'MANIFEST_MISSING' });
    return NextResponse.json({ error: 'Manifeste absent du stockage (génération interrompue ou purgée après 30 jours).', code: 'MANIFEST_MISSING' }, { status: 404, headers: NO_STORE });
  }

  if (archive) {
    const [{ responseStream }, { getS3Client, getS3Bucket }, { contentDisposition }] = await Promise.all([
      import('@/services/admin/account-data/stream-response'), import('@/lib/s3-config'), import('@/lib/download-filename'),
    ]);
    const { ZIP_MAX_BYTES } = await import('@/services/admin/diagnostics-export/zip');
    if (manifest.totals.compressedBytes > ZIP_MAX_BYTES) {
      await audit('FAILURE', { code: 'ARCHIVE_TOO_LARGE' });
      return NextResponse.json({ error: 'Export au-delà de 4 Gio : téléchargez les fichiers un par un.', code: 'ARCHIVE_TOO_LARGE' }, { status: 413, headers: NO_STORE });
    }
    const out = responseStream();
    const fileName = `verebona-recette-${id}.zip`;
    void dl.streamRecetteZip(manifest, { client: getS3Client('worker'), bucket: getS3Bucket() }, out.node).then(async (o) => {
      if (o.ok) { out.end(); await audit('SUCCESS', { bytes: o.bytes }); return; }
      await audit('FAILURE', { code: o.clientGone ? 'CLIENT_GONE' : 'ARCHIVE_FAILED', bytes: o.bytes });
      out.abort(o.error);
    });
    return new Response(out.body, { status: 200, headers: { ...NO_STORE, 'Content-Type': 'application/zip', 'Content-Disposition': contentDisposition(fileName) } });
  }

  if (!path || !dl.isDownloadablePath(manifest, path)) {
    await audit('DENIED', { code: 'INVALID_PATH' });
    return NextResponse.json({ error: 'Fichier inconnu pour cet export.', code: 'INVALID_PATH' }, { status: 400, headers: NO_STORE });
  }
  const { shortLivedDownloadUrl } = await import('@/services/exports/v12/storage');
  const url = await shortLivedDownloadUrl(`${recettePrefix(id)}${path}`, dl.recetteFileName(id, path), dl.recetteContentType(path));
  await audit('SUCCESS', {});
  return NextResponse.redirect(url, { status: 302, headers: NO_STORE });
}
