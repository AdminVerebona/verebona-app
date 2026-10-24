/**
 * /api/admin/ai/config-interventions — lot 86B (ACT-03, DEC-03, R55) :
 * exclusions de modèles et gels de configuration manuels.
 *
 * GET  : interventions actives et historique.
 * POST : `{ kind: 'EXCLUSION', model, treatment?, reason }` ou
 *        `{ kind: 'FREEZE', treatment?, reason }` (portée globale si
 *        `treatment` absent). Idempotent (même portée active : rendue telle
 *        quelle, 200). Exclusion qui viderait une chaîne : 409.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createExclusion, createFreeze, listActiveInterventions, listInterventionHistory } from '@/services/ai/config/config-interventions.service';
import { getAiEnvironment } from '@/services/ai/config/environment';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    const environment = getAiEnvironment();
    const [active, history] = await Promise.all([listActiveInterventions(environment), listInterventionHistory(environment, 50)]);
    return NextResponse.json({ environment, active, history });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/config-interventions');
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    const b = (await req.json().catch(() => ({}))) as { kind?: unknown; model?: unknown; treatment?: unknown; reason?: unknown };
    const treatment = typeof b.treatment === 'string' && b.treatment ? b.treatment : null;
    const reason = typeof b.reason === 'string' ? b.reason : '';
    const r = b.kind === 'EXCLUSION'
      ? await createExclusion({ model: typeof b.model === 'string' ? b.model : '', treatment, reason }, guard.ctx.adminUserId)
      : b.kind === 'FREEZE'
        ? await createFreeze({ treatment, reason }, guard.ctx.adminUserId)
        : null;
    if (!r) return NextResponse.json({ error: 'INTERVENTION_INVALID', message: 'Type d’intervention attendu : EXCLUSION ou FREEZE.' }, { status: 400 });
    return NextResponse.json(r, { status: r.created ? 201 : 200 });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/config-interventions');
  }
}
