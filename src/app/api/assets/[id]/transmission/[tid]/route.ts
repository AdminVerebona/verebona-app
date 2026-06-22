/**
 * DELETE /api/assets/[id]/transmission/[tid]
 * Annulation d'une transmission par l'émetteur
 * Conditions : status = 'pending' uniquement
 */

import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { assets, assetTransmissions } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; tid: string }> },
) {
  try {
    const session = await SessionService.getSession(request);
    const { id, tid } = await params;
    const assetId = parseInt(id);
    const transmissionId = parseInt(tid);

    if (isNaN(assetId) || isNaN(transmissionId)) {
      return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });
    }

    // Verify asset ownership
    const [asset] = await db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.userId, session.userId)))
      .limit(1);
    if (!asset) return NextResponse.json({ error: 'ASSET_NOT_FOUND' }, { status: 404 });

    // Load transmission
    const [transmission] = await db
      .select({ id: assetTransmissions.id, status: assetTransmissions.status })
      .from(assetTransmissions)
      .where(and(
        eq(assetTransmissions.id, transmissionId),
        eq(assetTransmissions.assetId, assetId),
        eq(assetTransmissions.initiatorUserId, session.userId),
      ))
      .limit(1);

    if (!transmission) return NextResponse.json({ error: 'TRANSMISSION_NOT_FOUND' }, { status: 404 });

    if (transmission.status !== 'pending') {
      return NextResponse.json({
        error: 'CANNOT_CANCEL',
        message: `Transmission in status '${transmission.status}' cannot be cancelled`,
      }, { status: 400 });
    }

    await db
      .update(assetTransmissions)
      .set({ status: 'cancelled', cancelledAt: new Date() })
      .where(eq(assetTransmissions.id, transmissionId));

    return NextResponse.json({ success: true, status: 'cancelled' });
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
}
