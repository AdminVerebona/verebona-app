import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { apiError } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';
import { canUsePremiumFeature } from '@/services/entitlements.service';
import { assetSupportsStructuralFeatures } from '@/types/domain';
import { refuserSiModificationBiensSuspendue } from '@/lib/asset-quota-guard';
import { createRoomForAccount } from '@/services/assets/structure-write.facade';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const assetId = parseInt(id);

    if (isNaN(assetId)) {
      return apiError(400, 'INVALID_INPUT', 'Valid asset ID is required');
    }

    let session;
    try {
      session = await SessionService.getSession(request);
    } catch (authError) {
      return SessionService.handleSessionError(authError);
    }

    if (!session || !session.currentAccountId) {
      return apiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    // Verify asset ownership
    const [assetRow] = await db.$client<{ id: number }[]>`
      SELECT id FROM assets WHERE id = ${assetId} AND account_id = ${session.currentAccountId} AND deleted_at IS NULL LIMIT 1
    `;

    if (!assetRow) {
      return apiError(404, 'NOT_FOUND', 'Asset not found');
    }

    // Raw query : on sélectionne uniquement les colonnes présentes en DB
    // (public_id et scope peuvent ne pas exister sur les anciens environnements)
    const results = await db.$client<{
      id: number;
      name: string;
      assetId: number;
      orderIndex: number;
      createdAt: string | null;
      updatedAt: string | null;
      roomType: string | null;
      area: string | null;
      description: string | null;
    }[]>`
      SELECT s.id, s.name, s.asset_id AS "assetId", s.order_index AS "orderIndex",
             s.created_at AS "createdAt", s.updated_at AS "updatedAt",
             -- Colonnes de la pièce (D-G, migration 0229), lues par to_jsonb : null si la migration manque.
             to_jsonb(s)->>'room_type' AS "roomType", to_jsonb(s)->>'area' AS area, to_jsonb(s)->>'description' AS description
      FROM substructures s
      WHERE s.asset_id = ${assetId}
      ORDER BY s.order_index ASC
    `;

    return NextResponse.json(results);
  } catch (error) {
    console.error('GET substructures error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const assetId = parseInt(id);

    if (isNaN(assetId)) {
      return apiError(400, 'INVALID_INPUT', 'Valid asset ID is required');
    }

    let session;
    try {
      session = await SessionService.getSession(request);
    } catch (authError) {
      return SessionService.handleSessionError(authError);
    }

    if (!session || !session.currentAccountId) {
      return apiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    // Verify asset ownership
    const [assetData] = await db.$client<{ id: number; category: string; subtype: string | null }[]>`
      SELECT id, category, subtype FROM assets WHERE id = ${assetId} AND account_id = ${session.currentAccountId} AND deleted_at IS NULL LIMIT 1
    `;

    if (!assetData) {
      return apiError(404, 'NOT_FOUND', 'Asset not found');
    }

    // Vérifier si le bien supporte les fonctionnalités structurelles
    if (!assetSupportsStructuralFeatures(assetData)) {
      return apiError(400, 'FORBIDDEN', 'Ce type de bien ne supporte pas la gestion des pièces');
    }

    // Au-dessus du quota après un changement d'offre : modification suspendue (GAP-11).
    const refusQuota = await refuserSiModificationBiensSuspendue(session.currentAccountId);
    if (refusQuota) return refusQuota;

    // Gestion des pièces : Premium et Premium Duo (essai compris). Le client
    // ouvre la fenêtre d'offre avant la saisie ; ce contrôle en est la
    // garantie, et son refus est lu par `parseWriteBlocked`.
    const premium = await canUsePremiumFeature(session.currentAccountId);
    if (!premium.allowed) {
      return NextResponse.json(
        { error: premium.reason, code: premium.reason, message: premium.message },
        { status: 403 },
      );
    }

    const body = await request.json();
    const { name } = body;

    if (!name || !name.trim()) {
      return apiError(400, 'MISSING_FIELD', 'Name is required');
    }

    // Lot 114 (#753, W07) : création par la façade métier — la même que l'Assistant Verebona (événements compris).
    const newSubstructure = await createRoomForAccount(session.currentAccountId, assetId, name);
    return NextResponse.json({ id: newSubstructure.id, name: newSubstructure.name, assetId: newSubstructure.asset_id, orderIndex: newSubstructure.order_index }, { status: 201 });
  } catch (error) {
    console.error('POST substructure error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
