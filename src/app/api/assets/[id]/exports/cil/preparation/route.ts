/**
 * GET /api/assets/[id]/exports/cil/preparation
 * Retourne l'éligibilité CIL + l'état de complétude des blocs B1-B9 (CDC §6.3)
 *
 * L'évaluation des blocs est partagée avec la génération
 * (`services/exports/cil-preparation.service`) : ce que l'écran affiche comme
 * « action requise » est aussi ce que le serveur refuse de générer.
 */

import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { exportGenerations } from '@/db/schema';
import { eq, and, ne, desc } from 'drizzle-orm';
import { isCilEligible, CIL_NOT_ELIGIBLE_MESSAGE } from '@/lib/asset-capabilities';
import { findAccessibleAssetForExport } from '@/services/exports/export-access';
import { evaluateCilReadiness } from '@/services/exports/cil-preparation.service';
import { exportRouteError } from '@/services/exports/export-errors';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await SessionService.getSession(request);
    const { id } = await params;
    const assetId = parseInt(id);
    if (isNaN(assetId)) return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });

    // Accès par compte (Duo compris) — même règle que les autres routes du bien.
    const asset = await findAccessibleAssetForExport(session, assetId);
    if (!asset) return NextResponse.json({ error: 'ASSET_NOT_FOUND' }, { status: 404 });

    // Eligibility check
    // Maison + Appartement uniquement (GAP-08) — liste unique partagée avec
    // la génération (`exports/route.ts`) et l'interface.
    if (!isCilEligible(asset)) {
      return NextResponse.json({
        assetId,
        eligible: false,
        eligibilityReason: 'not_eligible_asset_subtype',
        message: CIL_NOT_ELIGIBLE_MESSAGE,
      });
    }

    const { globalStatus, completion, blocks } = await evaluateCilReadiness(asset);

    // Last export_generation CIL
    const [lastGen] = await db
      .select({ id: exportGenerations.id, publicId: exportGenerations.publicId, createdAt: exportGenerations.createdAt, status: exportGenerations.status })
      .from(exportGenerations)
      .where(and(
        eq(exportGenerations.assetId, assetId),
        eq(exportGenerations.exportType, 'CIL_REGLEMENTAIRE'),
        ne(exportGenerations.status, 'deleted'),
        ne(exportGenerations.status, 'cancelled'),
      ))
      .orderBy(desc(exportGenerations.createdAt))
      .limit(1);

    return NextResponse.json({
      assetId,
      eligible: true,
      eligibilityReason: 'maison_ou_appartement',
      globalStatus,
      completion,
      blocks,
      lastGeneration: lastGen
        ? {
            id: lastGen.id,
            publicId: lastGen.publicId,
            createdAt: lastGen.createdAt,
            status: lastGen.status,
            downloadUrl: null,
          }
        : null,
      assetName: asset.name,
      assetAddress: [asset.address, asset.postalCode, asset.city].filter(Boolean).join(', '),
      assetSubtype: asset.subtype,
    });
  } catch (err) {
    return exportRouteError(err, '[CIL preparation]');
  }
}
