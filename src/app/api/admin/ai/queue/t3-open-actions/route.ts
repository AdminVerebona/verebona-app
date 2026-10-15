/**
 * GET /api/admin/ai/queue/t3-open-actions — lot 57B (ticket P0 « T3 —
 * Corriger les À traiter non résolus et fiabiliser les logs », §3, §4).
 *
 * Diagnostic des « À traiter » par exécution T3 globale et par carte, sans
 * SQL : phases, compteurs distincts, appels IA par opération, parcours de
 * chaque carte. Filtres : accountId, jobId, runId, documentId, ruleCode,
 * actionId, result (effet ou motif), before (pagination), limit.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getT3OpenActionsDiagnostic } from '@/services/ai/queue/t3-open-actions-diagnostic';
import { requireAdminContext, toErrorResponse } from '../../config-versions/_shared';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    const q = req.nextUrl.searchParams;
    const n = (k: string) => (q.get(k) ? Number(q.get(k)) : null);
    return NextResponse.json(await getT3OpenActionsDiagnostic({
      accountId: n('accountId'), jobId: n('jobId'), runId: n('runId'), documentId: n('documentId'),
      ruleCode: q.get('ruleCode'), actionId: n('actionId'), result: q.get('result'), before: n('before'), limit: n('limit') ?? undefined,
    }));
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/queue/t3-open-actions');
  }
}
