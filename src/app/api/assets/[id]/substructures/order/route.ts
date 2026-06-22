import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assets, substructures } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { apiError } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const assetId = parseInt(id);
    if (isNaN(assetId)) return apiError(400, 'INVALID_INPUT', 'Valid asset ID required');

    let session;
    try {
      session = await SessionService.getSession(request);
    } catch (e) {
      return SessionService.handleSessionError(e);
    }
    if (!session?.currentAccountId) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

    const [assetRow] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.accountId, session.currentAccountId), isNull(assets.deletedAt)))
      .limit(1);

    if (!assetRow) return apiError(404, 'NOT_FOUND', 'Asset not found');

    const body = await request.json();
    const order: number[] = body.order;

    if (!Array.isArray(order)) {
      return apiError(400, 'INVALID_INPUT', 'order must be an array of IDs');
    }

    const now = new Date();
    await Promise.all(
      order.map((sid, idx) =>
        db.update(substructures)
          .set({ orderIndex: idx, updatedAt: now })
          .where(and(eq(substructures.id, sid), eq(substructures.assetId, assetId)))
      )
    );

    return NextResponse.json({ updated: true });
  } catch (error) {
    console.error('PATCH /substructures/order error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
