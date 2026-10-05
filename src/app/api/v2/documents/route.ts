/**
 * GET /api/v2/documents — documents par lots, tri et filtres globaux
 * (CDC V2.0 §4, §13.5 ; ticket DOC-PERF « chargement progressif »).
 *
 * Une seule route pour les deux écrans : sans `?assets=`, c'est « Mes
 * documents » ; avec, c'est l'onglet « Documents » d'un bien. Le §4.1 exige ce
 * contrat commun, et deux routes auraient fini par calculer deux compteurs
 * différents pour la même chose.
 *
 *   ?limit=50               taille du lot (défaut 50, plafond serveur 100)
 *   ?cursor=…               curseur opaque renvoyé par le lot précédent
 *   ?sort=added|docDate|title|bien|rubric  &  ?direction=asc|desc
 *   ?grouped=1              ordre « Rubrique, puis tri » (regroupement)
 *   ?assets=12,45           restreint au périmètre d'un ou plusieurs biens
 *   ?biens=12,__NO_ASSET__  ?rubrics=MEDIA,__UNFILED__  ?types=DPE,__NO_TYPE__
 *   ?ids=3,4 | none         résultats d'une recherche de l'assistant
 *
 * Réponse : `{ documents, nextCursor, hasMore, limit, meta? }` ; `meta`
 * (compteurs globaux, options de filtre) accompagne le premier lot. En fin de
 * liste, `nextCursor: null, hasMore: false`.
 *
 * `pageSize=all` n'existe plus : le navigateur ne reçoit jamais tout le
 * périmètre d'un bloc.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { parseFeedParams } from '@/lib/documents/document-feed';
import { InvalidCursorError, getDocumentFeed } from '@/services/documents/rubric-query.service';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  let session;
  try {
    session = await SessionService.getSession(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }

  const accountId = session.currentAccountId;
  if (!accountId) {
    return NextResponse.json({ error: 'NO_ACCOUNT_SELECTED' }, { status: 400 });
  }

  const params = parseFeedParams(req.nextUrl.searchParams);
  const phase = params.cursor ? 'next' : 'first';
  const started = performance.now();

  try {
    const page = await getDocumentFeed({ ...params, accountId });
    const body = JSON.stringify(page);
    // Observabilité (DOC-PERF) : durée, volume et taille du lot. Jamais le
    // contenu des documents, ni le curseur, ni une URL.
    console.info('[documents/feed]', JSON.stringify({
      phase,
      ms: Math.round(performance.now() - started),
      count: page.documents.length,
      bytes: body.length,
      hasMore: page.hasMore,
      limit: params.limit,
      sort: params.sort,
      grouped: params.grouped,
      filtered: params.filters.biens.length + params.filters.rubrics.length + params.filters.types.length > 0,
    }));
    return new NextResponse(body, {
      headers: {
        'Content-Type': 'application/json',
        // Pas de cache partagé ni de réponse servie périmée : un lot obsolète
        // pourrait chevaucher le lot suivant (doublon) après un ajout.
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (e) {
    if (e instanceof InvalidCursorError) {
      return NextResponse.json({ error: 'INVALID_CURSOR' }, { status: 400 });
    }
    console.error('[documents/feed]', JSON.stringify({
      phase,
      ms: Math.round(performance.now() - started),
      error: e instanceof Error ? e.name : 'Error',
    }));
    return NextResponse.json({ error: 'DOCUMENTS_UNAVAILABLE' }, { status: 500 });
  }
}
