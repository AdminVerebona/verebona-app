/**
 * GET /api/admin/ai/treatments/[treatment]/metrics — CDC BO IA SCR-02 à SCR-06.
 *
 * Indicateurs de supervision d'un traitement, sur une fenêtre glissante.
 *
 * ── UN INDICATEUR NON MESURÉ N'EST PAS UN ZÉRO ─────────────────────────────
 * Les indicateurs que l'application n'instrumente pas encore rendent `null`
 * avec la raison. Rendre zéro serait lu comme une absence de problème, ce qui
 * est exactement le contraire de ce qu'on sait.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getTreatmentMetrics } from '@/services/ai/config/treatment-metrics.repository';
import { isTreatment } from '@/services/ai/config/treatments';
import { requireAdminContext, toErrorResponse } from '../../../config-versions/_shared';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ treatment: string }> },
) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const { treatment } = await params;
  if (!isTreatment(treatment)) {
    return NextResponse.json(
      { error: 'UNKNOWN_TREATMENT', message: `Traitement inconnu : « ${treatment} ».` },
      { status: 400 },
    );
  }

  const raw = new URL(req.url).searchParams.get('days');
  const days = raw && /^\d+$/.test(raw) ? Number(raw) : 30;

  try {
    return NextResponse.json(await getTreatmentMetrics(treatment, days));
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/treatments/[treatment]/metrics');
  }
}
