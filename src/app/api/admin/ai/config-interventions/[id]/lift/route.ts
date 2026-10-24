/**
 * POST /api/admin/ai/config-interventions/[id]/lift — lot 86B (ACT-03) :
 * lève une exclusion ou un gel (historisé, journal d'administration IA).
 */
import { NextRequest, NextResponse } from 'next/server';
import { liftIntervention } from '@/services/ai/config/config-interventions.service';
import { requireAdminContext, parseVersionId, invalidId, toErrorResponse } from '../../../config-versions/_shared';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const n = parseVersionId(id);
  if (n === null) return invalidId(id);
  try {
    return NextResponse.json({ intervention: await liftIntervention(n, guard.ctx.adminUserId) });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/config-interventions/[id]/lift');
  }
}
