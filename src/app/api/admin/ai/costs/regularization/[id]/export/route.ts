/**
 * GET /api/admin/ai/costs/regularization/[id]/export — lot 109L : export CSV
 * AVANT / APRÈS d'une simulation (ou de l'application qui en découle) :
 * une ligne par appel / agrégat, coût initial, statut, cause, décision, raison,
 * tarif appliqué (ligne, source, référence), coût corrigé, correction.
 */
import { NextRequest, NextResponse } from 'next/server';
import { regularizationExport } from '@/services/ai/telemetry/cost-regularization';
import { requireAdminContext, toErrorResponse } from '../../../../config-versions/_shared';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const { id } = await ctx.params;
  if (!/^\d{1,12}$/.test(id)) return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });
  try {
    const csv = await regularizationExport(Number(id));
    if (csv === null) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    return new NextResponse(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store',
        'content-disposition': `attachment; filename="regularisation-couts-ia-${id}.csv"`,
      },
    });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/costs/regularization/[id]/export');
  }
}
