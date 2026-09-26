import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { getSupervisionCounters, listAnomalies } from '@/services/admin/anomaly.service';

/**
 * GET /api/admin/anomalies?status=open|resolved&sort=date|detected|domain|account|user&dir=asc|desc&page=N
 *
 * Supervision — CDC Back-Office V1 §4.5.
 *  - `open` (défaut) : anomalies ouvertes (SUP-005) + compteurs (SUP-001/002) ;
 *  - `resolved` : historique des anomalies résolues (SUP-H01).
 * Pagination classique et tri uniquement : aucun paramètre de recherche ni de
 * filtre (domaine, période, manuel/automatique) n'est accepté (SUP-005,
 * SUP-H02, REC-DASH-07).
 */
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
    const params = request.nextUrl.searchParams;
    const status = params.get('status') === 'resolved' ? 'resolved' : 'open';
    const list = await listAnomalies({
      status,
      sort: params.get('sort'),
      dir: params.get('dir'),
      page: Number(params.get('page') ?? 1),
    });
    const counters = status === 'open' ? await getSupervisionCounters() : null;
    return NextResponse.json({ status, ...list, counters });
  } catch (error) {
    if (isSessionError(error)) return sessionErrorResponse(error);
    console.error('[admin/anomalies] erreur :', error);
    return NextResponse.json(
      { error: 'Chargement des anomalies impossible', message: (error as Error).message, code: 'ANOMALIES_LOAD_FAILED' },
      { status: 500 },
    );
  }
}
