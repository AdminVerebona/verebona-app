/**
 * /api/admin/ai/promotion — lot 105B (ticket P1 « IA auto-amélioration »,
 * §5) : état RÉEL de la promotion automatique IA, en lecture seule (même
 * service que la note des tâches planifiées et le diagnostic global) —
 * planificateur, tests réellement exécutés, couverture A1, blocages,
 * candidates, surveillance post-activation, journal, P2 différé.
 * Droits : administrateurs existants. Aucune action ici : la promotion reste
 * automatique en préproduction et manuelle (export / import) en production.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';

export const dynamic = 'force-dynamic';

/**
 * Lot 113I (CDC V2 BO-08, UI-002, API-03/04, APIX-001) — gestes administratifs manquants, sur les services existants :
 *   · `suspend-objective` { objectiveId, expectedStatus, reason } : aucune nouvelle dépense pour l'objectif, la
 *     configuration active n'est PAS modifiée ;
 *   · `reconcile-reservation` { reservationId, costMicros?, currency?, resolveUnderestimation?, reason } : rapprochement
 *     d'un coût inconnu (facture) ou levée motivée d'une anomalie de sous-estimation (historisé).
 * Codes stables, jamais un 200 portant une erreur.
 */
export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.action !== 'string') return NextResponse.json({ error: 'INVALID_BODY' }, { status: 400 });
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < 3) return NextResponse.json({ error: 'REASON_REQUIRED', message: 'Motif obligatoire (audit).' }, { status: 400 });
  try {
    const { recordConfigAudit } = await import('@/services/ai/config/config-entry.audit');
    if (body.action === 'suspend-objective') {
      const { suspendObjective, OBJECTIVE_STATUSES } = await import('@/services/ai/qualification/improvement-objectives');
      const id = Number(body.objectiveId);
      const expected = String(body.expectedStatus ?? '');
      if (!Number.isInteger(id) || !(OBJECTIVE_STATUSES as readonly string[]).includes(expected)) return NextResponse.json({ error: 'INVALID_BODY' }, { status: 400 });
      const r = await suspendObjective({ id, expectedStatus: expected as never, userId: guard.ctx.adminUserId, reason });
      if (!r.ok) return NextResponse.json({ error: 'OBJECTIVE_TRANSITION_REFUSED', message: r.message, current: r.current }, { status: 409 });
      await recordConfigAudit('ai_improvement_objective_suspend', guard.ctx.adminUserId, { objectiveId: id, status: expected }, { status: r.objective.status, reason: reason.slice(0, 300) }).catch(() => undefined);
      return NextResponse.json({ objective: r.objective });
    }
    if (body.action === 'reconcile-reservation') {
      const { adminReconcile } = await import('@/services/ai/qualification/improvement-budget');
      const id = Number(body.reservationId);
      const cost = body.costMicros == null ? null : Number(body.costMicros);
      if (!Number.isInteger(id) || (cost != null && (!Number.isFinite(cost) || cost < 0))) return NextResponse.json({ error: 'INVALID_BODY' }, { status: 400 });
      await adminReconcile({ reservationId: id, costMicros: cost, currency: typeof body.currency === 'string' ? body.currency : undefined, resolveUnderestimation: body.resolveUnderestimation === true, userId: guard.ctx.adminUserId, note: reason });
      await recordConfigAudit('ai_improvement_reservation_reconcile', guard.ctx.adminUserId, { reservationId: id }, { costMicros: cost, resolveUnderestimation: body.resolveUnderestimation === true, reason: reason.slice(0, 300) }).catch(() => undefined);
      return NextResponse.json({ reconciled: true });
    }
    return NextResponse.json({ error: 'UNKNOWN_ACTION' }, { status: 400 });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/promotion');
  }
}

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    const { promotionStatus } = await import('@/services/ai/qualification/promotion-status');
    return NextResponse.json(await promotionStatus(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/promotion');
  }
}
