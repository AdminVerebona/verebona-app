/**
 * GET /api/admin/ai/t1-completeness/[fileId] — lot 113AN (Trello #741).
 *
 * Rapport de complétude T1 d'UN document, unité par unité : totaux
 * (couvertes, non informatives, incertaines, non résolues, échouées,
 * requalifiées), réparation ciblée de couverture (passes, appels, unités
 * ciblées / résolues, motif d'absence), réconciliation (règles), politiques
 * des unités restantes, et la liste des unités non couvertes ou requalifiées
 * (`?all=1` : toutes). AUCUN contenu de document (identifiants, états,
 * motifs, provenance technique, nombre de valeurs par nature).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext, toErrorResponse } from '../../config-versions/_shared';

export async function GET(req: NextRequest, { params }: { params: Promise<{ fileId: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const { fileId: raw } = await params;
  const fileId = Number(raw);
  if (!Number.isSafeInteger(fileId) || fileId <= 0) return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });
  try {
    const { loadCompletenessDetail } = await import('@/services/ai/source-analysis/source-units/completeness-detail');
    const detail = await loadCompletenessDetail(fileId, { all: new URL(req.url).searchParams.get('all') === '1' });
    if (!detail) return NextResponse.json({ error: 'NOT_FOUND', message: 'Aucune couverture T1 pour ce document.' }, { status: 404 });
    return NextResponse.json(detail);
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/t1-completeness/[fileId]');
  }
}
