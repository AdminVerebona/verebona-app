import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { apiError } from '@/lib/api-errors';
import { runEquipmentAutoLink } from '@/services/equipment/equipment-auto-link.service';
import { equipmentInAccount } from '@/services/security/account-ownership';

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
    // Lot 49 (SEC-04) : équipement du compte actif, vérifié avant tout
    // traitement (le service revérifie et borne chaque écriture au compte).
    if (!(await equipmentInAccount(accountId, equipmentId))) return apiError(404, 'NOT_FOUND', 'Equipment not found');

    const result = await runEquipmentAutoLink(equipmentId, accountId);

    return NextResponse.json({ success: true, result });
  } catch (err) {
    if (err instanceof Error && err.message === 'Equipment not found') return apiError(404, 'NOT_FOUND', 'Equipment not found');
    console.error('POST /api/equipments/[id]/auto-link error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
