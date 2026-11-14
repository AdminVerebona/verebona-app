/**
 * GET /api/admin/ai/t1-completeness/reassessment — lot 114H (Trello #775, P1-C).
 *
 * BILAN cumulé de la réévaluation automatique de la couverture T1 du stock
 * (tâche planifiée `t1-coverage-reassessment`, sans appel IA) pour la version
 * courante des règles : documents examinés par issue, changements d'état
 * « avant → après », unités requalifiées, alertes de Supervision closes /
 * maintenues / ouvertes, reprises programmées ou retirées, erreurs, documents
 * restant à examiner, durée cumulée, appels et coût IA (0 par construction).
 * Lecture seule ; compteurs seulement, jamais le contenu d'un document.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext, toErrorResponse } from '../../config-versions/_shared';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    const { getCoverageReassessmentReport } = await import('@/services/ai/source-analysis/source-units/historical-reassessment');
    return NextResponse.json(await getCoverageReassessmentReport());
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/t1-completeness/reassessment');
  }
}
