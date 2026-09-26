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

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  if (!/^\d+$/.test(id)) return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });
  try {
    const detail = await getExecutionDetail(Number(id));
    if (!detail) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    return NextResponse.json(detail);
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/executions/[id]');
  }
}
