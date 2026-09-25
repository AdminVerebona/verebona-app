/**
 * POST /api/admin/ai/treatments — CDC BO IA §4.2, WF-07, SCR-02.
 *
 * Active ou désactive un traitement. Commande OPÉRATIONNELLE, non versionnée :
 * elle ne figure dans aucune version, n'entre dans aucun package, et un
 * rollback de configuration ne doit jamais rallumer ce que quelqu'un a coupé.
 *
 * §4.2 : à la désactivation, les nouveaux jobs restent en file et aucune
 * exécution ne démarre. Les exécutions en cours reviennent en tête pour
 * reprendre depuis le début à la réactivation.
 */
import { NextRequest, NextResponse } from 'next/server';
import { setTreatmentState, getTreatmentStates } from '@/services/ai/queue/job-queue.repository';
import { isTreatment } from '@/services/ai/config/treatments';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    return NextResponse.json({ states: await getTreatmentStates() });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/treatments');
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const body = await req.json().catch(() => ({}));
  const treatment = typeof body.treatment === 'string' ? body.treatment : '';
  const enabled = body.enabled;

  if (!isTreatment(treatment) || typeof enabled !== 'boolean') {
    return NextResponse.json(
      { error: 'INVALID_PAYLOAD', message: 'Indiquez `treatment` (T1 à T6) et `enabled`.' },
      { status: 400 },
    );
  }

  try {
    await setTreatmentState(
      treatment,
      enabled ? 'ENABLED' : 'DISABLED',
      guard.ctx.adminUserId,
      typeof body.reason === 'string' ? body.reason.slice(0, 500) : undefined,
    );
    return NextResponse.json({ states: await getTreatmentStates() });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/treatments');
  }
}
