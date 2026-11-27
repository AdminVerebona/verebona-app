import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assets } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { apiError } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';
import { getAssetDeletionSummary } from '@/services/assets/asset-deletion.service';

/**
 * GET /api/assets/[id]/deletion-summary
 *
 * Inventaire de la suppression définitive (carte #849, B1) : ce qui sera
 * SUPPRIMÉ (documents et versions, photos, pièces, équipements, échéances,
 * événements, éléments d'Agenda, Opérations, dépenses, exports) et ce qui sera
 * CONSERVÉ car lié aussi à un autre bien, avec l'EMPREINTE de cet inventaire
 * — à renvoyer à `DELETE /api/assets?id=…&inventory=…` (exigée). Affiché par
 * DeleteAssetDialog AVANT confirmation ; inventaire en échec → 500, la
 * fenêtre bloque la suppression (jamais de décompte trompeur). Même contrôle
 * de propriété que DELETE /api/assets : le bien doit appartenir au compte
 * courant.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    let session;
    try {
      session = await SessionService.getSession(request);
    } catch (e) {
      return SessionService.handleSessionError(e);
    }
    if (!session?.currentAccountId) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

    const { id } = await params;
    const assetId = parseInt(id, 10);
    if (isNaN(assetId)) return apiError(400, 'INVALID_INPUT', 'Valid asset ID required');

    const [asset] = await db
      .select({ id: assets.id, accountId: assets.accountId })
      .from(assets)
      .where(eq(assets.id, assetId))
      .limit(1);

    if (!asset) return apiError(404, 'NOT_FOUND', 'Asset not found');
    if (asset.accountId !== session.currentAccountId) return apiError(403, 'FORBIDDEN', 'Access denied');

    const summary = await getAssetDeletionSummary(assetId);
    return NextResponse.json({ assetId, ...summary }, { status: 200 });
  } catch (error) {
    console.error('[deletion-summary] error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Une erreur interne est survenue.');
  }
}
