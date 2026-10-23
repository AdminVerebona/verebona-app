/**
 * GET /api/admin/ai/business-executions/[id] — lot 83C : une exécution
 * métier (qualification, résultat natif, cause, filiation), ses appels
 * (tentatives, réparations, replis : R56) et ses travaux / rapports.
 * Droit administrateur existant ; aucun contenu sensible (les échanges
 * capturés restent derrière `AI_MODEL_OUTPUT_ADMIN_IDS`, détail d'appel).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext, toErrorResponse } from '../../config-versions/_shared';
import { parseExecutionId } from '@/services/ai/business-execution/identity';
import { callsOfExecutions, getBusinessExecution } from '@/services/ai/business-execution/repository';
import { toExecutionDto } from '@/services/ai/business-execution/dto';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const { id: raw } = await params;
  const id = decodeURIComponent(raw);
  if (!parseExecutionId(id)) {
    return NextResponse.json({ error: 'INVALID_EXECUTION_ID', message: `Identifiant d’exécution illisible : « ${id.slice(0, 80)} ».` }, { status: 400 });
  }
  try {
    const now = new Date();
    const x = await getBusinessExecution(id, now);
    if (!x) {
      return NextResponse.json({
        error: 'NOT_FOUND',
        message: 'Exécution introuvable ou non déterminable (état natif absent, ou remplacé par une demande plus récente).',
      }, { status: 404 });
    }
    const calls = (await callsOfExecutions([x])).get(x.id) ?? null;
    return NextResponse.json({ readAt: now.toISOString(), execution: toExecutionDto(x, calls) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/business-executions/[id]');
  }
}
