import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { SessionService } from '@/lib/session-service';
import { apiError } from '@/lib/api-errors';
import { EQUIPMENT_FICHE_FIELDS } from '@/lib/asset-detail-rules';

/**
 * GET /api/equipments/[id] — l'équipement seul, pour l'ouvrir en tiroir
 * depuis n'importe quel écran (lien profond `?tiroir=equipement:<id>`).
 * Le bien doit appartenir au compte courant et ne pas être supprimé.
 *
 * `fiche` (lot 20, D-D) : caractéristiques canoniques saisissables dans le
 * tiroir (`EQUIPMENT_FICHE_FIELDS`), lues de la fiche canonique de
 * l'équipement (repli colonnes) ; valeur `null` quand non renseignée, fiche
 * `null` quand illisible.
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
    // `null` quand la fiche canonique est illisible : le tiroir ne propose
    // alors aucune saisie (un formulaire vide n'efface rien en USER).
    let fiche: Record<string, unknown> | null = null;
    try {
      const { getCanonicalEntityState } = await import('@/services/canonical/entity-state');
      const etat = await getCanonicalEntityState({ type: 'EQUIPMENT', id: equipmentId }, accountId);
      if (etat) fiche = Object.fromEntries(EQUIPMENT_FICHE_FIELDS.map((f) => [f.key, etat.fields[f.key]?.value ?? null]));
    } catch (e) {
      // Fiche canonique indisponible (0227 absente) : l'équipement reste lisible.
      console.warn('[api/equipments/:id] fiche canonique non lue :', (e as Error).message);
    }
    return NextResponse.json({ equipment: row, fiche });
  } catch (error) {
    console.error('[api/equipments/:id] GET', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
