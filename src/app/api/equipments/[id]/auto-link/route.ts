import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { apiError } from '@/lib/api-errors';
import { runEquipmentAutoLink } from '@/services/equipment/equipment-auto-link.service';
import { db } from '@/db';
import { equipments, accounts } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

// POST /api/equipments/[id]/auto-link — AI auto-linking for equipment
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await SessionService.getSession(request);
    if (!session) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

    const accountId = session.currentAccountId;
    if (!accountId) return apiError(401, 'UNAUTHORIZED', 'No account selected');

    const { id } = await params;
    const equipmentId = parseInt(id);
    if (isNaN(equipmentId)) return apiError(400, 'INVALID_INPUT', 'Invalid equipment id');

    const result = await runEquipmentAutoLink(equipmentId, accountId);

    return NextResponse.json({ success: true, result });
  } catch (err) {
    console.error('POST /api/equipments/[id]/auto-link error:', err);
    const message = err instanceof Error ? err.message : 'Internal server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
