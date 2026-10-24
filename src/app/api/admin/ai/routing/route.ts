/**
 * /api/admin/ai/routing — lot 86B (OPT-03, VER-08, ACT-04) : état de routage
 * subordonné à la configuration.
 *
 * GET  : par opération modèle, chaîne configurée, chaîne exécutée (après
 *        exclusions et promotion), promotion active, preuves du dernier
 *        import ; historique des promotions.
 * POST : `{ operationCode, model, justification }` — promotion MANUELLE
 *        (origine administrateur) d'un modèle de la chaîne configurée en
 *        tête pour cette opération. Réversible (`/promotions/[id]/revert`),
 *        remise à zéro par le prochain import complet.
 */
import { NextRequest, NextResponse } from 'next/server';
import { listPromotionHistory, promote, routingView } from '@/services/ai/config/routing-state.service';
import { getAiEnvironment } from '@/services/ai/config/environment';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    const environment = getAiEnvironment();
    const [view, history] = await Promise.all([routingView(environment), listPromotionHistory(environment, 50)]);
    return NextResponse.json({ environment, ...view, history });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/routing');
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    const b = (await req.json().catch(() => ({}))) as { operationCode?: unknown; model?: unknown; justification?: unknown };
    const p = await promote({
      operationCode: typeof b.operationCode === 'string' ? b.operationCode : '',
      model: typeof b.model === 'string' ? b.model : '',
      justification: typeof b.justification === 'string' ? b.justification : '',
      origin: 'admin',
    }, guard.ctx.adminUserId);
    return NextResponse.json({ promotion: p }, { status: 201 });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/routing');
  }
}
