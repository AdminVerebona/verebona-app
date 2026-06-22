import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assets } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { apiError } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';

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

    const today = new Date().toISOString().split('T')[0];
    const sql = db.$client;

    // All queries in parallel
    const [agendaRows, docs, countersRow] = await Promise.all([
      // Agenda items linked to this asset via agenda_asset_links (excludes cancelled)
      sql<{ id: number; title: string; start_date: string | null; end_date: string | null; manual_status: string | null }[]>`
        SELECT ai.id, ai.title, ai.start_date, ai.end_date, ai.manual_status
        FROM agenda_items ai
        INNER JOIN agenda_asset_links aal ON aal.agenda_item_id = ai.id
        WHERE aal.asset_id = ${assetId}
          AND (ai.manual_status IS NULL OR ai.manual_status != 'annule')
        ORDER BY ai.start_date ASC NULLS LAST
        LIMIT 50
      `,
      sql<{ id: number; original_filename: string; retained_title: string | null; document_type: string; document_date: string | null }[]>`
        SELECT id, original_filename, retained_title, document_type, document_date
        FROM asset_files
        WHERE asset_id = ${assetId} AND deleted_at IS NULL AND upload_status = 'COMPLETED'
        ORDER BY COALESCE(document_date, uploaded_at::text) DESC NULLS LAST
        LIMIT 3
      `,
      // All counts in a single query
      sql<{ doc_count: string; agenda_count: string; room_count: string; eq_count: string }[]>`
        SELECT
          (SELECT COUNT(*) FROM asset_files WHERE asset_id = ${assetId} AND deleted_at IS NULL AND upload_status = 'COMPLETED')::text AS doc_count,
          (SELECT COUNT(*) FROM agenda_asset_links aal
            INNER JOIN agenda_items ai ON ai.id = aal.agenda_item_id
            WHERE aal.asset_id = ${assetId}
              AND (ai.manual_status IS NULL OR ai.manual_status != 'annule'))::text AS agenda_count,
          (SELECT COUNT(*) FROM substructures WHERE asset_id = ${assetId})::text AS room_count,
          (SELECT COUNT(*) FROM equipments WHERE asset_id = ${assetId} AND archived_at IS NULL)::text AS eq_count
      `,
    ]);

    // Build timeline from agenda items
    const timeline = agendaRows.map(item => {
      const isDone = item.manual_status === 'realise';
      const effectiveDate = item.start_date ?? null;
      const isOverdue = !isDone && !!effectiveDate && effectiveDate < today;
      return {
        itemType: 'agenda' as const,
        id: String(item.id),
        title: item.title,
        effectiveDate,
        isDone,
        isOverdue,
      };
    }).sort((a, b) => {
      if (!a.effectiveDate && !b.effectiveDate) return 0;
      if (!a.effectiveDate) return 1;
      if (!b.effectiveDate) return -1;
      return a.effectiveDate < b.effectiveDate ? -1 : 1;
    });

    const c = countersRow[0] ?? { doc_count: '0', agenda_count: '0', room_count: '0', eq_count: '0' };

    let kc: Record<string, unknown> = {};
    try { kc = assetRow.keyCharacteristics ? JSON.parse(assetRow.keyCharacteristics) : {}; } catch {}
    let objectDetails: Record<string, unknown> = {};
    try { objectDetails = assetRow.objectDetails ? JSON.parse(assetRow.objectDetails) : {}; } catch {}

    const res = NextResponse.json({
      asset: {
        id: assetRow.id,
        name: assetRow.name,
        category: assetRow.category,
        subtype: assetRow.subtype,
        objectCategory: assetRow.objectCategory ?? null,
        objectDetails,
        status: assetRow.status,
        keyCharacteristics: kc,
        purchaseDate: assetRow.purchaseDate ?? null,
        purchasePriceCents: assetRow.purchasePriceCents ?? null,
        generalCondition: assetRow.generalCondition ?? null,
        estimatedValueCents: assetRow.estimatedValueCents ?? null,
        warrantyEndDate: assetRow.warrantyEndDate ?? null,
        mileageOrHours: assetRow.mileageOrHours ?? null,
        lastMaintenanceDate: assetRow.lastMaintenanceDate ?? null,
        registrationNumber: assetRow.registrationNumber ?? null,
        address: assetRow.address ?? null,
        city: assetRow.city ?? null,
      },
      timeline,
      documentsPreview: docs.map(d => ({
        id: d.id,
        originalFilename: d.original_filename,
        retainedTitle: d.retained_title ?? null,
        documentType: d.document_type,
        documentDate: d.document_date,
      })),
      counters: {
        documents: parseInt(c.doc_count),
        agenda: parseInt(c.agenda_count),
        rooms: parseInt(c.room_count),
        equipments: parseInt(c.eq_count),
      },
    });
    res.headers.set('Cache-Control', 'private, max-age=30, stale-while-revalidate=60');
    return res;
  } catch (error) {
    console.error('GET /overview error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
