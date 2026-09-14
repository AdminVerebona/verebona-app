/**
 * GET /api/v2/documents — documents regroupés par Rubrique (CDC V2.0 §4, §13.5).
 *
 * Une seule route pour les deux écrans : sans `?assets=`, c'est « Mes
 * documents » ; avec, c'est l'onglet « Documents » d'un bien. Le §4.1 exige ce
 * contrat commun, et deux routes auraient fini par calculer deux compteurs
 * différents pour la même chose.
 *
 *   ?assets=12,45           restreint au périmètre d'un ou plusieurs biens
 *   ?types=DPE,WORKS_QUOTE  filtre par Type (§4.6)
 *   ?sort=uploadedAt|documentDate|title  &  ?direction=asc|desc
 *   ?offsets=MEDIA:6,OTHER_DOCUMENTS:12  décalage par groupe, pour « Voir les N autres »
 *   ?pageSize=6             aperçu par Rubrique avant repli
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import {
  getDocumentsByRubric,
  type DocumentSort,
  type SortDirection,
} from '@/services/documents/rubric-query.service';

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

  const p = req.nextUrl.searchParams;
  const assetIds = (p.get('assets') ?? '')
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isInteger(v) && v > 0);
  const typeCodes = (p.get('types') ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  const pageSize = Math.min(Math.max(Number(p.get('pageSize')) || 6, 1), 50);

  const sortParam = p.get('sort');
  const sort: DocumentSort =
    sortParam === 'documentDate' || sortParam === 'title' ? sortParam : 'uploadedAt';
  const direction: SortDirection = p.get('direction') === 'asc' ? 'asc' : 'desc';

  // `CODE:12,AUTRE:6` — un décalage par groupe. Les valeurs non numériques
  // sont ignorées plutôt que rejetées : un décalage illisible doit rendre la
  // première page, pas une erreur.
  const offsets: Record<string, number> = {};
  for (const pair of (p.get('offsets') ?? '').split(',')) {
    const [code, raw] = pair.split(':');
    const value = Number(raw);
    if (code && Number.isInteger(value) && value > 0) offsets[code.trim()] = value;
  }

  const page = await getDocumentsByRubric({
    accountId,
    assetIds,
    typeCodes: typeCodes.length > 0 ? typeCodes : undefined,
    pageSize,
    sort,
    direction,
    offsets,
  });

  return NextResponse.json(page, {
    headers: { 'Cache-Control': 'private, max-age=15, stale-while-revalidate=60' },
  });
}
