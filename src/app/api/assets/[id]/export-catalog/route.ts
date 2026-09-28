/**
 * GET /api/assets/[id]/export-catalog — Catalogue des dossiers du bien.
 *
 * CDC Exports V12 §1.2, §3.1 étape 1, §17 / §26 (`exports/catalog`), EXP-001.
 * Réponse : `{ assetId, family, dossiers[], lastGenerations[], eligibility[] }`
 * (détail : `services/exports/export-catalog.service`).
 *
 * Accès par compte (titulaire ou co-titulaire Duo) ; bien d'un autre compte :
 * 404. Le catalogue reste lisible sur un compte restreint : les dossiers y
 * sont verrouillés avec leur motif, jamais masqués.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { findAccessibleAssetForExport } from '@/services/exports/export-access';
import { loadExportCatalog } from '@/services/exports/export-catalog.service';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await SessionService.getSession(request);
    const n = Number((await params).id);
    if (!Number.isSafeInteger(n) || n <= 0) {
      return NextResponse.json({ error: 'INVALID_ID', code: 'INVALID_ASSET' }, { status: 400 });
    }
    const asset = await findAccessibleAssetForExport(session, n);
    if (!asset) {
      return NextResponse.json({ error: 'ASSET_NOT_FOUND', code: 'INVALID_ASSET', message: 'Bien introuvable.' }, { status: 404 });
    }
    return NextResponse.json(await loadExportCatalog(asset));
  } catch (error) {
    const res = SessionService.handleSessionError(error);
    if (res.status < 500) return res;
    console.error('[export-catalog GET]', error);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', code: 'INTERNAL_ERROR', message: 'Le catalogue des dossiers est momentanément indisponible.' },
      { status: 500 },
    );
  }
}
