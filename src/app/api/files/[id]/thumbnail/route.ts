/**
 * GET /api/files/[id]/thumbnail — miniature autorisée d'un document
 * (APP-PERF-06 images, APP-PERF-27 PDF).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LES LISTES NE TÉLÉCHARGENT PLUS LES ORIGINAUX
 *
 *   · droits : ceux de la lecture (`loadReadableFile` : session, compte
 *     courant, document non supprimé ou source regroupée consultable) ;
 *   · miniature prête ET de la version courante → 302 vers une URL signée
 *     courte du dérivé. Signature arrondie à l'heure : la même URL est
 *     resservie pendant l'heure et le navigateur la garde en cache (cache
 *     PRIVÉ) ; aucune URL publique permanente ;
 *   · absente, en cours, en échec → 404 JSON `{ status }`, non mis en cache :
 *     l'interface affiche un placeholder (ou, pour un PDF, le rendu
 *     navigateur borné). Une absence met la génération en file (rattrapage
 *     paresseux des documents existants), bornée et sans boucle ;
 *   · `?status=1` → toujours du JSON (`{ status }`), sans redirection ;
 *   · `THUMBNAILS_ENABLED=false` (retour arrière) → image : redirection vers
 *     l'ancien proxy de l'original ; PDF : 404 `DISABLED` (rendu navigateur).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { logS3Error } from '@/lib/s3-config';
import { loadReadableFile } from '@/services/documents/file-access';
import { decideThumbnail, thumbnailSourceKind } from '@/services/documents/thumbnails/thumbnail-spec';
import { enqueueThumbnail, getThumbnailRow, thumbnailsEnabled } from '@/services/documents/thumbnails/thumbnail.service';
// Signature arrondie à l'heure et mémorisée, partagée avec l'accueil (lot 26).
import { signedThumbnailUrl } from '@/services/documents/thumbnails/thumbnail-url';

export const dynamic = 'force-dynamic';

function status(code: string, httpStatus: number, asJson: boolean): NextResponse {
  return NextResponse.json({ status: code }, { status: asJson ? 200 : httpStatus, headers: { 'Cache-Control': 'private, no-store' } });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const asJson = request.nextUrl.searchParams.get('status') === '1';
  try {
    const access = await loadReadableFile(request, id);
    if (!access.ok) return access.response;
    const { file } = access;

    const kind = file.s3Key ? thumbnailSourceKind(file) : null;
    if (!kind || !file.s3Key) return status('UNSUPPORTED', 404, asJson);

    if (!thumbnailsEnabled()) {
      if (kind === 'image' && !asJson) {
        return NextResponse.redirect(new URL(`/api/files/${file.id}/proxy`, request.url), {
          status: 302,
          headers: { 'Cache-Control': 'private, no-store' },
        });
      }
      return status('DISABLED', 404, asJson);
    }

    const row = await getThumbnailRow(file.id);
    const decision = decideThumbnail(row, file.s3Key);

    if (decision.action === 'serve') {
      if (asJson) return status('READY', 200, true);
      const url = await signedThumbnailUrl(decision.s3Key);
      // La redirection elle-même n'est gardée qu'une minute : les droits
      // sont recontrôlés à chaque nouvel affichage au-delà.
      return NextResponse.redirect(url, { status: 302, headers: { 'Cache-Control': 'private, max-age=60' } });
    }

    if (decision.action === 'generate') {
      enqueueThumbnail(file.id);
      return status('PENDING', 404, asJson);
    }
    if (decision.action === 'wait') return status('PENDING', 404, asJson);
    return status(decision.reason, 404, asJson);
  } catch (error) {
    logS3Error('GET /api/files/[id]/thumbnail', error);
    return NextResponse.json({ status: 'ERROR' }, { status: 500, headers: { 'Cache-Control': 'private, no-store' } });
  }
}
