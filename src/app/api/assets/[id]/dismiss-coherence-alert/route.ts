/**
 * POST /api/assets/[id]/dismiss-coherence-alert
 * Ajoute le champ à la liste dismissedCoherenceAlerts dans keyCharacteristics.
 * L'alerte ne sera plus remontée par le système.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assets } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { SessionService } from '@/lib/session-service';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const assetId = parseInt(id);
    if (isNaN(assetId)) {
      return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });
    }

    let session;
    try {
      session = await SessionService.getSession(req);
    } catch (e) {
      return SessionService.handleSessionError(e);
    }
    if (!session?.currentAccountId) {
      return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
    }

    const body = await req.json();
    const { field } = body;
    if (!field || typeof field !== 'string') {
      return NextResponse.json({ error: 'INVALID_INPUT', message: 'field (string) is required' }, { status: 400 });
    }

    // Load current keyCharacteristics
    const [assetRow] = await db
      .select({ id: assets.id, keyCharacteristics: assets.keyCharacteristics })
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.accountId, session.currentAccountId), isNull(assets.deletedAt)))
      .limit(1);

    if (!assetRow) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }

    let kc: Record<string, unknown> = {};
    try { kc = assetRow.keyCharacteristics ? JSON.parse(assetRow.keyCharacteristics) : {}; } catch {}

    // Initialize or update dismissedCoherenceAlerts
    const dismissed: string[] = Array.isArray(kc.dismissedCoherenceAlerts)
      ? kc.dismissedCoherenceAlerts as string[]
      : [];

    if (!dismissed.includes(field)) {
      dismissed.push(field);
    }

    kc.dismissedCoherenceAlerts = dismissed;

    // Also remove any existing coherence alert for this field
    const alerts = Array.isArray(kc.coherenceAlerts)
      ? (kc.coherenceAlerts as Array<{ field: string }>).filter(a => a.field !== field)
      : [];
    kc.coherenceAlerts = alerts;

    await db.update(assets)
      .set({
        keyCharacteristics: JSON.stringify(kc),
        updatedAt: new Date(),
      })
      .where(eq(assets.id, assetId));

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('POST /dismiss-coherence-alert error:', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
