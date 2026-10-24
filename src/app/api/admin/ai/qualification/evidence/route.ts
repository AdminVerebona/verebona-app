/**
 * GET /api/admin/ai/qualification/evidence — lot 86A (CDC Pilotage IA V2 P5 :
 * QUAL-01, VER-03). Preuves historisées par couple avec leur état courant
 * (`listQualificationEvidence`, même lecture que le fichier global 86B).
 * Filtres : operationCode, model, rank, campaignId, verdict, latest=1, limit.
 * Administrateurs existants (décision 15). Lecture seule.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext, toErrorResponse } from '../../config-versions/_shared';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    const sp = req.nextUrl.searchParams;
    const int = (k: string) => (sp.get(k) && /^\d+$/.test(sp.get(k)!) ? Number(sp.get(k)) : undefined);
    const verdict = sp.get('verdict');
    const { listQualificationEvidence } = await import('@/services/ai/qualification/service');
    const items = await listQualificationEvidence({
      operationCode: sp.get('operationCode') ?? undefined, model: sp.get('model') ?? undefined, rank: int('rank'), campaignId: int('campaignId'),
      verdict: verdict === 'ADMISSIBLE' || verdict === 'REFUSED' || verdict === 'INCONCLUSIVE' ? verdict : undefined,
      latestPerCouple: sp.get('latest') === '1', limit: int('limit'),
    });
    return NextResponse.json({ items }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/qualification/evidence');
  }
}
