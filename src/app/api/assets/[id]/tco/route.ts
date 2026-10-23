/**
 * GET /api/assets/[id]/tco — coût total de possession du bien (lot 54D,
 * ticket §3 ; CDC Opérations V1 C17).
 *
 * Droits (§3.7) : Premium, Premium Duo (données du compte, partagées par ses
 * utilisateurs autorisés) et essai → TCO complet. Standard (ou compte sans
 * fonctions Premium) → 403 `PREMIUM_REQUIRED` AVANT toute lecture
 * financière : aucun montant, aucun détail. Rien n'est supprimé au
 * changement d'offre : le calcul est relu à chaque appel.
 *
 * Lecture seule : le TCO est recalculé depuis les composantes consolidées
 * (aucune écriture, aucune Opération créée).
 *
 * Lot 75D (J) : `?linesOffset=&linesLimit=` — page du détail des lignes
 * (chargement complémentaire) ; synthèse et ventilation toujours exactes.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { findAccessibleAssetForExport } from '@/services/exports/export-access';
import { getEntitlements } from '@/services/entitlements.service';
import { notFound, parsePositiveId } from '@/services/assets/asset-route-helpers';
import { AssetNotFoundForTcoError, readAssetTco } from '@/services/business-operations/tco/service';
import { parseTcoLinesPage, TCO_PREMIUM_MESSAGE, toTcoDto } from '@/services/business-operations/tco/dto';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  try {
    const session = await SessionService.getSession(request);
    const assetId = parsePositiveId((await params).id);
    if (!assetId) return NextResponse.json({ error: 'INVALID_ID', code: 'INVALID_ASSET' }, { status: 400 });
    const asset = await findAccessibleAssetForExport(session, assetId);
    if (!asset) return notFound();
    const droits = await getEntitlements(asset.accountId);
    if (!droits.premiumFeatures) {
      return NextResponse.json({ error: 'PREMIUM_REQUIRED', code: 'PREMIUM_REQUIRED', message: TCO_PREMIUM_MESSAGE, locked: true }, { status: 403 });
    }
    const tco = await readAssetTco(asset.accountId, assetId);
    // Lot 75D (J) : page de lignes demandée (chargement complémentaire) — les totaux portent toujours sur la trace complète.
    return NextResponse.json({ assetId, tco: toTcoDto(tco, parseTcoLinesPage(request.nextUrl.searchParams)), canEdit: droits.canWrite });
  } catch (error) {
    if (error instanceof AssetNotFoundForTcoError) return notFound();
    console.error('[tco] GET :', (error as Error).message);
    // §4.4 : une erreur technique n'est jamais présentée comme un total.
    return NextResponse.json({ error: 'TCO_UNAVAILABLE', code: 'TCO_UNAVAILABLE', status: 'ERROR', message: 'Le coût de possession n’a pas pu être calculé. Réessayez plus tard.' }, { status: 500 });
  }
}
