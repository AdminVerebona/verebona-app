import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { SessionService } from '@/lib/session-service';
import { apiError } from '@/lib/api-errors';

/**
 * GET /api/equipments/[id] — l'équipement seul, pour l'ouvrir en tiroir
 * depuis n'importe quel écran (lien profond `?tiroir=equipement:<id>`).
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
  const equipmentId = Number.parseInt(id, 10);
  if (!Number.isSafeInteger(equipmentId) || equipmentId <= 0) {
    return apiError(400, 'INVALID_INPUT', 'Invalid equipment id');
  }

  try {
    const [row] = await db.$client<{
      id: number; assetId: number; name: string; type: string | null;
      status: string; substructureId: number | null; assetName: string;
    }[]>`
      SELECT e.id, e.asset_id AS "assetId", e.name, e.type, e.status,
             e.substructure_id AS "substructureId", a.name AS "assetName"
      FROM equipments e
      JOIN assets a ON a.id = e.asset_id
      WHERE e.id = ${equipmentId} AND a.account_id = ${accountId} AND a.deleted_at IS NULL
        AND e.archived_at IS NULL
      LIMIT 1
    `;
    if (!row) return apiError(404, 'NOT_FOUND', 'Équipement introuvable');
    return NextResponse.json({ equipment: row });
  } catch (error) {
    console.error('[api/equipments/:id] GET', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
