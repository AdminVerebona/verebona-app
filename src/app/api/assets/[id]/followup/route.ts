/**
 * GET /api/assets/[id]/followup
 *
 * Returns agenda items linked to this asset, shaped as a flat FollowupItem list
 * for the AssetFollowupTab component.
 *
 * Source canonique : agenda_items (via agendaAssetLinks).
 * Les anciens objets `events` et `deadlines` ne sont plus interrogés ici.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assets, agendaItems, agendaAssetLinks } from '@/db/schema';
import { eq, and, isNull, desc } from 'drizzle-orm';
import { apiError } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';
import { computeEffectiveStatus, type EffectiveStatus } from '@/services/agenda/AgendaDomainService';

export async function GET(
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

    if (assetRow.status === 'ARCHIVED' || (assetRow.lockState && assetRow.lockState !== 'NONE')) {
      return NextResponse.json(
        { error: 'ASSET_UNAVAILABLE', reason: assetRow.status === 'ARCHIVED' ? 'ARCHIVED' : 'LOCKED_BY_PLAN' },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);
    const includeDone = searchParams.get('includeDone') === 'true';
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '50'), 200);
    const offset = parseInt(searchParams.get('offset') ?? '0');

    // Fetch agenda items linked to this asset
    const rows = await db
      .select({
        id: agendaItems.id,
        publicId: agendaItems.publicId,
        title: agendaItems.title,
        description: agendaItems.description,
        startDate: agendaItems.startDate,
        endDate: agendaItems.endDate,
        manualStatus: agendaItems.manualStatus,
        originType: agendaItems.originType,
        requiresQualification: agendaItems.requiresQualification,
        createdAt: agendaItems.createdAt,
      })
      .from(agendaItems)
      .innerJoin(agendaAssetLinks, eq(agendaAssetLinks.agendaItemId, agendaItems.id))
      .where(
        and(
          eq(agendaItems.accountId, session.currentAccountId),
          eq(agendaAssetLinks.assetId, assetId)
        )
      )
      .orderBy(desc(agendaItems.startDate));

    type FollowupItem = {
      itemType: 'agenda';
      id: string;
      publicId: string;
      title: string;
      effectiveDate: string | null;
      effectiveStatus: EffectiveStatus;
      isDone: boolean;
      isOverdue: boolean;
      description: string | null;
      originType: string;
      requiresQualification: boolean;
    };

    const typedItems: FollowupItem[] = rows.flatMap(r => {
      const effectiveStatus = computeEffectiveStatus({
        startDate: r.startDate ?? null,
        startTime: null,
        endDate: r.endDate ?? null,
        endTime: null,
        manualStatus: (r.manualStatus as 'realise' | 'annule' | null) ?? null,
      });
      const isDone = effectiveStatus === 'realise' || effectiveStatus === 'annule';
      if (!includeDone && isDone) return [];
      return [{
        itemType: 'agenda' as const,
        id: String(r.id),
        publicId: r.publicId,
        title: r.title,
        effectiveDate: r.startDate ?? null,
        effectiveStatus,
        isDone,
        isOverdue: effectiveStatus === 'en_retard',
        description: r.description ?? null,
        originType: r.originType,
        requiresQualification: r.requiresQualification,
      }];
    });

    const total = typedItems.length;
    const paginated = typedItems.slice(offset, offset + limit);

    return NextResponse.json({ items: paginated, total });
  } catch (error) {
    console.error('GET /followup error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
