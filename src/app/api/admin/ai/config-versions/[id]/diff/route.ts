/**
 * GET /api/admin/ai/config-versions/[id]/diff — « Comparer à la version
 * active » (VER-003 ; lot 54 : plus de promotion, le diff informe avant une
 * activation), accompagné des contrôles non bloquants de la configuration.
 */
import { NextRequest, NextResponse } from 'next/server';
import { diffAgainstActive, checkVersion } from '@/services/ai/config/config-version.service';
import { renderDiff } from '@/services/ai/config/config-diff.service';
import { requireAdminContext, parseVersionId, invalidId, toErrorResponse } from '../../_shared';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const versionId = parseVersionId(id);
  if (versionId === null) return invalidId(id);

  try {
    const { diff, version, active } = await diffAgainstActive(versionId);
    const validation = await checkVersion(versionId);

    return NextResponse.json({
      versionId: version.id,
      versionStatus: version.status,
      activeVersionId: active?.id ?? null,
      activeVisibleNumber: active?.visibleNumber ?? null,
      diff,
      text: renderDiff(diff),
      validation,
    });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/config-versions/[id]/diff');
  }
}
