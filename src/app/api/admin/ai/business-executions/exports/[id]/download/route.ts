/**
 * GET /api/admin/ai/business-executions/exports/[id]/download — lot 84D
 * (EXP-03, EXP-04, R27, R63 ; décision PO 15).
 *
 *   `path=<fichier du manifeste>` → URL signée de courte durée (JSONL
 *          compressé, manifeste, LISEZMOI) ;
 *   `volume=<n>` → VOLUME ZIP n (fractionnement : parties entières, plus le
 *          manifeste et le LISEZMOI — index commun), produit en flux depuis le
 *          stockage (mécanisme de l'export de recette).
 * Droits REVÉRIFIÉS à chaque remise : administrateur ; export « avec contenus
 * sensibles » → habilitation `AI_MODEL_OUTPUT_ADMIN_IDS` (refus journalisé).
 * Seuls les fichiers listés au manifeste d'une génération terminée sont
 * servis (aucune clé arbitraire). Chaque téléchargement est journalisé.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext } from '../../../../config-versions/_shared';
import { logAdminAction } from '@/lib/admin-audit';

export const dynamic = 'force-dynamic';
export const maxDuration = 900;
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const sp = req.nextUrl.searchParams;
  const path = sp.get('path');
  const volume = sp.get('volume');
  const audit = (result: 'SUCCESS' | 'FAILURE' | 'DENIED', details: Record<string, unknown>) => logAdminAction({
    adminId: guard.ctx.adminUserId, action: 'AI_EXECUTIONS_EXPORT_DOWNLOAD', targetType: 'AI_EXECUTIONS_EXPORT', targetId: null, result,
    details: { generationId: id, path, volume, ...details },
  });
  const { getGeneration } = await import('@/services/admin/export-generations');
  const gen = await getGeneration(id).catch(() => null);
  if (!gen || gen.kind !== 'AI_EXECUTIONS_EXPORT') return NextResponse.json({ error: 'Export introuvable.', code: 'NOT_FOUND' }, { status: 404, headers: NO_STORE });
  if (gen.status === 'RUNNING' && !gen.interrupted) return NextResponse.json({ error: 'Export en cours de génération.', code: 'NOT_READY' }, { status: 409, headers: NO_STORE });
  const ex = await import('@/services/ai/business-execution/export');
  const manifest = await ex.readExecutionsManifest(id).catch(() => null);
  if (!manifest) {
    await audit('FAILURE', { code: 'MANIFEST_MISSING' });
    return NextResponse.json({ error: 'Manifeste absent (génération interrompue — à reprendre — ou purgée après 30 jours).', code: 'MANIFEST_MISSING' }, { status: 404, headers: NO_STORE });
  }
  const { isModelOutputAccessAllowed } = await import('@/services/ai/telemetry/model-output-access');
  if (manifest.perimeter.sensitiveContent && !isModelOutputAccessAllowed(guard.ctx.adminUserId)) {
    await audit('DENIED', { code: 'SENSITIVE_CONTENT_FORBIDDEN' });
    return NextResponse.json({ error: 'Export avec contenus sensibles : réservé aux administrateurs habilités (AI_MODEL_OUTPUT_ADMIN_IDS).', code: 'SENSITIVE_CONTENT_FORBIDDEN' }, { status: 403, headers: NO_STORE });
  }
  const { executionsExportPrefix } = await import('@/services/ai/business-execution/export-model');
  const prefix = executionsExportPrefix(id);

  if (volume !== null) {
    const v = manifest.volumes.find((x) => String(x.index) === volume);
    if (!v) {
      await audit('DENIED', { code: 'INVALID_VOLUME' });
      return NextResponse.json({ error: 'Volume inconnu pour cet export.', code: 'INVALID_VOLUME' }, { status: 400, headers: NO_STORE });
    }
    const [{ responseStream }, { getS3Client, getS3Bucket }, { contentDisposition }, { streamStoredZip }] = await Promise.all([
      import('@/services/admin/account-data/stream-response'), import('@/lib/s3-config'), import('@/lib/download-filename'),
      import('@/services/admin/diagnostics-export/recette-download'),
    ]);
    const files = [...v.files, 'LISEZMOI.txt', 'manifeste.json'].filter((p, i, a) => a.indexOf(p) === i).map((p) => ({ path: p, key: `${prefix}${p}` }));
    const out = responseStream();
    const fileName = `verebona-executions-ia-${id.slice(0, 8)}-volume-${v.index}-sur-${manifest.volumes.length}.zip`;
    void streamStoredZip(files, new Date(manifest.generatedAt), { client: getS3Client('worker'), bucket: getS3Bucket() }, out.node).then(async (o) => {
      if (o.ok) { out.end(); await audit('SUCCESS', { bytes: o.bytes, files: files.length }); return; }
      await audit('FAILURE', { code: o.clientGone ? 'CLIENT_GONE' : 'ARCHIVE_FAILED', bytes: o.bytes });
      out.abort(o.error);
    });
    return new Response(out.body, { status: 200, headers: { ...NO_STORE, 'Content-Type': 'application/zip', 'Content-Disposition': contentDisposition(fileName) } });
  }

  if (!path || !ex.executionsDownloadables(manifest).includes(path)) {
    await audit('DENIED', { code: 'INVALID_PATH' });
    return NextResponse.json({ error: 'Fichier inconnu pour cet export.', code: 'INVALID_PATH' }, { status: 400, headers: NO_STORE });
  }
  const { shortLivedDownloadUrl } = await import('@/services/exports/v12/storage');
  const type = path.endsWith('.gz') ? 'application/gzip' : path.endsWith('.json') ? 'application/json' : 'text/plain';
  const url = await shortLivedDownloadUrl(`${prefix}${path}`, `verebona-executions-ia-${id.slice(0, 8)}-${path.replace(/\//g, '_')}`, type);
  await audit('SUCCESS', {});
  return NextResponse.redirect(url, { status: 302, headers: NO_STORE });
}
