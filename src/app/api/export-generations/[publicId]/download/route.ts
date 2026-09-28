/**
 * GET /api/export-generations/[publicId]/download?file=pdf|zip
 *
 * Téléchargement d'un dossier généré (CDC V12 §17, DRH-005/006/010) :
 *   1. droits revérifiés à CHAQUE demande (bien du compte courant, Duo compris) ;
 *   2. statut prêt ou partiel, fichier non supprimé, non expiré (30 jours) —
 *      sinon 410 avec message générique (« Expiré », « Fichier supprimé ») ;
 *   3. redirection 302 vers une URL signée de courte durée
 *      (`EXPORTS_DOWNLOAD_URL_TTL_S`, 60 s), avec un nom de fichier lisible.
 * Aucune URL signée n'est émise à l'avance (listes, historique).
 */

import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { EXPORT_ERROR_MESSAGES, exportRouteError } from '@/services/exports/export-errors';
import { findAccessibleGeneration } from '@/services/exports/v12/generation/access';
import { normalizeGenerationStatus, outputKeys } from '@/services/exports/v12/generation/status';
import { shortLivedDownloadUrl } from '@/services/exports/v12/storage';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ publicId: string }> }) {
  try {
    const session = await SessionService.getSession(request);
    const { publicId } = await params;
    const found = await findAccessibleGeneration(session, publicId);
    if (!found) return NextResponse.json({ error: 'EXPORT_NOT_FOUND', code: 'EXPORT_NOT_FOUND', message: 'Dossier introuvable.' }, { status: 404 });

    const { row } = found;
    const status = normalizeGenerationStatus(row.status, row.expiresAt);
    if (status === 'expired') {
      return NextResponse.json({ error: 'EXPORT_EXPIRED', code: 'EXPORT_EXPIRED', message: EXPORT_ERROR_MESSAGES.EXPORT_EXPIRED }, { status: 410 });
    }
    if (status === 'deleted' || row.deletedAt) {
      return NextResponse.json({ error: 'EXPORT_FILE_DELETED', code: 'EXPORT_FILE_DELETED', message: EXPORT_ERROR_MESSAGES.EXPORT_FILE_DELETED }, { status: 410 });
    }
    if (status !== 'ready' && status !== 'partial') {
      return NextResponse.json({ error: 'EXPORT_NOT_READY', code: 'EXPORT_NOT_READY', message: EXPORT_ERROR_MESSAGES.EXPORT_NOT_READY }, { status: 409 });
    }

    const wanted = new URL(request.url).searchParams.get('file') === 'zip' ? 'zip' : 'pdf';
    const keys = outputKeys(row.outputPayload);
    const key = wanted === 'zip' ? keys.zip : keys.pdf;
    if (!key) return NextResponse.json({ error: 'EXPORT_FILE_NOT_FOUND', code: 'EXPORT_FILE_NOT_FOUND', message: 'Ce fichier n’existe pas pour ce dossier.' }, { status: 404 });

    let names: { pdfName?: string; zipName?: string } = {};
    try { names = JSON.parse(row.outputPayload ?? '{}'); } catch { /* ancien format */ }
    const fileName = (wanted === 'zip' ? names.zipName : names.pdfName) ?? key.split('/').pop() ?? `dossier.${wanted}`;
    const url = await shortLivedDownloadUrl(key, fileName, wanted === 'zip' ? 'application/zip' : 'application/pdf');
    const res = NextResponse.redirect(url, 302);
    res.headers.set('Cache-Control', 'no-store');
    return res;
  } catch (error) {
    return exportRouteError(error, '[ExportGeneration download]');
  }
}
