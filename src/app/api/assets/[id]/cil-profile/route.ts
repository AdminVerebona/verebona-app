/**
 * GET  /api/assets/[id]/cil-profile  — Récupère le profil CIL d'un bien
 * POST /api/assets/[id]/cil-profile  — Crée ou met à jour le profil CIL
 */

import { NextRequest, NextResponse } from 'next/server';
import { emitBusinessEvent } from '@/services/verebona-assistant/events/business-events';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { assets, assetCilProfiles } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { refuserSiModificationBiensSuspendue } from '@/lib/asset-quota-guard';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await SessionService.getSession(request);
    const { id } = await params;
    const assetId = parseInt(id);
    if (isNaN(assetId)) return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });

    const [asset] = await db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.userId, session.userId)))
      .limit(1);
    if (!asset) return NextResponse.json({ error: 'ASSET_NOT_FOUND' }, { status: 404 });

    const [profile] = await db
      .select()
      .from(assetCilProfiles)
      .where(eq(assetCilProfiles.assetId, assetId))
      .limit(1);

    return NextResponse.json({ profile: profile ?? null });
  } catch (err: any) {
    console.error('[CIL profile GET]', err);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await SessionService.getSession(request);
    const { id } = await params;
    const assetId = parseInt(id);
    if (isNaN(assetId)) return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });

    const [asset] = await db
      .select({ id: assets.id, accountId: assets.accountId })
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.userId, session.userId)))
      .limit(1);
    if (!asset) return NextResponse.json({ error: 'ASSET_NOT_FOUND' }, { status: 404 });

    // Au-dessus du quota après un changement d'offre : modification suspendue (GAP-11).
    const refusQuota = asset.accountId != null ? await refuserSiModificationBiensSuspendue(asset.accountId) : null;
    if (refusQuota) return refusQuota;

    const body = await request.json();
    const { triggerType, triggerDate, authorizationType, voluntaryReason } = body as {
      triggerType: string;
      triggerDate?: string | null;
      authorizationType?: string | null;
      voluntaryReason?: string | null;
    };

    if (!triggerType) return NextResponse.json({ error: 'MISSING_TRIGGER_TYPE' }, { status: 400 });

    const existing = await db
      .select({ id: assetCilProfiles.id })
      .from(assetCilProfiles)
      .where(eq(assetCilProfiles.assetId, assetId))
      .limit(1);

    const now = new Date();

    if (existing.length > 0) {
      await db
        .update(assetCilProfiles)
        .set({
          triggerType,
          triggerDate: triggerDate ?? null,
          authorizationType: authorizationType ?? null,
          voluntaryReason: voluntaryReason ?? null,
          updatedAt: now,
        })
        .where(eq(assetCilProfiles.assetId, assetId));
    } else {
      await db.insert(assetCilProfiles).values({
        assetId,
        triggerType,
        triggerDate: triggerDate ?? null,
        authorizationType: authorizationType ?? null,
        voluntaryReason: voluntaryReason ?? null,
        createdAt: now,
        updatedAt: now,
      });
    }

    const [updated] = await db
      .select()
      .from(assetCilProfiles)
      .where(eq(assetCilProfiles.assetId, assetId))
      .limit(1);

    // CDC Assistant §25.7, §31.7.
    if (asset.accountId != null) await emitBusinessEvent({ type: 'ASSET_UPDATED', accountId: asset.accountId, entityId: assetId });
    return NextResponse.json({ profile: updated });
  } catch (err: any) {
    console.error('[CIL profile POST]', err);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
