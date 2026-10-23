/**
 * GET /api/admin/ai/executions/[id] — CDC BO IA LOG-UI-04, SCR-07, NFR-004.
 *
 * Détail d'une exécution à partir d'un de ses appels (`ai_usage_event.id`) :
 * appels de la même trace (principal, replis), étapes de pipeline, job de file
 * parent et version appliquée. Le prompt n'est pas dupliqué : il est référencé
 * par sa version (SCR-07).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getExecutionDetail } from '@/services/ai/telemetry/execution-log.repository';
import { requireAdminContext, toErrorResponse } from '../../config-versions/_shared';
import { businessExecutionIdsOfCall, getBusinessExecution } from '@/services/ai/business-execution/repository';
import { toExecutionDto, type BusinessExecutionDto } from '@/services/ai/business-execution/dto';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  if (!/^\d+$/.test(id)) return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });
  try {
    const detail = await getExecutionDetail(Number(id));
    if (!detail) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    return NextResponse.json({ ...detail, businessExecutions: await businessExecutionsOf(Number(id)) });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/executions/[id]');
  }
}

/**
 * Lot 83C (SEM-05) : exécution(s) MÉTIER de l'appel — l'issue métier finale
 * est distincte du statut de l'appel (un repli réussi après un principal en
 * échec est une réussite métier). Lecture tolérante : jamais bloquante.
 */
async function businessExecutionsOf(usageEventId: number): Promise<BusinessExecutionDto[] | null> {
  try {
    const ids = await businessExecutionIdsOfCall(usageEventId);
    if (ids.length === 0) return null;
    const now = new Date();
    const out: BusinessExecutionDto[] = [];
    for (const x of ids.slice(0, 20)) {
      const e = await getBusinessExecution(x, now);
      if (e) out.push(toExecutionDto(e, null));
    }
    return out;
  } catch (e) {
    console.error('[executions/[id]] exécution métier illisible (non bloquant) :', (e as Error).message);
    return null;
  }
}
