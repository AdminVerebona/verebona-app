/**
 * GET /api/admin/ai/t1-completeness — lot 34F (ticket T1 « Monitoring »).
 *
 * Complétude des analyses T1 de la période : documents par état de qualité
 * (COMPLETE, COMPLETE_WITH_UNRESOLVED, INCOMPLETE_RETRYABLE,
 * INCOMPLETE_FINAL), par anomalie fonctionnelle (FACTS_TRUNCATED,
 * PARTIAL_EXTRACTION, FACT_INVALID_DROPPED, SOURCE_UNIT_FAILED,
 * COVERAGE_INCOMPLETE), et la liste des documents concernés — compteurs
 * seulement, jamais le contenu des documents. Affiché dans BO › Exécutions IA.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getT1CompletenessOverview } from '@/services/ai/source-analysis/source-units/monitoring';
import { T1_COMPLETENESS_ANOMALIES } from '@/services/ai/source-analysis/source-units/types';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const q = new URL(req.url).searchParams;
  const raw = q.get('days');
  const days = raw && /^\d+$/.test(raw) ? Math.min(Number(raw), 90) : 7;
  const a = q.get('anomaly');
  const anomaly = a && (T1_COMPLETENESS_ANOMALIES as readonly string[]).includes(a) ? a : null;

  try {
    return NextResponse.json(await getT1CompletenessOverview({ days, anomaly, limit: 50 }));
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/t1-completeness');
  }
}
