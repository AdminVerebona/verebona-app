import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { equipments, assets, substructures } from '@/db/schema';
import { eq, and, sql, desc } from 'drizzle-orm';
import { apiError } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';
import { runEquipmentAutoLink } from '@/services/equipment/equipment-auto-link.service';
import { isValidEquipmentStatus, assetSupportsStructuralFeatures } from '@/types/domain';

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

    const results = await db.$client<{ id: number; name: string; type: string | null; category: string | null; status: string; substructureId: number | null; purchasePriceCents: number | null; estimatedValueCents: number | null; archivedAt: string | null }[]>`
      SELECT id, name, type, category, status,
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

    const body = await request.json();
    const { name, type, category, status, substructureId, purchasePriceCents, estimatedValueCents } = body;

    if (!name || !name.trim()) {
      return apiError(400, 'MISSING_FIELD', 'Name is required');
    }

    if (status && !isValidEquipmentStatus(status)) {
      return apiError(400, 'INVALID_INPUT', 'Invalid equipment status');
    }

    // If substructureId is provided, verify it belongs to the same asset
    if (substructureId) {
      const subRows = await db
        .select({ id: substructures.id })
        .from(substructures)
        .where(and(eq(substructures.id, substructureId), eq(substructures.assetId, assetId)))
        .limit(1);
      if (subRows.length === 0) {
        return apiError(400, 'INVALID_INPUT', 'Substructure not found for this asset');
      }
    }

    const now = new Date().toISOString();

    // Use raw SQL to insert without specifying auto-generated columns
    await db.execute(sql`
      INSERT INTO equipments (asset_id, substructure_id, name, type, status, created_at, updated_at)
      VALUES (${assetId}, ${substructureId || null}, ${name.trim()}, ${type || null}, ${status || 'EN_SERVICE'}, ${now}, ${now})
    `);

    // Fetch the most recently created equipment for this asset
    const newEquipments = await db
      .select({
        id: equipments.id,
        name: equipments.name,
        type: equipments.type,
        status: equipments.status,
        substructureId: equipments.substructureId,
      })
      .from(equipments)
      .where(eq(equipments.assetId, assetId))
      .orderBy(desc(equipments.id))
      .limit(1);

    const newEquipment = newEquipments[0];
    if (!newEquipment) {
      return apiError(500, 'INTERNAL_ERROR', 'Failed to fetch created equipment');
    }

    // Fire-and-forget: AI auto-link against existing documents, agenda and suppliers
    runEquipmentAutoLink(newEquipment.id, session.currentAccountId!).catch(() => { /* non-blocking */ });

    return NextResponse.json({
      id: newEquipment.id,
      name: newEquipment.name,
      status: newEquipment.status,
      type: newEquipment.type,
      substructureId: newEquipment.substructureId,
      assetId
    }, { status: 201 });
  } catch (error) {
    console.error('POST equipment error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
