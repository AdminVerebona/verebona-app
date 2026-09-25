import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { SessionService } from '@/lib/session-service';
import { apiError } from '@/lib/api-errors';

/**
 * GET /api/substructures/[id] — la pièce seule, pour l'ouvrir en tiroir
 * depuis n'importe quel écran (lien profond `?tiroir=piece:<id>`).
 * Le bien doit appartenir au compte courant et ne pas être supprimé.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let session;
  try {
    session = await SessionService.getSession(request);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }
  const accountId = session?.currentAccountId;
  if (!accountId) return apiError(401, 'UNAUTHORIZED', 'No account selected');

  const { id } = await params;
  const roomId = Number.parseInt(id, 10);
  if (!Number.isSafeInteger(roomId) || roomId <= 0) {
    return apiError(400, 'INVALID_INPUT', 'Invalid room id');
  }

  try {
    const [row] = await db.$client<{
      id: number; assetId: number; name: string; orderIndex: number; equipmentCount: number;
    }[]>`
      SELECT s.id, s.asset_id AS "assetId", s.name, s.order_index AS "orderIndex",
             (SELECT COUNT(*)::int FROM equipments e WHERE e.substructure_id = s.id) AS "equipmentCount"
      FROM substructures s
      JOIN assets a ON a.id = s.asset_id
      WHERE s.id = ${roomId} AND a.account_id = ${accountId} AND a.deleted_at IS NULL
      LIMIT 1
    `;
    if (!row) return apiError(404, 'NOT_FOUND', 'Pièce introuvable');
    return NextResponse.json({ room: row });
  } catch (error) {
    console.error('[api/substructures/:id] GET', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
