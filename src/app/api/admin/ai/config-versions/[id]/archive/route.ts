/**
 * POST /api/admin/ai/config-versions/[id]/archive — CDC BO IA VER-008, VER-009.
 *
 * L'archivage est définitif : ni désarchivage, ni suppression. Et une Active ne
 * peut pas être archivée — la machine à états refuse la transition, ce qui rend
 * 409 plutôt qu'un 500.
 */
import { NextRequest, NextResponse } from 'next/server';
import { archive } from '@/services/ai/config/config-version.service';
import { requireAdminContext, parseVersionId, invalidId, toErrorResponse } from '../../_shared';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const versionId = parseVersionId(id);
  if (versionId === null) return invalidId(id);

  try {
    await archive(versionId);
    return NextResponse.json({ archived: true });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/config-versions/[id]/archive');
  }
}
