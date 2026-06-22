/**
 * PATCH /api/assets/[id]/exports/cil/resolutions
 * Marque un bloc CIL comme not_applicable ou unknown_confirmed
 * DELETE /api/assets/[id]/exports/cil/resolutions
 * Supprime la résolution d'un bloc (remet en statut calculé)
 */

import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { assets, cilBlockResolutions } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

export async function PATCH(
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

    const body = await request.json();
    const { blockId, resolution, justification } = body as {
      blockId: string;
      resolution: 'not_applicable' | 'unknown_confirmed';
      justification?: string;
    };

    if (!blockId || !resolution) {
      return NextResponse.json({ error: 'MISSING_FIELDS' }, { status: 400 });
    }

    // Upsert
    const existing = await db
      .select({ id: cilBlockResolutions.id })
      .from(cilBlockResolutions)
      .where(and(
        eq(cilBlockResolutions.assetId, assetId),
        eq(cilBlockResolutions.blockId, blockId),
      ))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(cilBlockResolutions)
        .set({ resolution, justification: justification ?? null, resolvedByUserId: session.userId, resolvedAt: new Date() })
        .where(and(
          eq(cilBlockResolutions.assetId, assetId),
          eq(cilBlockResolutions.blockId, blockId),
        ));
    } else {
      await db.insert(cilBlockResolutions).values({
        assetId,
        blockId,
        resolution,
        justification: justification ?? null,
        resolvedByUserId: session.userId,
        resolvedAt: new Date(),
      });
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[CIL resolutions PATCH]', err);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}

export async function DELETE(
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

    const { searchParams } = new URL(request.url);
    const blockId = searchParams.get('blockId');
    if (!blockId) return NextResponse.json({ error: 'MISSING_BLOCK_ID' }, { status: 400 });

    await db
      .delete(cilBlockResolutions)
      .where(and(
        eq(cilBlockResolutions.assetId, assetId),
        eq(cilBlockResolutions.blockId, blockId),
      ));

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[CIL resolutions DELETE]', err);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
