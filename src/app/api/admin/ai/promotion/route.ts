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
