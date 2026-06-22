import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { equipments, assets } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { apiError } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';
import { isValidEquipmentStatus } from '@/types/domain';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; equipId: string }> }
) {
  try {
    const { id, equipId } = await params;
    const assetId = parseInt(id);
    const equipmentId = parseInt(equipId);

    if (isNaN(assetId) || isNaN(equipmentId)) {
      return apiError(400, 'INVALID_INPUT', 'Valid asset ID and equipment ID are required');
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

    const body = await request.json();
    const { name, type, category, status, substructureId, newAssetId, purchasePriceCents, estimatedValueCents } = body;

    // Determine the effective assetId after potential transfer
    let effectiveAssetId = assetId;

    // Handle optional asset transfer
    if (newAssetId !== undefined && newAssetId !== null && newAssetId !== assetId) {
      const newAsset = await db
        .select()
        .from(assets)
        .where(and(eq(assets.id, newAssetId), eq(assets.accountId, session.currentAccountId!)))
        .limit(1);
      if (newAsset.length === 0) return apiError(404, 'NOT_FOUND', 'Target asset not found');
      effectiveAssetId = newAssetId;
    }

    // Build update object
    const updateData: any = {
      updatedAt: new Date(),
    };

    if (name !== undefined) {
      if (!name.trim()) return apiError(400, 'INVALID_INPUT', 'Name cannot be empty');
      updateData.name = name.trim();
    }

    if (type !== undefined) updateData.type = type;
    if (category !== undefined) updateData.category = category;
    if (purchasePriceCents !== undefined) updateData.purchasePriceCents = purchasePriceCents;
    if (estimatedValueCents !== undefined) updateData.estimatedValueCents = estimatedValueCents;
    if (newAssetId !== undefined) updateData.assetId = effectiveAssetId;

    if (status !== undefined) {
      if (!isValidEquipmentStatus(status)) return apiError(400, 'INVALID_INPUT', 'Invalid status');
      updateData.status = status;
    }

    if (substructureId !== undefined) {
      if (substructureId !== null) {
        // Verify substructure belongs to the effective asset
        const rows = await db.$client<{ id: number }[]>`
          SELECT id FROM substructures WHERE id = ${substructureId} AND asset_id = ${effectiveAssetId} LIMIT 1
        `;
        if (!rows.length) return apiError(400, 'INVALID_INPUT', 'Substructure not found for this asset');
      }
      updateData.substructureId = substructureId;
    }

    // Build SET clause using raw SQL — same proven pattern as DELETE handler
    const now = new Date().toISOString();
    const sets: string[] = ['updated_at = $1'];
    const vals: unknown[] = [now];
    let p = 2;

    if (name !== undefined)          { sets.push(`name = $${p++}`);            vals.push(name.trim()); }
    if (type !== undefined)          { sets.push(`type = $${p++}`);            vals.push(type); }
    if (status !== undefined)        { sets.push(`status = $${p++}`);          vals.push(status); }
    if (updateData.substructureId !== undefined) { sets.push(`substructure_id = $${p++}`); vals.push(updateData.substructureId ?? null); }
    if (newAssetId !== undefined)    { sets.push(`asset_id = $${p++}`);        vals.push(effectiveAssetId); }

    // WHERE params
    vals.push(equipmentId); // $p
    vals.push(assetId);     // $p+1

    const rows = await db.$client.unsafe<{ id: number; name: string; status: string; type: string | null; substructure_id: number | null; asset_id: number }[]>(
      `UPDATE equipments SET ${sets.join(', ')} WHERE id = $${p} AND asset_id = $${p + 1} RETURNING id, name, status, type, substructure_id, asset_id`,
      vals as any
    );

    if (!rows.length) {
      return apiError(404, 'NOT_FOUND', 'Equipment not found');
    }

    return NextResponse.json({
      id: rows[0].id,
      name: rows[0].name,
      status: rows[0].status,
      type: rows[0].type,
      substructureId: rows[0].substructure_id,
      assetId: rows[0].asset_id,
    });
  } catch (error: any) {
    console.error('PUT equipment error:', error?.message ?? error);
    return NextResponse.json({ error: 'INTERNAL_ERROR', detail: error?.message ?? String(error) }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; equipId: string }> }
) {
  try {
    const { id, equipId } = await params;
    const assetId = parseInt(id);
    const equipmentId = parseInt(equipId);

    if (isNaN(assetId) || isNaN(equipmentId)) {
      return apiError(400, 'INVALID_INPUT', 'Valid asset ID and equipment ID are required');
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

    // Logical archival via raw SQL to avoid ORM type issues
    const now = new Date().toISOString();
    const rows = await db.$client.unsafe<{ id: number }[]>(
      `UPDATE equipments SET archived_at = $1, substructure_id = NULL, updated_at = $2 WHERE id = $3 AND asset_id = $4 RETURNING id`,
      [now, now, equipmentId, assetId] as any
    );

    if (!rows.length) {
      return apiError(404, 'NOT_FOUND', 'Equipment not found');
    }

    return NextResponse.json({ message: 'Equipment archived successfully' });
  } catch (error) {
    console.error('DELETE equipment error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
