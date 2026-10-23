/**
 * GET /api/admin/ai/business-executions/[id] — lots 83C, 84D (CDC Pilotage IA
 * V2 P2–P3 : BO-03, BO-08, BO-10, LOG-07).
 *
 * Une exécution métier : qualification, résultat natif, ce qui manque, cause
 * établie ou inconnue, filiation ; TOUS ses appels (tentatives, réparations,
 * replis — quel que soit le modèle) avec l'état de capture de chaque échange ;
 * ses travaux de file et ses rapports (écritures constatées) ; la relance
 * EXISTANTE applicable. Droit administrateur existant ; aucun contenu
 * sensible ici (les échanges capturés restent derrière
 * `AI_MODEL_OUTPUT_ADMIN_IDS`, route de détail d'appel). Consultation
 * journalisée (acteur, date, exécution consultée).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext, toErrorResponse } from '../../config-versions/_shared';
import { parseExecutionId } from '@/services/ai/business-execution/identity';
import { readBusinessExecutionDetail } from '@/services/ai/business-execution/detail';
import { isModelOutputAccessAllowed } from '@/services/ai/telemetry/model-output-access';
import { logAdminAction } from '@/lib/admin-audit';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const { id: raw } = await params;
  const id = decodeURIComponent(raw);
  if (!parseExecutionId(id)) {
    return NextResponse.json({ error: 'INVALID_EXECUTION_ID', message: `Identifiant d’exécution illisible : « ${id.slice(0, 80)} ».` }, { status: 400 });
  }
  try {
    const d = await readBusinessExecutionDetail(id, { canReadContents: isModelOutputAccessAllowed(guard.ctx.adminUserId) });
    await logAdminAction({
      adminId: guard.ctx.adminUserId, action: 'AI_BUSINESS_EXECUTION_READ', targetType: 'AI_EXECUTION', targetId: null,
      result: d ? 'SUCCESS' : 'FAILURE', details: { executionId: id, ...(d ? { outcome: d.execution.outcome, calls: d.calls.length } : { code: 'NOT_FOUND' }) },
    });
    if (!d) {
      return NextResponse.json({
        error: 'NOT_FOUND',
        message: 'Exécution introuvable ou non déterminable (état natif absent, ou remplacé par une demande plus récente).',
      }, { status: 404 });
    }
    return NextResponse.json(d, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/business-executions/[id]');
  }
}
