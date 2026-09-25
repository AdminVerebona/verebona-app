import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';
import {
  ALL_DETAIL_SECTIONS, AssetDetailsError, familySections, loadWritableAsset, updateAssetDetails,
} from '@/services/asset-details-write.service';

/**
 * PATCH /api/assets/[id]/details/[section]
 *
 * Les règles d'écriture vivent dans `asset-details-write.service` : l'assistant
 * (commande UPDATE_ASSET_FIELD) les applique à l'identique. Cette route ne fait
 * plus que l'authentification et la traduction des refus en réponses HTTP —
 * mêmes codes et mêmes corps qu'avant l'extraction.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; section: string }> }
) {
  try {
    const { id, section } = await params;
    const assetId = parseInt(id);
    if (isNaN(assetId)) return apiError(400, 'INVALID_INPUT', 'Valid asset ID required');

    if (!ALL_DETAIL_SECTIONS.includes(section)) {
      return apiError(404, 'NOT_FOUND', `Section unknown: ${section}`);
    }

    let session;
    try {
      session = await SessionService.getSession(request);
    } catch (e) {
      return SessionService.handleSessionError(e);
    }
    if (!session?.currentAccountId) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

    // Même ordre de contrôles qu'avant l'extraction : bien et section
    // d'abord, corps de la requête ensuite.
    const asset = await loadWritableAsset(assetId, session.currentAccountId);
    if (!familySections(asset.category).includes(section)) {
      return NextResponse.json({ error: 'SECTION_NOT_APPLICABLE' }, { status: 400 });
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return apiError(400, 'INVALID_INPUT', 'Invalid JSON body');
    }

    const fields: Record<string, unknown> = (body.fields as Record<string, unknown> | undefined) ?? body;

    const result = await updateAssetDetails({
      assetId, accountId: session.currentAccountId, section, fields,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AssetDetailsError) {
      switch (error.code) {
        case 'NOT_FOUND':
          return apiError(404, 'NOT_FOUND', error.message);
        case 'ASSET_UNAVAILABLE':
          return NextResponse.json({ error: 'ASSET_UNAVAILABLE', reason: error.details.reason }, { status: 403 });
        case 'SECTION_NOT_APPLICABLE':
          return NextResponse.json({ error: 'SECTION_NOT_APPLICABLE' }, { status: 400 });
        case 'VALIDATION_ERROR':
          // `message` : lu tel quel par le toast de la fiche bien.
          return NextResponse.json(
            { error: 'VALIDATION_ERROR', message: error.message, fields: error.details.fields ?? [] },
            { status: 422 },
          );
      }
    }
    console.error('PATCH /details/[section] error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
