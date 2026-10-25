import { NextRequest, NextResponse } from 'next/server';
import { toExportFamily } from '@/services/exports/catalog';
import { db } from '@/db';
import { assets } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { apiError } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';
import { buildCanonicalAssetState, loadAssetRow, type SqlRunner } from '@/services/canonical/asset-state';
import { pgClient } from '@/db';
import { buildSections, type AddressOverride } from '@/services/assets/details-sections';

/*
 * Ordre de lecture de l'adresse (arbitrage lot 16, CDC 15 X-02 / T3-05) : la
 * fiche canonique fait foi, dans l'ordre de `CanonicalAssetView` (clé,
 * alias, colonne miroir — D-10) : la fiche, T2 et les exports affichent la
 * même adresse. Lot 16b-3 : toujours (commutateurs `CANONICAL_WRITE_MODE` et
 * `EXPORTS_CANONICAL_SOURCE` supprimés).
 */

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

    if (assetRow.status === 'ARCHIVED' || assetRow.lockState && assetRow.lockState !== 'NONE') {
      return NextResponse.json(
        { error: 'ASSET_UNAVAILABLE', reason: assetRow.status === 'ARCHIVED' ? 'ARCHIVED' : 'LOCKED_BY_PLAN' },
        { status: 403 }
      );
    }

    let kc: Record<string, unknown> = {};
    try { kc = assetRow.keyCharacteristics ? JSON.parse(assetRow.keyCharacteristics) : {}; } catch {}

    // Determine family
    const family = toExportFamily(assetRow.category) ?? 'OBJET';

    // Adresse : fiche canonique (lecture unique, D-10).
    let adresse: AddressOverride | null = null;
    if (family === 'IMMOBILIER') {
      const row = await loadAssetRow(pgClient as unknown as SqlRunner, assetId, session.currentAccountId);
      const f = row ? buildCanonicalAssetState(row).fields : {};
      adresse = { address1: f.address1?.value ?? null, postalCode: f.postalCode?.value ?? null, city: f.city?.value ?? null };
    }
    const sections = buildSections(family, kc, assetRow as unknown as Record<string, unknown>, adresse);

    // Lot 71B : plus d'alertes « Incohérence » à appliquer sur la fiche (ancien
    // blob `coherenceAlerts`, repris en cartes « À traiter » par 0109).
    return NextResponse.json({ family, sections });
  } catch (error) {
    console.error('GET /details error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
