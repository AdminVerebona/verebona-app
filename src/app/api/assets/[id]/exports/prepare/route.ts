/**
 * POST /api/assets/[id]/exports/prepare — préparation d'un dossier (CDC V12 §17.1).
 *
 * Corps : `{ exportType, includeCurrentSelections?, choices?, clientContext? }`.
 * Réponse : sections du PDF (ordre des templates), éléments proposés avec
 * pré-sélection §6.2 / §24, compatibilité et modes PDF / ZIP, état des blocs
 * CIL, estimation, alertes, messages §5.4 et actions (`canGeneratePdf`,
 * `canGenerateZip`) — voir `services/exports/v12/preparation/types.ts`.
 *
 * Déterministe et sans écriture. Accès par compte (Duo compris) ; un bien
 * d'un autre compte est introuvable (404). Erreurs §17.3 : 400
 * INVALID_EXPORT_TYPE, 404 ASSET_NOT_FOUND, 422 NOT_ELIGIBLE, 403 offre.
 */

import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { findAccessibleAssetForExport } from '@/services/exports/export-access';
import { EXPORT_ERROR_MESSAGES, exportRouteError } from '@/services/exports/export-errors';
import { prepareDossier } from '@/services/exports/v12/preparation/load';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await SessionService.getSession(request);
    const { id } = await params;
    const assetId = Number.parseInt(id, 10);
    if (!Number.isSafeInteger(assetId) || assetId <= 0) return NextResponse.json({ error: 'INVALID_ID', code: 'INVALID_ID', message: 'Identifiant invalide.' }, { status: 400 });

    const asset = await findAccessibleAssetForExport(session, assetId);
    if (!asset) return NextResponse.json({ error: 'ASSET_NOT_FOUND', code: 'ASSET_NOT_FOUND', message: EXPORT_ERROR_MESSAGES.ASSET_NOT_FOUND }, { status: 404 });

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: 'INVALID_PAYLOAD', code: 'INVALID_PAYLOAD', message: 'Requête invalide.' }, { status: 400 });
    }

    const result = await prepareDossier({ asset, userId: session.userId, body: body ?? {} });
    if (!result.ok) return NextResponse.json({ error: result.code, code: result.code, message: result.message, ...(result.extra ?? {}) }, { status: result.status });
    return NextResponse.json(result.body);
  } catch (error) {
    return exportRouteError(error, '[Exports prepare]');
  }
}
