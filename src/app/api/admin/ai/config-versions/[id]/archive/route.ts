/**
 * POST /api/admin/ai/config-versions/[id]/archive — compatibilité (lot 54).
 *
 * « Archiver » = supprimer LOGIQUEMENT une version non active : retirée de
 * la liste, révisions conservées et restaurables. L'active : 409.
 */
import { NextRequest, NextResponse } from 'next/server';
import { deleteConfigVersion } from '@/services/ai/config/config-version.service';
import { requireAdminContext, parseVersionId, invalidId, toErrorResponse } from '../../_shared';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const versionId = parseVersionId(id);
  if (versionId === null) return invalidId(id);

  try {
    await deleteConfigVersion(versionId, guard.ctx.adminUserId);
    return NextResponse.json({ archived: true, deleted: true });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/config-versions/[id]/archive');
  }
}
