/**
 * GET /api/admin/ai/business-executions/exports/[id]/download — lot 84D
 * (EXP-03, EXP-04, R27, R63 ; décision PO 15), carte #802.
 *
 * Règle remplacée (carte #802) : plus de volumes ZIP (`volume=<n>`) ni de
 * téléchargement fichier par fichier (`path=…`) — ces paramètres sont refusés
 * (410). UNE SEULE remise : l'archive unique de la génération, assemblée,
 * relue et vérifiée, servie telle quelle par une URL signée de courte durée
 * (aucun calcul au téléchargement : deux téléchargements = mêmes octets).
 *
 * Droits REVÉRIFIÉS à chaque remise : administrateur ; export « avec contenus
 * sensibles » → habilitation `AI_MODEL_OUTPUT_ADMIN_IDS` (refus journalisé).
 * Une génération en cours, interrompue, en échec ou purgée ne remet RIEN.
 * Chaque téléchargement (et chaque refus) est journalisé.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext } from '../../../../config-versions/_shared';
import { logAdminAction } from '@/lib/admin-audit';
import type { ExportResumeState } from '@/services/ai/business-execution/export-model';

export const dynamic = 'force-dynamic';
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const sp = req.nextUrl.searchParams;
  const audit = (result: 'SUCCESS' | 'FAILURE' | 'DENIED', details: Record<string, unknown>) => logAdminAction({
    adminId: guard.ctx.adminUserId, action: 'AI_EXECUTIONS_EXPORT_DOWNLOAD', targetType: 'AI_EXECUTIONS_EXPORT', targetId: null, result,
    details: { generationId: id, ...details },
  });
  const gen = await import('@/services/admin/export-generations');
  const g = await gen.getGeneration(id).catch(() => null);
  if (!g || g.kind !== 'AI_EXECUTIONS_EXPORT') return NextResponse.json({ error: 'Export introuvable.', code: 'NOT_FOUND' }, { status: 404, headers: NO_STORE });
  if (sp.get('volume') !== null || sp.get('path') !== null) {
    await audit('DENIED', { code: 'SINGLE_ARCHIVE_ONLY' });
    return NextResponse.json({ error: 'Cet export se télécharge en un seul ZIP complet : les volumes et les fichiers séparés ne sont plus remis.', code: 'SINGLE_ARCHIVE_ONLY' }, { status: 410, headers: NO_STORE });
  }
  if (g.status === 'RUNNING' && !g.interrupted) return NextResponse.json({ error: 'Export en cours de génération.', code: 'NOT_READY' }, { status: 409, headers: NO_STORE });
  const ex = await import('@/services/ai/business-execution/export');
  const st = await gen.readResumeState<ExportResumeState>(id);
  const archive = g.status === 'COMPLETE' ? ex.deliverableArchive(st) : null;
  if (!archive || !st) {
    await audit('FAILURE', { code: 'ARCHIVE_UNAVAILABLE', status: g.status });
    return NextResponse.json({
      error: st?.failure?.message ?? 'Aucun ZIP complet pour cet export (génération interrompue — à reprendre —, en échec, ou purgée après 30 jours).',
      code: 'ARCHIVE_UNAVAILABLE',
    }, { status: 404, headers: NO_STORE });
  }
  const { isModelOutputAccessAllowed } = await import('@/services/ai/telemetry/model-output-access');
  if (st.perimeter.sensitiveContent && !isModelOutputAccessAllowed(guard.ctx.adminUserId)) {
    await audit('DENIED', { code: 'SENSITIVE_CONTENT_FORBIDDEN' });
    return NextResponse.json({ error: 'Export avec contenus sensibles : réservé aux administrateurs habilités (AI_MODEL_OUTPUT_ADMIN_IDS).', code: 'SENSITIVE_CONTENT_FORBIDDEN' }, { status: 403, headers: NO_STORE });
  }
  // L'archive doit toujours exister dans le stockage (purge de rétention) : sinon, rien n'est remis.
  if (!(await ex.archiveStillStored(archive))) {
    await audit('FAILURE', { code: 'ARCHIVE_PURGED' });
    return NextResponse.json({ error: 'Archive purgée (conservation de 30 jours) : relancez l’export.', code: 'ARCHIVE_PURGED' }, { status: 404, headers: NO_STORE });
  }
  const { shortLivedDownloadUrl } = await import('@/services/exports/v12/storage');
  const url = await shortLivedDownloadUrl(archive.key, archive.fileName, 'application/zip');
  await audit('SUCCESS', { archive: archive.fileName, bytes: archive.bytes, sha256: archive.sha256, contenusSensibles: st.perimeter.sensitiveContent });
  return NextResponse.redirect(url, { status: 302, headers: NO_STORE });
}
