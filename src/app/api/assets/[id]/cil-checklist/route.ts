/**
 * GET /api/assets/[id]/cil-checklist — état CIL du bien pour l'onglet
 * Informations (lot 111U).
 *
 * Rend l'état du SERVICE COMMUN (`services/cil/state`) : même projection que
 * la préparation, le blocage de génération et le PDF — référentiel
 * documentaire V2 (`documentTypeCode`) puis codes V1 et rubriques, périmètre
 * de rattachement commun (colonnes et liens N-N ACTIFS PRIMARY / SECONDARY,
 * `documentInAssetsCondition`), champs canoniques, matériaux, équipements,
 * travaux, profil et déclarations.
 *
 * Une erreur de lecture rend une ERREUR explicite (503 `CIL_STATE_UNAVAILABLE`),
 * jamais un état vide qui se lirait « tout non renseigné ».
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  let session;
  try {
    session = await SessionService.getSession(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }
  if (!session?.currentAccountId) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

  const assetId = parseInt(params.id, 10);
  if (isNaN(assetId)) return apiError(400, 'INVALID_INPUT', 'Valid asset ID required');

  try {
    const { getCilState } = await import('@/services/cil/state');
    // Bien du compte courant (Duo compris), non supprimé — sinon 404 sans révéler son existence.
    const r = await getCilState({ id: assetId, accountId: session.currentAccountId });
    if (!r) return apiError(404, 'NOT_FOUND', 'Asset not found');
    return NextResponse.json({ state: r.state }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[cil-checklist] état CIL indisponible :', (e as Error)?.message);
    return NextResponse.json(
      { error: 'CIL_STATE_UNAVAILABLE', code: 'CIL_STATE_UNAVAILABLE', message: 'L’état du carnet ne peut pas être calculé pour le moment.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
