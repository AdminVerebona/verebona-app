import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assets } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { apiError } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';
import { clampTimelineLimit, decodeTimelineCursor, parseTimelineMode } from '@/services/agenda/timeline/model';
import { readAssetTimelinePage } from '@/services/agenda/timeline/read';

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
    // Lot 84C (CDC v5 §13, O-4) : Timeline regroupée (défaut, jamais
    // mémorisée) ou détaillée, regroupée AVANT pagination (E10), par curseur.
    // `section=timeline` : page de Timeline seule (bascule de mode, « Afficher plus »).
    const sp = request.nextUrl.searchParams;
    const mode = parseTimelineMode(sp.get('mode'));
    if (!mode) return apiError(400, 'INVALID_INPUT', 'Unknown timeline mode');
    const cursor = decodeTimelineCursor(sp.get('cursor'), mode);
    if (cursor === 'INVALID') return apiError(400, 'INVALID_INPUT', 'Invalid timeline cursor');
    const timelineInput = { accountId: session.currentAccountId, assetId, mode, cursor, limit: clampTimelineLimit(sp.get('limit')), today };
    if (sp.get('section') === 'timeline') {
      const page = await readAssetTimelinePage(timelineInput);
      const res = NextResponse.json({ timeline: page.entries, timelinePage: { mode: page.mode, nextCursor: page.nextCursor, remaining: page.remaining } });
      res.headers.set('Cache-Control', 'private, no-cache');
      return res;
    }
    const sql = db.$client;
    // Lot 53 (retour PO D23) : une relation intercomptes héritée (document ou
    // élément d'agenda d'un AUTRE compte rattaché à ce bien) n'est jamais lue.
    const accountId = session.currentAccountId;

    // All queries in parallel
    //
    // ⚠️ `document_date` est de type DATE. Le mêler à du texte dans COALESCE
    // faisait échouer la requête des documents (« COALESCE types date and
    // text cannot be matched ») — et avec elle toute la vue d'ensemble :
    // « Impossible de charger la vue d'ensemble ». Les deux côtés sont
    // désormais convertis en texte (AAAA-MM-JJ… : l'ordre est conservé).
    const [timelinePage, docs, countersRow] = await Promise.all([
      // Lot 84C : Timeline calculée à la lecture (agenda_items / agenda_asset_links,
      // « annule » exclu), regroupée avant pagination — `services/agenda/timeline`.
      readAssetTimelinePage(timelineInput),
      sql<{ id: number; original_filename: string; retained_title: string | null; document_type: string; document_date: string | null }[]>`
        SELECT id, original_filename, retained_title, document_type, document_date
        FROM asset_files
        -- Lot 32C (PO 9) : documents du bien = colonnes OU liens PRIMARY / SECONDARY.
        WHERE (asset_id = ${assetId} OR linked_asset_id = ${assetId}
               OR id IN (SELECT file_id FROM document_asset_links
                          WHERE asset_id = ${assetId} AND status = 'ACTIVE' AND link_role IN ('PRIMARY', 'SECONDARY')))
          AND account_id = ${accountId} AND deleted_at IS NULL AND upload_status = 'COMPLETED'
        ORDER BY COALESCE(document_date::text, uploaded_at::text) DESC NULLS LAST
        LIMIT 3
      `,
      // All counts in a single query
      sql<{ doc_count: string; agenda_count: string; room_count: string; eq_count: string }[]>`
        SELECT
          (SELECT COUNT(*) FROM asset_files
            WHERE (asset_id = ${assetId} OR linked_asset_id = ${assetId}
                   OR id IN (SELECT file_id FROM document_asset_links
                              WHERE asset_id = ${assetId} AND status = 'ACTIVE' AND link_role IN ('PRIMARY', 'SECONDARY')))
              AND account_id = ${accountId} AND deleted_at IS NULL AND upload_status = 'COMPLETED')::text AS doc_count,
          (SELECT COUNT(*) FROM agenda_asset_links aal
            INNER JOIN agenda_items ai ON ai.id = aal.agenda_item_id
            WHERE aal.asset_id = ${assetId} AND ai.account_id = ${accountId}
              AND (ai.manual_status IS NULL OR ai.manual_status != 'annule'))::text AS agenda_count,
          (SELECT COUNT(*) FROM substructures WHERE asset_id = ${assetId})::text AS room_count,
          (SELECT COUNT(*) FROM equipments WHERE asset_id = ${assetId} AND archived_at IS NULL)::text AS eq_count
      `,
    ]);

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
      // Entrées de la Timeline (forme historique au premier niveau : id, title,
      // effectiveDate, isDone, isOverdue, toConfirm) + `kind` / `members` / `counters`.
      timeline: timelinePage.entries,
      timelinePage: { mode: timelinePage.mode, nextCursor: timelinePage.nextCursor, remaining: timelinePage.remaining },
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
    // APP-PERF-22 : pas de réutilisation par le cache HTTP du navigateur.
    res.headers.set('Cache-Control', 'private, no-cache');
    return res;
  } catch (error) {
    console.error('GET /overview error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
