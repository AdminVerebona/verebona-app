/**
 * POST /api/assets/[id]/exports/estimate — recalcul de l’estimation (CDC V12 §17.1).
 *
 * Corps : `{ exportType, choices }` (forme §17.2 : outputFormat, sections,
 * items, acknowledgements). Réponse : `{ estimate, actions, messages }` —
 * format final (ZIP dès qu'une pièce est en mode ZIP, ZIP-001), pages et
 * taille estimées, pièces PDF / ZIP, seuils §6.3 (avertissements et
 * blocages, ALT-003), pièces retirées par un « PDF seul » (ALT-002),
 * pièces indisponibles (MSG-PREP-005).
 *
 * Même calcul que la demande de génération (`enqueue.ts`). Sans écriture ;
 * accès par compte (Duo compris), autre compte : 404.
 */

import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { findAccessibleAssetForExport } from '@/services/exports/export-access';
import { EXPORT_ERROR_MESSAGES, exportRouteError } from '@/services/exports/export-errors';
import { estimateDossier } from '@/services/exports/v12/preparation/load';

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

    const result = await estimateDossier({ asset, userId: session.userId, body: body ?? {} });
    if (!result.ok) return NextResponse.json({ error: result.code, code: result.code, message: result.message, ...(result.extra ?? {}) }, { status: result.status });
    return NextResponse.json(result.body);
  } catch (error) {
    return exportRouteError(error, '[Exports estimate]');
  }
}
