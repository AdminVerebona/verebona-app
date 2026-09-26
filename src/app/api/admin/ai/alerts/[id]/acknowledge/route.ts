/**
 * POST /api/admin/ai/alerts/[id]/acknowledge — acquitte une alerte (ALT-01).
 * L'acquittement ne change rien au runtime : il retire l'alerte des alertes
 * ouvertes. Un traitement suspendu par garde-fou se réactive à part.
 */
import { NextRequest, NextResponse } from 'next/server';
import { acknowledgeAlert } from '@/services/ai/alerts/alerts.repository';
import { requireAdminContext, toErrorResponse } from '../../../config-versions/_shared';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  if (!/^\d+$/.test(id)) return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });
  try {
    const ok = await acknowledgeAlert(Number(id), guard.ctx.adminUserId);
    return ok
      ? NextResponse.json({ acknowledged: true })
      : NextResponse.json({ error: 'NOT_FOUND_OR_ACKNOWLEDGED' }, { status: 409 });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/alerts/[id]/acknowledge');
  }
}
