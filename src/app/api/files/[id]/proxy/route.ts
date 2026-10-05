/**
 * GET /api/files/[id]/proxy — lecture de même origine d'un fichier.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * FLUX BORNÉ, MÊMES DROITS QUE LA LECTURE DIRECTE (APP-PERF-13)
 *
 * La voie normale de lecture est `/api/files/[id]/view` (droits contrôlés,
 * puis URL signée lue directement sur le stockage). Ce proxy reste pour les
 * usages qui l'imposent : lecture par `fetch` de même origine (CORS du
 * stockage, lien signé expiré), aperçu PDF en repli, ouverture dans un
 * nouvel onglet.
 *
 *   · droits : `loadReadableFile` — session `SessionService` (en-tête ou
 *     cookie ; le paramètre `?token=` n'est plus accepté : un jeton n'a rien
 *     à faire dans une URL), compte courant, fichiers supprimés et sources
 *     regroupées traités comme `view` (`viewableFileCondition`,
 *     grouped_into_file_id IS NOT NULL) ;
 *   · corps relayé en flux (`streamS3Object`) : plus de concaténation de
 *     l'objet complet ; Range/206/416 ; client parti → flux S3 fermé ;
 *   · cache PRIVÉ revalidé à chaque usage (`private, no-cache` + ETag) : un
 *     changement de compte ou une suppression est vu dès la lecture suivante
 *     (304 seulement après recontrôle des droits) ;
 *   · client S3 de la configuration canonique (APP-PERF-26), délais bornés.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getS3Client } from '@/lib/s3-config';
import { streamS3Object, type S3GetFn } from '@/lib/storage/s3-object-stream';
import { loadReadableFile } from '@/services/documents/file-access';

export const dynamic = 'force-dynamic';

/** Délai maximal avant les en-têtes du stockage (ms). */
const HEADERS_TIMEOUT_MS = 15_000;

const s3Get: S3GetFn = (input, signal) =>
  getS3Client('interactive').send(new GetObjectCommand(input), { abortSignal: signal }) as ReturnType<S3GetFn>;

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const params = await context.params;
  try {
    const access = await loadReadableFile(request, params.id);
    if (!access.ok) return access.response;
    const { file } = access;

    if (file.isWebLink || !file.s3Key || !file.s3Bucket || file.s3Bucket === 'weblink') {
      return NextResponse.json({ error: 'NO_STORED_OBJECT' }, { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
    }

    return await streamS3Object({
      bucket: file.s3Bucket,
      key: file.s3Key,
      request,
      get: s3Get,
      contentType: file.mimeType ?? 'application/octet-stream',
      disposition: 'inline',
      knownSize: file.size,
      cacheControl: 'private, no-cache',
      where: 'GET /api/files/[id]/proxy',
      headersTimeoutMs: HEADERS_TIMEOUT_MS,
    });
  } catch (error) {
    // Aucun détail technique dans la réponse (ni URL, ni message SDK).
    console.error('[proxy] Error:', (error as Error)?.name, (error as Error)?.message);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
