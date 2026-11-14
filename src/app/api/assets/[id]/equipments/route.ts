import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assets } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { apiError } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';
import { canUsePremiumFeature } from '@/services/entitlements.service';
import { assetSupportsStructuralFeatures } from '@/types/domain';
import { refuserSiModificationBiensSuspendue } from '@/lib/asset-quota-guard';
import { createEquipmentForAccount } from '@/services/assets/structure-write.facade';

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
    const asset = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.accountId, session.currentAccountId)))
      .limit(1);

    if (asset.length === 0) {
      return apiError(404, 'NOT_FOUND', 'Asset not found');
    }

    const results = await db.$client<{ id: number; name: string; type: string | null; category: string | null; energyUsage: string | null; status: string; substructureId: number | null; purchasePriceCents: number | null; estimatedValueCents: number | null; archivedAt: string | null }[]>`
      SELECT id, name, type, category, energy_usage AS "energyUsage", status,
             substructure_id AS "substructureId",
             purchase_price_cents AS "purchasePriceCents",
             estimated_value_cents AS "estimatedValueCents",
             archived_at AS "archivedAt"
      FROM equipments
      WHERE asset_id = ${assetId} AND archived_at IS NULL
    `;

    return NextResponse.json(results);
  } catch (error) {
    console.error('GET equipments error:', error);
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
    const asset = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.accountId, session.currentAccountId)))
      .limit(1);

    if (asset.length === 0) {
      return apiError(404, 'NOT_FOUND', 'Asset not found');
    }

    const assetData = asset[0];

    // Vérifier si le bien supporte les équipements
    const supportsFeatures = assetSupportsStructuralFeatures(assetData);
    if (!supportsFeatures) {
      return apiError(400, 'FORBIDDEN', 'Ce type de bien ne supporte pas la gestion des équipements');
    }

    // Au-dessus du quota après un changement d'offre : modification suspendue (GAP-11).
    const refusQuota = await refuserSiModificationBiensSuspendue(session.currentAccountId);
    if (refusQuota) return refusQuota;

    // Gestion des équipements : Premium et Premium Duo (essai compris). Le client
    // ouvre la fenêtre d'offre avant la saisie ; ce contrôle en est la
    // garantie, et son refus est lu par `parseWriteBlocked`.
    const premium = await canUsePremiumFeature(session.currentAccountId);
    if (!premium.allowed) {
      return NextResponse.json(
        { error: premium.reason, code: premium.reason, message: premium.message },
        { status: 403 },
      );
    }

    // Lot 114 (#753, W04) : création par la façade métier — la même que l'Assistant Verebona (validations, origine
    // USER des montants, rapprochement durable, événements).
    const body = await request.json();
    return await createEquipmentForAccount({ userId: session.userId ?? null, currentAccountId: session.currentAccountId }, assetId, body);
  } catch (error) {
    console.error('POST equipment error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
