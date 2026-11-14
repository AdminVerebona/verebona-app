import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assets } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { apiError } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';
import { refuserSiLectureSeule } from '@/lib/write-access-guard';
import { deleteRoomForAccount, renameRoomForAccount } from '@/services/assets/structure-write.facade';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; subId: string }> }
) {
  try {
    const { id, subId } = await params;
    const assetId = parseInt(id);
    const substructureId = parseInt(subId);

    if (isNaN(assetId) || isNaN(substructureId)) {
      return apiError(400, 'INVALID_INPUT', 'Valid asset ID and substructure ID are required');
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

    // Lot 85D : écriture refusée en lecture seule (essai échu, impayé, résilié, rétractation).
    const refus = await refuserSiLectureSeule(session.currentAccountId);
    if (refus) return refus;

    const body = await request.json();
    const { name } = body;

    if (!name || !name.trim()) {
      return apiError(400, 'MISSING_FIELD', 'Name is required');
    }

    // Lot 114 (#753, W08) : renommage par la façade métier — la même que l'Assistant Verebona.
    const row = await renameRoomForAccount(session.currentAccountId, assetId, substructureId, name);
    if (!row) {
      return apiError(404, 'NOT_FOUND', 'Substructure not found');
    }
    const rows = [row];
    return NextResponse.json({ id: rows[0].id, name: rows[0].name, assetId: rows[0].asset_id });
  } catch (error) {
    console.error('PUT substructure error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; subId: string }> }
) {
  try {
    const { id, subId } = await params;
    const assetId = parseInt(id);
    const substructureId = parseInt(subId);

    if (isNaN(assetId) || isNaN(substructureId)) {
      return apiError(400, 'INVALID_INPUT', 'Valid asset ID and substructure ID are required');
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

    // Lot 85D : écriture refusée en lecture seule (essai échu, impayé, résilié, rétractation).
    const refus = await refuserSiLectureSeule(session.currentAccountId);
    if (refus) return refus;

    // Lot 114 (#753, W09) : suppression par la façade métier — la même que l'Assistant Verebona.
    if (!(await deleteRoomForAccount(session.currentAccountId, assetId, substructureId))) {
      return apiError(404, 'NOT_FOUND', 'Substructure not found');
    }
    return NextResponse.json({ message: 'Substructure deleted successfully' });
  } catch (error) {
    console.error('DELETE substructure error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
