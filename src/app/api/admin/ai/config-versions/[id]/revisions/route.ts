/**
 * GET /api/admin/ai/config-versions/[id]/revisions — lot 54 (54C).
 *
 * Historique restaurable d'une version : révisions, la plus récente
 * d'abord (numéro, date, auteur, commentaire, révision d'origine d'une
 * restauration). Persistant, indépendant des traces d'exécution.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getVersion, listRevisions } from '@/services/ai/config/config-version.repository';
import { requireAdminContext, parseVersionId, invalidId, toErrorResponse } from '../../_shared';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const versionId = parseVersionId(id);
  if (versionId === null) return invalidId(id);

  try {
    const version = await getVersion(versionId);
    if (!version) return NextResponse.json({ error: 'VERSION_NOT_FOUND' }, { status: 404 });
    return NextResponse.json({
      versionId,
      currentRevisionNumber: version.currentRevisionNumber,
      revisions: await listRevisions(versionId),
    });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/config-versions/[id]/revisions');
  }
}
