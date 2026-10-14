/**
 * POST /api/admin/ai/config-versions/[id]/undelete — lot 54 (54C).
 *
 * Remet une version supprimée dans la liste, NON active (aucune activation
 * implicite : l'activer reste un geste explicite).
 */
import { NextRequest, NextResponse } from 'next/server';
import { restoreDeletedVersion } from '@/services/ai/config/config-version.service';
import { requireAdminContext, parseVersionId, invalidId, toErrorResponse } from '../../_shared';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const versionId = parseVersionId(id);
  if (versionId === null) return invalidId(id);

  try {
    await restoreDeletedVersion(versionId, guard.ctx.adminUserId);
    return NextResponse.json({ restored: true, active: false });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/config-versions/[id]/undelete');
  }
}
