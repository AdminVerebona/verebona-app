/**
 * POST /api/admin/ai/routing/promotions/[id]/revert — lot 86B (OPT-03) :
 * annule une promotion (retour à l'ordre configuré), historisé.
 */
import { NextRequest, NextResponse } from 'next/server';
import { revertPromotion } from '@/services/ai/config/routing-state.service';
import { requireAdminContext, parseVersionId, invalidId, toErrorResponse } from '../../../../config-versions/_shared';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const n = parseVersionId(id);
  if (n === null) return invalidId(id);
  try {
    return NextResponse.json({ promotion: await revertPromotion(n, guard.ctx.adminUserId) });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/routing/promotions/[id]/revert');
  }
}
